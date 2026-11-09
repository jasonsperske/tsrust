/**
 * # The borrow checker proper
 *
 * Given a MIR {@link Body}, we run three **dataflow analyses** — each computes
 * a fact for every program point by propagating along CFG edges until
 * nothing changes (a *fixed point*), which handles loops naturally:
 *
 * | Analysis   | Direction | Fact at each point                                   |
 * |------------|-----------|------------------------------------------------------|
 * | init/moves | forward   | which places are *maybe moved* or *maybe uninitialized* |
 * | holds      | forward   | which loans each local may be carrying               |
 * | liveness   | backward  | which locals may still be used later                 |
 *
 * Combining the last two gives **non-lexical lifetimes (NLL)**: a loan is
 * *live* at a point only if some local that holds it will be used later.
 *
 * ```rust
 * let r = &v;        // loan L0 on `v`; r holds {L0}
 * println!("{r:?}"); // last use of r
 * v.push(1);         // r is dead here, so L0 is not live: OK!
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   A["for each statement S"] --> B["live loans =<br/>⋃ holds(l) for l live after S"]
 *   B --> C{"does S access a place<br/>overlapping a live loan<br/>in a conflicting way?"}
 *   C -- "shared vs mut / mut vs any" --> E["E0499 / E0502 / E0503<br/>E0505 / E0506"]
 *   C -- no --> OK[ok]
 * ```
 *
 * The access rules are the heart of Rust's aliasing discipline (many readers
 * XOR one writer):
 *
 * | Access at S           | conflicts with live loan if...      | Error |
 * |-----------------------|-------------------------------------|-------|
 * | read / shared borrow  | the loan is mutable                 | E0502/E0503 |
 * | mutable borrow        | any loan                            | E0499/E0502 |
 * | move out              | any loan                            | E0505 |
 * | assignment            | any loan                            | E0506 |
 * | scope end (`dead x`)  | any loan of `x` itself              | E0597 |
 * | `return`              | the result holds a loan of a local  | E0515 |
 *
 * Two places *overlap* when one is a prefix of the other: `s` and `s.a`
 * overlap, but `s.a` and `s.b` don't — that's why you can borrow two
 * different fields of a struct mutably at the same time.
 */
import type { Diagnostics, Span } from "../diagnostics.ts";
import type { Ty } from "../typeck/types.ts";
import type { Body, Local, Operand, Place, Rvalue, Statement } from "./mir.ts";

type Access =
  | { kind: "read" | "inspect" | "move" | "write"; place: Place; span: Span }
  | { kind: "borrow"; mutable: boolean; place: Place; span: Span; loan: number };

interface InitState {
  moved: Map<string, Span>;
  uninit: Set<string>;
  /** Locals that are *maybe* initialized (assigning an immutable one again is E0384). */
  init: Set<string>;
}

type Holds = Map<Local, Set<number>>;

export interface BorrowckHelpers {
  showTy: (t: Ty) => string;
  mayHoldRefs: (t: Ty) => boolean;
  borrowOf: Map<Local, Place>;
}

export class BodyChecker {
  private readonly preds: number[][];
  private readonly reachable: number[];
  private readonly reported = new Set<string>();
  private readonly body: Body;
  private readonly diags: Diagnostics;
  private readonly h: BorrowckHelpers;

  constructor(body: Body, diags: Diagnostics, helpers: BorrowckHelpers) {
    this.body = body;
    this.diags = diags;
    this.h = helpers;
    this.preds = body.blocks.map(() => []);
    const seen = new Set<number>();
    const order: number[] = [];
    const stack = [0];
    while (stack.length) {
      const b = stack.pop()!;
      if (seen.has(b)) continue;
      seen.add(b);
      order.push(b);
      for (const s of this.succs(b)) {
        this.preds[s].push(b);
        stack.push(s);
      }
    }
    this.reachable = order.sort((a, b) => a - b);
  }

  private succs(b: number): number[] {
    const t = this.body.blocks[b].term;
    if (t.k === "goto") return [t.target];
    if (t.k === "switch") return t.targets;
    return [];
  }

  // =========================================================================
  // Run everything
  // =========================================================================

  check() {
    const initIn = this.forward<InitState>(
      () => ({
        moved: new Map(),
        uninit: new Set(this.body.locals.map((_, i) => String(i)).filter((_, i) => i === 0 || i > this.body.argCount)),
        init: new Set(this.body.locals.map((_, i) => String(i)).filter((_, i) => i > 0 && i <= this.body.argCount)),
      }),
      () => ({ moved: new Map(), uninit: new Set(), init: new Set() }),
      (a, b) => {
        const moved = new Map(a.moved);
        for (const [k, v] of b.moved) if (!moved.has(k)) moved.set(k, v);
        return { moved, uninit: new Set([...a.uninit, ...b.uninit]), init: new Set([...a.init, ...b.init]) };
      },
      (s, st) => this.initTransfer(s, st),
      (a, b) => a.moved.size === b.moved.size && a.uninit.size === b.uninit.size && [...a.moved.keys()].every((k) => b.moved.has(k)) && [...a.uninit].every((k) => b.uninit.has(k)) && a.init.size === b.init.size,
      (st) => ({ moved: new Map(st.moved), uninit: new Set(st.uninit), init: new Set(st.init) }),
    );
    const holdsIn = this.forward<Holds>(
      () => new Map(),
      () => new Map(),
      (a, b) => {
        const out: Holds = new Map();
        for (const [l, s] of a) out.set(l, new Set(s));
        for (const [l, s] of b) out.set(l, new Set([...(out.get(l) ?? []), ...s]));
        return out;
      },
      (s, st) => this.holdsTransfer(s, st),
      (a, b) => a.size === b.size && [...a].every(([l, s]) => b.get(l)?.size === s.size),
      (st) => new Map([...st].map(([l, s]) => [l, new Set(s)])),
    );
    const liveOut = this.liveness();

    for (const b of this.reachable) {
      const block = this.body.blocks[b];
      let init = initIn.get(b)!;
      let holds = holdsIn.get(b)!;
      // Per-statement live-after sets, computed backwards from the block's live-out.
      const liveAfter: Set<Local>[] = new Array(block.stmts.length + 1);
      let live = new Set(liveOut.get(b)!);
      if (block.term.k === "return") live.add(0);
      liveAfter[block.stmts.length] = new Set(live);
      for (let i = block.stmts.length - 1; i >= 0; i--) {
        liveAfter[i] = new Set(live);
        live = this.liveTransfer(block.stmts[i], live);
      }
      block.stmts.forEach((s, i) => {
        this.checkStatement(s, init, holds, liveAfter[i], { block: b, index: i });
        init = this.initTransfer(s, { moved: new Map(init.moved), uninit: new Set(init.uninit), init: new Set(init.init) });
        holds = this.holdsTransfer(s, new Map([...holds].map(([l, x]) => [l, new Set(x)])));
      });
      if (block.term.k === "return") this.checkReturn(holds, block.term.span);
    }
  }

  // =========================================================================
  // Generic forward dataflow
  // =========================================================================

  private forward<S>(entry: () => S, bottom: () => S, join: (a: S, b: S) => S, transfer: (s: Statement, st: S) => S, eq: (a: S, b: S) => boolean, clone: (s: S) => S): Map<number, S> {
    const inStates = new Map<number, S>();
    const outStates = new Map<number, S>();
    const work = [...this.reachable];
    const queued = new Set(work);
    while (work.length) {
      const b = work.shift()!;
      queued.delete(b);
      let st: S = b === 0 ? entry() : bottom();
      if (b === 0) {
        // Entry block can also be a loop target.
        for (const p of this.preds[b]) if (outStates.has(p)) st = join(st, outStates.get(p)!);
      } else {
        let first = true;
        for (const p of this.preds[b]) {
          if (!outStates.has(p)) continue;
          st = first ? clone(outStates.get(p)!) : join(st, outStates.get(p)!);
          first = false;
        }
      }
      inStates.set(b, clone(st));
      for (const s of this.body.blocks[b].stmts) st = transfer(s, st);
      const prev = outStates.get(b);
      if (!prev || !eq(prev, st)) {
        outStates.set(b, st);
        for (const s of this.succs(b)) if (!queued.has(s)) { queued.add(s); work.push(s); }
      }
    }
    for (const b of this.reachable) if (!inStates.has(b)) inStates.set(b, bottom());
    return inStates;
  }

  // =========================================================================
  // Move paths and initialization
  // =========================================================================

  /** Keys of the place's prefixes that are move paths (`3`, `3.f0`, `3.f0.f2`), stopping at derefs of references and indexing. */
  private pathKeys(p: Place): { keys: string[]; complete: boolean } {
    const keys = [String(p.local)];
    let k = String(p.local);
    for (const pr of p.proj) {
      if (pr.k === "field") k += pr.variant !== undefined ? `.v${pr.variant}f${pr.index}` : `.f${pr.index}`;
      else if (pr.k === "deref" && pr.via === "box") k += ".*";
      else return { keys, complete: false };
      keys.push(k);
    }
    return { keys, complete: true };
  }

  private initTransfer(s: Statement, st: InitState): InitState {
    if (s.k === "dead") {
      st.uninit.add(String(s.local));
      st.init.delete(String(s.local));
      for (const k of [...st.moved.keys()]) if (k === String(s.local) || k.startsWith(`${s.local}.`)) st.moved.delete(k);
      return st;
    }
    if (s.k === "assign") {
      for (const op of rvOperands(s.rv)) {
        if (op.k === "move") {
          const { keys, complete } = this.pathKeys(op.place);
          if (complete && !st.moved.has(keys[keys.length - 1])) st.moved.set(keys[keys.length - 1], s.span);
        }
      }
      const { keys, complete } = this.pathKeys(s.dest);
      if (complete) {
        const k = keys[keys.length - 1];
        for (const m of [...st.moved.keys()]) if (m === k || m.startsWith(k + ".")) st.moved.delete(m);
        st.uninit.delete(k);
        st.init.add(keys[0]);
      }
    }
    return st;
  }

  // =========================================================================
  // Loans held by locals
  // =========================================================================

  private loansOfOp(op: Operand, st: Holds): Set<number> {
    if (op.k === "const" || !op.refs) return new Set();
    return new Set(st.get(op.place.local) ?? []);
  }

  private loansOfRv(rv: Rvalue, st: Holds, destTy: Ty): Set<number> {
    switch (rv.k) {
      case "use": return this.loansOfOp(rv.op, st);
      case "ref": {
        const out = new Set([rv.loan]);
        // A reborrow through a reference keeps the original loan alive too.
        if (rv.place.proj.some((p) => p.k === "deref")) for (const l of st.get(rv.place.local) ?? []) out.add(l);
        return out;
      }
      case "aggregate": {
        const out = new Set<number>();
        for (const op of rv.ops) for (const l of this.loansOfOp(op, st)) out.add(l);
        return out;
      }
      case "call": {
        const out = new Set<number>();
        if (!this.h.mayHoldRefs(destTy)) return out;
        rv.ops.forEach((op, i) => {
          if (op.k === "const") return;
          const flow = rv.flows[i] ?? "full";
          if (flow === "none") return;
          let src = op.place.local;
          if (flow === "inner") {
            const borrowed = this.h.borrowOf.get(op.place.local);
            if (borrowed) src = borrowed.local;
          }
          for (const l of st.get(src) ?? []) out.add(l);
        });
        return out;
      }
      case "pure": return new Set();
    }
  }

  private holdsTransfer(s: Statement, st: Holds): Holds {
    if (s.k === "dead") { st.delete(s.local); return st; }
    if (s.k !== "assign") return st;
    const loans = this.loansOfRv(s.rv, st, this.body.locals[s.dest.local].ty);
    if (s.dest.proj.length === 0) {
      // Overwriting a reference `x` makes data borrowed *through* `*x` unreachable
      // via `x`: those loans are killed (rustc does the same).
      const killed = (id: number) => {
        const p = this.body.loans[id].place;
        return p.local === s.dest.local && p.proj[0]?.k === "deref";
      };
      for (const [l, set] of st) for (const id of [...set]) if (killed(id)) set.delete(id);
      for (const id of [...loans]) if (killed(id)) loans.delete(id);
      st.set(s.dest.local, loans);
    }
    else if (loans.size) st.set(s.dest.local, new Set([...(st.get(s.dest.local) ?? []), ...loans]));
    return st;
  }

  // =========================================================================
  // Liveness
  // =========================================================================

  private uses(s: Statement): Local[] {
    if (s.k === "inspect") return [s.place.local];
    if (s.k === "dead") return [];
    const out: Local[] = [];
    for (const op of rvOperands(s.rv)) if (op.k !== "const") out.push(op.place.local);
    if (s.rv.k === "ref") out.push(s.rv.place.local);
    // Writing through a projection (`(*r).x = ..`) uses `r`.
    if (s.dest.proj.some((p) => p.k === "deref")) out.push(s.dest.local);
    return out;
  }

  private liveTransfer(s: Statement, live: Set<Local>): Set<Local> {
    const out = new Set(live);
    if (s.k === "assign" && s.dest.proj.length === 0) out.delete(s.dest.local);
    for (const u of this.uses(s)) out.add(u);
    return out;
  }

  /** Live-out set of each block (backward fixed point). */
  private liveness(): Map<number, Set<Local>> {
    const liveIn = new Map<number, Set<Local>>();
    const liveOut = new Map<number, Set<Local>>();
    for (const b of this.reachable) { liveIn.set(b, new Set()); liveOut.set(b, new Set()); }
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of [...this.reachable].reverse()) {
        const out = new Set<Local>();
        for (const s of this.succs(b)) for (const l of liveIn.get(s) ?? []) out.add(l);
        const block = this.body.blocks[b];
        if (block.term.k === "return") out.add(0);
        let live = new Set(out);
        for (let i = block.stmts.length - 1; i >= 0; i--) live = this.liveTransfer(block.stmts[i], live);
        if (live.size !== liveIn.get(b)!.size || out.size !== liveOut.get(b)!.size) changed = true;
        liveIn.set(b, live);
        liveOut.set(b, out);
      }
    }
    return liveOut;
  }

  // =========================================================================
  // Checking each statement
  // =========================================================================

  private accesses(s: Statement): Access[] {
    if (s.k === "inspect") return [{ kind: "inspect", place: s.place, span: s.span }];
    if (s.k === "dead") return [];
    const out: Access[] = [];
    const rv = s.rv;
    if (rv.k === "ref") out.push({ kind: "borrow", mutable: rv.mutable, place: rv.place, span: s.span, loan: rv.loan });
    else for (const op of rvOperands(rv)) if (op.k !== "const") out.push({ kind: op.k === "move" ? "move" : "read", place: op.place, span: s.span });
    out.push({ kind: "write", place: s.dest, span: s.span });
    return out;
  }

  private checkStatement(s: Statement, init: InitState, holds: Holds, liveAfter: Set<Local>, at: { block: number; index: number }) {
    // Loans that are live right after this statement.
    const active = new Map<number, Local[]>();
    for (const l of liveAfter) {
      for (const loan of holds.get(l) ?? []) {
        const list = active.get(loan) ?? [];
        list.push(l);
        active.set(loan, list);
      }
    }
    if (s.k === "dead") {
      this.checkStorageDead(s, active, at);
      return;
    }
    for (const a of this.accesses(s)) {
      if (a.kind !== "write") this.checkInit(a, init);
      if (a.kind === "move") this.checkMoveOut(a);
      if ((a.kind === "borrow" && a.mutable) || a.kind === "write") this.checkMutability(a, init);
      this.checkConflicts(a, active, at);
    }
  }

  private report(key: string, f: () => void) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    f();
  }

  /** E0381 (uninitialized) and E0382 (use after move). */
  private checkInit(a: Access, init: InitState) {
    const decl = this.body.locals[a.place.local];
    const { keys, complete } = this.pathKeys(a.place);
    if (init.uninit.has(keys[0]) && decl.kind === "user") {
      this.report(`E0381:${a.span.start}`, () => {
        const b = this.diags.error("borrowck", a.span, `used binding \`${decl.name}\` isn't initialized`, "E0381");
        b.diag.labels[0].message = `\`${decl.name}\` used here but it isn't initialized`;
        b.label(decl.span, "binding declared here but left uninitialized");
      });
      return;
    }
    const full = keys[keys.length - 1];
    for (const [k, moveSpan] of init.moved) {
      const isPrefix = keys.includes(k);
      const isPart = complete ? k.startsWith(full + ".") : false;
      if (!isPrefix && !isPart) continue;
      if (decl.kind === "temp" || decl.kind === "return") continue;
      this.report(`E0382:${a.span.start}:${k}`, () => {
        const name = this.placeName(a.place);
        const verb = a.kind === "borrow" ? "borrow" : "use";
        const msg = isPart && !isPrefix ? `${verb} of partially moved value: \`${name}\`` : `${verb} of moved value: \`${name}\``;
        const b = this.diags.error("borrowck", a.span, msg, "E0382");
        b.diag.labels[0].message = `value ${a.kind === "borrow" ? "borrowed" : "used"} here after ${isPart && !isPrefix ? "partial " : ""}move`;
        const inLoop = moveSpan.start >= a.span.start;
        if (moveSpan.start === a.span.start && moveSpan.end === a.span.end) {
          b.diag.labels[0].message = "value moved here, in previous iteration of loop";
        } else {
          b.label(moveSpan, inLoop ? "value moved here, in previous iteration of loop" : "value moved here");
        }
        b.note(`move occurs because \`${this.body.locals[a.place.local].name ?? name}\` has type \`${this.h.showTy(decl.ty)}\`, which does not implement the \`Copy\` trait`);
        if (!inLoop) b.help("consider cloning the value if the performance cost is acceptable: `.clone()`, or borrowing it with `&` instead of moving it");
      });
      return;
    }
  }

  /** E0507: moving out of a reference or out of an index. */
  private checkMoveOut(a: Access) {
    const throughRef = a.place.proj.findIndex((p) => p.k === "deref" && p.via !== "box");
    const throughIndex = a.place.proj.some((p) => p.k === "index");
    if (throughRef < 0 && !throughIndex) return;
    this.report(`E0507:${a.span.start}`, () => {
      const name = this.placeName(a.place);
      const via = throughRef >= 0 ? (a.place.proj[throughRef] as { via: string }).via : "";
      let msg: string;
      if (throughIndex && throughRef < 0) msg = `cannot move out of index of \`${this.h.showTy(this.body.locals[a.place.local].ty)}\``;
      else msg = `cannot move out of \`${name}\` which is behind a ${via === "refMut" ? "mutable" : "shared"} reference`;
      const b = this.diags.error("borrowck", a.span, msg, "E0507");
      b.diag.labels[0].message = "move occurs here, because the value does not implement the `Copy` trait";
      b.help("borrow it instead (`&`), clone it (`.clone()`), or use `std::mem::replace` / `Option::take` to swap a value in");
    });
  }

  /** E0596 / E0594 / E0384: mutating something not declared mutable. */
  private checkMutability(a: Access, init: InitState) {
    const decl = this.body.locals[a.place.local];
    const isBorrow = a.kind === "borrow";
    const sharedDeref = a.place.proj.some((p) => p.k === "deref" && p.via === "ref");
    const mutDeref = a.place.proj.some((p) => p.k === "deref" && p.via === "refMut");
    const name = this.placeName(a.place);
    if (sharedDeref) {
      this.report(`mut:${a.span.start}`, () => {
        if (isBorrow) {
          this.diags.error("borrowck", a.span, `cannot borrow \`${name}\` as mutable, as it is behind a \`&\` reference`, "E0596")
            .help("consider changing the reference to a mutable reference: `&mut`");
        } else {
          this.diags.error("borrowck", a.span, `cannot assign to \`${name}\`, which is behind a \`&\` reference`, "E0594")
            .help("consider changing the reference to a mutable reference: `&mut`");
        }
      });
      return;
    }
    if (mutDeref || decl.mutable || decl.kind === "temp" || decl.kind === "return") return;
    if (!isBorrow && a.place.proj.length === 0) {
      // Assigning a whole immutable local is fine exactly once (deferred initialization).
      // Only fine if it is *definitely* uninitialized here (not, say, assigned in an earlier loop iteration).
      if (!init.init.has(String(a.place.local))) return;
      this.report(`E0384:${a.span.start}`, () => {
        const b = this.diags.error("borrowck", a.span, `cannot assign twice to immutable variable \`${decl.name}\``, "E0384");
        b.diag.labels[0].message = "cannot assign twice to immutable variable";
        b.label(decl.span, "first assignment / declaration here").help(`consider making this binding mutable: \`mut ${decl.name}\``);
      });
      return;
    }
    this.report(`mut:${a.span.start}`, () => {
      const root = decl.name ?? "value";
      if (isBorrow) {
        this.diags.error("borrowck", a.span, `cannot borrow \`${name}\` as mutable, as ${a.place.proj.length ? `\`${root}\` is` : "it is"} not declared as mutable`, "E0596")
          .label(decl.span, `help: consider changing this to be mutable: \`mut ${root}\``);
      } else {
        this.diags.error("borrowck", a.span, `cannot assign to \`${name}\`, as \`${root}\` is not declared as mutable`, "E0594")
          .label(decl.span, `help: consider changing this to be mutable: \`mut ${root}\``);
      }
    });
  }

  /** Do two places refer to overlapping memory? */
  private overlaps(a: Place, b: Place): boolean {
    if (a.local !== b.local) return false;
    const n = Math.min(a.proj.length, b.proj.length);
    for (let i = 0; i < n; i++) {
      const x = a.proj[i], y = b.proj[i];
      if (x.k !== y.k) return true; // be conservative
      if (x.k === "field" && y.k === "field" && (x.index !== y.index || x.variant !== y.variant)) return false;
    }
    return true;
  }

  private checkConflicts(a: Access, active: Map<number, Local[]>, at: { block: number; index: number }) {
    for (const [loanId, holders] of active) {
      const loan = this.body.loans[loanId];
      if (a.kind === "borrow" && a.loan === loanId) continue;
      if (!this.overlaps(loan.place, a.place)) continue;
      // Reassigning a reference doesn't disturb data borrowed *through* it.
      if (a.kind === "write" && a.place.proj.length === 0 && loan.place.proj[0]?.k === "deref") continue;
      // Shared loans only conflict with writes, moves and mutable borrows.
      const accessMutates = a.kind === "move" || a.kind === "write" || (a.kind === "borrow" && a.mutable);
      if (!loan.mutable && !accessMutates) continue;
      const later = this.findLaterUse(at, holders);
      const name = this.placeName(a.place);
      const loanName = this.placeName(loan.place);
      this.report(`conflict:${a.span.start}:${loanId}`, () => {
        let b;
        if (a.kind === "borrow" && a.mutable && loan.mutable) {
          b = this.diags.error("borrowck", a.span, `cannot borrow \`${name}\` as mutable more than once at a time`, "E0499");
          b.diag.labels[0].message = "second mutable borrow occurs here";
          b.label(loan.span, "first mutable borrow occurs here");
          if (later) b.label(later, "first borrow later used here");
        } else if (a.kind === "borrow" || a.kind === "inspect") {
          const thisKind = a.kind === "borrow" && a.mutable ? "mutable" : "immutable";
          const otherKind = loan.mutable ? "mutable" : "immutable";
          b = this.diags.error("borrowck", a.span, `cannot borrow \`${name}\` as ${thisKind} because it is also borrowed as ${otherKind}`, "E0502");
          b.diag.labels[0].message = `${thisKind} borrow occurs here`;
          b.label(loan.span, `${otherKind} borrow occurs here${loan.implicit ? ` (implicitly, for this method call on \`${loanName}\`)` : ""}`);
          if (later) b.label(later, `${otherKind} borrow later used here`);
        } else if (a.kind === "read") {
          b = this.diags.error("borrowck", a.span, `cannot use \`${name}\` because it was mutably borrowed`, "E0503");
          b.diag.labels[0].message = `use of borrowed \`${loanName}\``;
          b.label(loan.span, `\`${loanName}\` is borrowed here`);
          if (later) b.label(later, "borrow later used here");
        } else if (a.kind === "move") {
          b = this.diags.error("borrowck", a.span, `cannot move out of \`${name}\` because it is borrowed`, "E0505");
          b.diag.labels[0].message = `move out of \`${name}\` occurs here`;
          b.label(loan.span, `borrow of \`${loanName}\` occurs here`);
          if (later) b.label(later, "borrow later used here");
        } else {
          b = this.diags.error("borrowck", a.span, `cannot assign to \`${name}\` because it is borrowed`, "E0506");
          b.diag.labels[0].message = `\`${name}\` is assigned to here but it was already borrowed`;
          b.label(loan.span, `\`${loanName}\` is borrowed here`);
          if (later) b.label(later, "borrow later used here");
        }
      });
    }
  }

  /** E0597: a variable goes out of scope while something still borrows it. */
  private checkStorageDead(s: Extract<Statement, { k: "dead" }>, active: Map<number, Local[]>, at: { block: number; index: number }) {
    for (const [loanId, holders] of active) {
      const loan = this.body.loans[loanId];
      if (loan.place.local !== s.local) continue;
      if (loan.place.proj.some((p) => p.k === "deref" && p.via !== "box")) continue;
      const decl = this.body.locals[s.local];
      if (decl.kind !== "user") continue;
      // Held only by the return place: that's E0515, reported at the `return`.
      if (holders.every((h) => h === 0)) continue;
      this.report(`E0597:${loan.span.start}`, () => {
        const b = this.diags.error("borrowck", loan.span, `\`${decl.name}\` does not live long enough`, "E0597");
        b.diag.labels[0].message = "borrowed value does not live long enough";
        b.label(s.span, `\`${decl.name}\` dropped here while still borrowed`);
        const later = this.findLaterUse(at, holders);
        if (later) b.label(later, "borrow later used here");
      });
    }
  }

  /** E0515: returning a reference to something that lives in this function's frame. */
  private checkReturn(holds: Holds, span: Span) {
    for (const loanId of holds.get(0) ?? []) {
      const loan = this.body.loans[loanId];
      if (loan.place.proj.some((p) => p.k === "deref" && p.via !== "box")) continue;
      const decl = this.body.locals[loan.place.local];
      this.report(`E0515:${loan.span.start}`, () => {
        const what = decl.kind === "temp" ? "temporary value" : `local variable \`${decl.name}\``;
        const direct = this.body.locals[0].ty.k === "ref";
        const b = this.diags.error("borrowck", loan.span, `cannot return ${direct ? "reference to" : "value referencing"} ${what}`, "E0515");
        b.diag.labels[0].message = `\`${decl.name ?? "value"}\` is borrowed here`;
        b.label(span, "returns a value referencing data owned by the current function");
        b.help("return an owned value instead (e.g. `String` rather than `&str`), or take the data as a parameter");
      });
    }
  }

  /** The span of the first later statement that uses one of `holders`. */
  private findLaterUse(at: { block: number; index: number }, holders: Local[]): Span | undefined {
    const want = new Set(holders);
    const seen = new Set<string>();
    const queue: { block: number; index: number }[] = [{ block: at.block, index: at.index + 1 }];
    while (queue.length) {
      const p = queue.shift()!;
      const key = `${p.block}:${p.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const block = this.body.blocks[p.block];
      if (p.index < block.stmts.length) {
        const s = block.stmts[p.index];
        if (this.uses(s).some((l) => want.has(l))) return s.span;
        queue.push({ block: p.block, index: p.index + 1 });
      } else {
        if (block.term.k === "return" && want.has(0)) return block.term.span;
        for (const s of this.succs(p.block)) queue.push({ block: s, index: 0 });
      }
    }
    return undefined;
  }

  /** A user-facing name for a place: `v`, `p.x`, `*r`, `v[..]`. */
  placeName(p: Place): string {
    let s = this.body.locals[p.local].name ?? "value";
    let pendingDeref = false;
    for (const pr of p.proj) {
      if (pr.k === "deref") {
        if (pendingDeref) s = `*${s}`;
        pendingDeref = true;
      } else if (pr.k === "field") {
        s = `${s}.${pr.name ?? pr.index}`;
        pendingDeref = false;
      } else {
        s = `${s}[..]`;
        pendingDeref = false;
      }
    }
    return pendingDeref ? `*${s}` : s;
  }
}

function rvOperands(rv: Rvalue): Operand[] {
  switch (rv.k) {
    case "use": return [rv.op];
    case "ref": return [];
    case "aggregate": case "call": case "pure": return rv.ops;
  }
}
