/**
 * # Lowering a function body to MIR
 *
 * This walks the typed AST and emits MIR statements into basic blocks. The
 * important decisions it makes are the ones the borrow checker cares about:
 *
 * - **Copy or move?** Reading a place whose type is `Copy` emits `copy`;
 *   anything else emits `move`.
 * - **Places stay places.** `match x { .. }`, `&v[i]` and `p.field` refer to
 *   existing memory rather than copying it into a temporary.
 * - **Auto-deref and auto-ref** recorded by the type checker become explicit
 *   `*` projections and `&`/`&mut` loans.
 * - **Two-phase borrows.** For `v.push(v.len())` the implicit `&mut v` for the
 *   receiver is created *after* the arguments are evaluated. Real Rust achieves
 *   the same with "two-phase borrows": the mutable borrow is reserved first and
 *   only activated at the call.
 * - **Scopes end.** At the end of each block, its variables get a `dead`
 *   statement. A loan of a dead variable that's still in use is "does not live
 *   long enough".
 */
import type { Span } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { DefId } from "../resolve/defs.ts";
import type { TypeckResults } from "../typeck/results.ts";
import type { TyCtxt } from "../typeck/tcx.ts";
import type { TraitSolver } from "../typeck/traits.ts";
import { ERROR, UNIT, substitute, type Ty } from "../typeck/types.ts";
import type { ArgFlow, BasicBlock, Body, Local, LocalDecl, Operand, Place, Projection, Rvalue, Statement } from "./mir.ts";
import type { SignatureChecker } from "./signature.ts";

/** Operands remember whether the value read could carry a borrow (has a reference inside). */
export type RefOperand = Operand & { refs?: boolean };

interface LoopTarget {
  header: number;
  exit: number;
  dest: Place;
  /** Scope depth when the loop started: `break`/`continue` end every scope above it. */
  depth: number;
}

export class Lowerer {
  readonly body: Body;
  private cur = 0;
  private readonly localOf = new Map<A.NodeId, Local>();
  private readonly scopes: Local[][] = [];
  private readonly loops = new Map<A.NodeId, LoopTarget>();
  /** Temps created by `&place`, so calls can tell the reference apart from what it points to. */
  readonly borrowOf = new Map<Local, Place>();

  private readonly tcx: TyCtxt;
  private readonly r: TypeckResults;
  private readonly solver: TraitSolver;
  private readonly sigs: SignatureChecker;
  private readonly copyCache = new Map<string, boolean>();

  constructor(tcx: TyCtxt, r: TypeckResults, solver: TraitSolver, sigs: SignatureChecker, name: string) {
    this.tcx = tcx;
    this.r = r;
    this.solver = solver;
    this.sigs = sigs;
    this.body = { name, locals: [], blocks: [{ stmts: [], term: { k: "unreachable" } }], loans: [], argCount: 0 };
  }

  // -------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------

  private newLocal(decl: LocalDecl): Local {
    this.body.locals.push(decl);
    return this.body.locals.length - 1;
  }

  private temp(ty: Ty, span: Span): Local {
    return this.newLocal({ ty, mutable: true, span, kind: "temp" });
  }

  private newBlock(): number {
    this.body.blocks.push({ stmts: [], term: { k: "unreachable" } });
    return this.body.blocks.length - 1;
  }

  private get block(): BasicBlock {
    return this.body.blocks[this.cur];
  }

  private emit(s: Statement) {
    this.block.stmts.push(s);
  }

  /** End the current block with `term` and continue in `next` (a fresh unreachable block by default). */
  private terminate(term: BasicBlock["term"], next?: number) {
    this.block.term = term;
    this.cur = next ?? this.newBlock();
  }

  private gotoBlock(target: number) {
    this.terminate({ k: "goto", target }, target);
  }

  private tyOf(id: A.NodeId): Ty {
    return this.r.types.get(id) ?? ERROR;
  }

  isCopy(t: Ty): boolean {
    const key = JSON.stringify(t);
    let v = this.copyCache.get(key);
    if (v === undefined) {
      v = t.k === "error" || this.solver.holds(t, this.tcx.lang("Copy"));
      this.copyCache.set(key, v);
    }
    return v;
  }

  /** Can a value of this type contain a borrow? (references, ADTs with lifetimes, generic params) */
  mayHoldRefs(t: Ty): boolean {
    if (t.k === "ref" || t.k === "param" || t.k === "proj") return true;
    if (t.k === "tuple") return t.elems.some((e) => this.mayHoldRefs(e));
    if (t.k === "adt") {
      const node = this.tcx.defs[t.def].node as A.StructItem | A.EnumItem | undefined;
      if (node && node.generics.lifetimes.length) return true;
      return t.args.some((a) => this.mayHoldRefs(a));
    }
    return false;
  }

  private operand(place: Place, ty: Ty): RefOperand {
    return { k: this.isCopy(ty) ? "copy" : "move", place, refs: this.mayHoldRefs(ty) };
  }

  private loan(place: Place, mutable: boolean, span: Span, implicit = false): number {
    const id = this.body.loans.length;
    this.body.loans.push({ id, place, mutable, span, implicit });
    return id;
  }

  private assign(dest: Place, rv: Rvalue, span: Span) {
    this.emit({ k: "assign", dest, rv, span });
  }

  /** Make sure a computed operand's read is visible to the checker even if its value is unused. */
  private consume(op: Operand, span: Span) {
    if (op.k === "const") return;
    if (op.k === "move") {
      const t = this.temp(UNIT, span);
      this.assign({ local: t, proj: [] }, { k: "use", op }, span);
    } else {
      this.emit({ k: "inspect", place: op.place, span });
    }
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  lowerFn(fn: A.FnItem, def: DefId): Body {
    const sig = this.tcx.fnSig(def);
    this.newLocal({ ty: sig.ret, mutable: true, span: fn.ret?.span ?? fn.nameSpan, kind: "return", name: "return" });
    this.scopes.push([]);
    const argPlaces: { pat: A.Pattern; local: Local }[] = [];
    if (fn.selfParam) {
      const info = this.r.locals.get(fn.selfParam.id)!;
      const l = this.newLocal({ ty: info.ty, mutable: info.mutable, span: fn.selfParam.span, kind: "arg", name: "self" });
      this.localOf.set(fn.selfParam.id, l);
    }
    for (const p of fn.params) {
      const simple = p.pat.kind === "ident" && !this.tcx.res.patternPaths.has(p.pat.id);
      const info = simple ? this.r.locals.get(p.pat.id) : undefined;
      const l = this.newLocal({ ty: this.tyOf(p.pat.id), mutable: info?.mutable ?? false, span: p.pat.span, kind: "arg", name: info?.name });
      if (simple) this.localOf.set(p.pat.id, l);
      else argPlaces.push({ pat: p.pat, local: l });
    }
    this.body.argCount = this.body.locals.length - 1;
    for (const a of argPlaces) {
      this.declarePatternLocals(a.pat);
      this.bindPattern(a.pat, { local: a.local, proj: [] }, this.tyOf(a.pat.id));
    }
    if (fn.body) {
      this.lowerInto({ local: 0, proj: [] }, fn.body);
      this.endScope(fn.body.span);
      this.terminate({ k: "return", span: fn.body.span });
    }
    return this.body;
  }

  private declarePatternLocals(p: A.Pattern) {
    const scope = this.scopes[this.scopes.length - 1];
    const visit = (p: A.Pattern) => {
      switch (p.kind) {
        case "ident": {
          if (this.tcx.res.patternPaths.has(p.id)) return;
          const info = this.r.locals.get(p.id);
          const l = this.newLocal({ ty: info?.ty ?? ERROR, mutable: info?.mutable ?? false, span: p.span, kind: "user", name: p.name });
          this.localOf.set(p.id, l);
          scope.push(l);
          if (p.sub) visit(p.sub);
          return;
        }
        case "tuple": case "tupleStruct": p.elems.forEach(visit); return;
        case "struct": p.fields.forEach((f) => visit(f.pat)); return;
        case "ref": visit(p.inner); return;
        case "or": visit(p.alts[0]); return;
      }
    };
    visit(p);
  }

  /** Early exits (`break`, `continue`, `return`) end every scope above `depth` without popping them. */
  private exitScopes(depth: number, span: Span) {
    for (let i = this.scopes.length - 1; i >= depth; i--) {
      const scope = this.scopes[i];
      for (let j = scope.length - 1; j >= 0; j--) this.emit({ k: "dead", local: scope[j], span });
    }
  }

  private endScope(span: Span) {
    const scope = this.scopes.pop() ?? [];
    for (let i = scope.length - 1; i >= 0; i--) this.emit({ k: "dead", local: scope[i], span: { ...span, start: Math.max(span.start, span.end - 1) } });
  }

  // -------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------

  private derefVia(t: Ty): Projection {
    if (t.k === "ref") return { k: "deref", via: t.mutable ? "refMut" : "ref" };
    if (t.k === "adt" && this.tcx.isLang(t.def, "Box")) return { k: "deref", via: "box" };
    return { k: "deref", via: "other" };
  }

  /** Apply the type checker's recorded auto-derefs for expression `e` to `place`. */
  private applyDerefs(place: Place, e: A.Expr): { place: Place; ty: Ty } {
    let ty = this.tyOf(e.id);
    const adj = this.r.adjustments.get(e.id);
    if (!adj) return { place, ty };
    let proj = [...place.proj];
    for (const step of adj.derefs) {
      proj.push(this.derefVia(ty));
      ty = step === "string" ? { k: "str" } : ty.k === "ref" ? ty.inner : ty.k === "adt" ? ty.args[0] ?? ERROR : ERROR;
    }
    return { place: { local: place.local, proj }, ty };
  }

  private isPlaceExpr(e: A.Expr): boolean {
    if (e.kind === "path") {
      const pr = this.tcx.res.paths.get(e.path.id);
      return pr?.base.kind === "local" && pr.unresolved.length === 0;
    }
    if (e.kind === "field") return true;
    if (e.kind === "index") return true;
    if (e.kind === "unary" && e.op === "*") return true;
    return false;
  }

  /** The place an expression denotes, evaluating it into a temporary if it isn't one. */
  lowerPlace(e: A.Expr): Place {
    switch (e.kind) {
      case "path": {
        const pr = this.tcx.res.paths.get(e.path.id);
        if (pr?.base.kind === "local" && pr.unresolved.length === 0) {
          const l = this.localOf.get(pr.base.id);
          if (l !== undefined) return { local: l, proj: [] };
        }
        break;
      }
      case "field": {
        const base = this.applyDerefs(this.lowerPlace(e.expr), e.expr);
        const index = this.r.fieldIndices.get(e.id) ?? 0;
        return { local: base.place.local, proj: [...base.place.proj, { k: "field", index, name: e.name }] };
      }
      case "index": {
        const base = this.applyDerefs(this.lowerPlace(e.expr), e.expr);
        if (base.ty.k === "adt" && this.tcx.isLang(base.ty.def, "HashMap")) {
          // `map[&k]` reads through a reference returned by the map.
          const key = this.lowerOperand(e.index);
          const ref = this.temp({ k: "ref", mutable: false, inner: this.tyOf(e.id) }, e.span);
          const l = this.loan(base.place, false, e.span, true);
          const borrowTmp = this.temp({ k: "ref", mutable: false, inner: base.ty }, e.span);
          this.assign({ local: borrowTmp, proj: [] }, { k: "ref", mutable: false, place: base.place, loan: l }, e.span);
          this.borrowOf.set(borrowTmp, base.place);
          this.assign({ local: ref, proj: [] }, { k: "call", ops: [{ k: "move", place: { local: borrowTmp, proj: [] } }, key], flows: ["full", "none"], name: "index" }, e.span);
          return { local: ref, proj: [{ k: "deref", via: "ref" }] };
        }
        if (this.r.strSlices.has(e.id) && e.index.kind === "range") {
          for (const bound of [e.index.start, e.index.end]) if (bound) this.consume(this.lowerOperand(bound), bound.span);
          return { local: base.place.local, proj: [...base.place.proj, { k: "index" }] };
        }
        const idx = this.lowerOperand(e.index);
        this.consume(idx, e.index.span);
        return { local: base.place.local, proj: [...base.place.proj, { k: "index" }] };
      }
      case "unary": {
        if (e.op !== "*") break;
        const inner = this.isPlaceExpr(e.expr) ? this.applyDerefs(this.lowerPlace(e.expr), e.expr).place : this.lowerToTemp(e.expr);
        return { local: inner.local, proj: [...inner.proj, this.derefVia(this.tyOf(e.expr.id))] };
      }
    }
    return this.lowerToTemp(e);
  }

  private lowerToTemp(e: A.Expr): Place {
    const t = this.temp(this.tyOf(e.id), e.span);
    const p = { local: t, proj: [] };
    this.lowerInto(p, e);
    return p;
  }

  /** Evaluate `e` as an operand: a const, or a copy/move of a place. */
  lowerOperand(e: A.Expr): RefOperand {
    if (e.kind === "lit") return { k: "const" };
    if (e.kind === "path" && !this.isPlaceExpr(e)) {
      if (this.r.ctors.has(e.id) || this.r.callees.has(e.id)) return { k: "const" };
    }
    if (this.isPlaceExpr(e)) {
      const { place, ty } = this.applyDerefs(this.lowerPlace(e), e);
      return this.operand(place, ty);
    }
    const p = this.lowerToTemp(e);
    const adj = this.applyDerefs(p, e);
    return this.operand(adj.place, adj.ty);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /**
   * An argument of type `&mut T` that names a place is *reborrowed*
   * (`&mut *r`) rather than moved, so `r` stays usable after the call. This is
   * Rust's implicit reborrowing at coercion sites.
   */
  private lowerArg(e: A.Expr): RefOperand {
    const t = this.tyOf(e.id);
    if (t.k === "ref" && t.mutable && this.isPlaceExpr(e) && !this.r.coercions.has(e.id)) {
      const { place } = this.applyDerefs(this.lowerPlace(e), e);
      const target: Place = { local: place.local, proj: [...place.proj, { k: "deref", via: "refMut" }] };
      const l = this.loan(target, true, e.span, true);
      const tmp = this.temp(t, e.span);
      this.assign({ local: tmp, proj: [] }, { k: "ref", mutable: true, place: target, loan: l }, e.span);
      this.borrowOf.set(tmp, target);
      return { k: "move", place: { local: tmp, proj: [] }, refs: true };
    }
    return this.lowerOperand(e);
  }

  private callFlows(def: DefId): ArgFlow[] {
    return this.sigs.flowSig(def).flows;
  }

  /** Emit `dest = <value of e>`. */
  lowerInto(dest: Place, e: A.Expr): void {
    const span = e.span;
    switch (e.kind) {
      case "lit":
        this.assign(dest, { k: "use", op: { k: "const" } }, span);
        return;
      case "path": case "field": case "index":
        this.assign(dest, { k: "use", op: this.lowerOperand(e) }, span);
        return;
      case "unary": {
        if (e.op === "*") {
          this.assign(dest, { k: "use", op: this.lowerOperand(e) }, span);
          return;
        }
        const callee = this.r.callees.get(e.id);
        const op = this.lowerOperand(e.expr);
        if (callee) this.assign(dest, { k: "call", ops: [op], flows: this.callFlows(callee.def), name: this.tcx.nameOf(callee.def) }, span);
        else this.assign(dest, { k: "pure", ops: [op] }, span);
        return;
      }
      case "ref": {
        const inner = this.isPlaceExpr(e.expr) ? this.applyDerefs(this.lowerPlace(e.expr), e.expr).place : this.lowerToTemp(e.expr);
        const l = this.loan(inner, e.mutable, span);
        this.assign(dest, { k: "ref", mutable: e.mutable, place: inner, loan: l }, span);
        if (dest.proj.length === 0) this.borrowOf.set(dest.local, inner);
        return;
      }
      case "binary": return this.lowerBinary(dest, e);
      case "assign": {
        this.lowerAssign(e);
        this.assign(dest, { k: "use", op: { k: "const" } }, span);
        return;
      }
      case "call": {
        const ops = e.args.map((a) => this.lowerArg(a));
        const ctor = this.r.ctors.get(e.id);
        const callee = this.r.callees.get(e.id);
        if (ctor || !callee) this.assign(dest, { k: "aggregate", ops }, span);
        else this.assign(dest, { k: "call", ops, flows: this.callFlows(callee.def), name: this.tcx.nameOf(callee.def) }, span);
        if (this.tyOf(e.id).k === "never") this.terminate({ k: "unreachable" });
        return;
      }
      case "methodCall": return this.lowerMethodCall(dest, e);
      case "structLit": {
        const ops = e.fields.map((f) => this.lowerOperand(f.value));
        if (e.base) ops.push(this.lowerOperand(e.base));
        this.assign(dest, { k: "aggregate", ops }, span);
        return;
      }
      case "tuple":
        this.assign(dest, { k: "aggregate", ops: e.elems.map((x) => this.lowerOperand(x)) }, span);
        return;
      case "block": return this.lowerBlock(dest, e);
      case "if": {
        const cond = this.lowerOperand(e.cond);
        this.consume(cond, e.cond.span);
        const thenB = this.newBlock(), elseB = this.newBlock(), join = this.newBlock();
        this.block.term = { k: "switch", targets: [thenB, elseB] };
        this.cur = thenB;
        this.lowerInto(dest, e.then);
        this.block.term = { k: "goto", target: join };
        this.cur = elseB;
        if (e.else) this.lowerInto(dest, e.else);
        else this.assign(dest, { k: "use", op: { k: "const" } }, span);
        this.block.term = { k: "goto", target: join };
        this.cur = join;
        return;
      }
      case "while": {
        const header = this.newBlock(), bodyB = this.newBlock(), exit = this.newBlock();
        this.gotoBlock(header);
        const cond = this.lowerOperand(e.cond);
        this.consume(cond, e.cond.span);
        this.terminate({ k: "switch", targets: [bodyB, exit] }, bodyB);
        this.loops.set(e.id, { header, exit, dest, depth: this.scopes.length });
        this.lowerToTemp(e.body);
        this.gotoBlock(header);
        this.cur = exit;
        this.assign(dest, { k: "use", op: { k: "const" } }, span);
        return;
      }
      case "loop": {
        const header = this.newBlock(), exit = this.newBlock();
        this.gotoBlock(header);
        this.loops.set(e.id, { header, exit, dest, depth: this.scopes.length });
        this.lowerToTemp(e.body);
        this.gotoBlock(header);
        this.cur = exit;
        return;
      }
      case "for": return this.lowerFor(dest, e);
      case "break": {
        const target = this.loops.get(this.tcx.res.labels.get(e.id) ?? -1);
        if (target) {
          if (e.value) this.lowerInto(target.dest, e.value);
          else this.assign(target.dest, { k: "use", op: { k: "const" } }, span);
          this.exitScopes(target.depth, span);
          this.terminate({ k: "goto", target: target.exit });
        }
        return;
      }
      case "continue": {
        const target = this.loops.get(this.tcx.res.labels.get(e.id) ?? -1);
        if (target) {
          this.exitScopes(target.depth, span);
          this.terminate({ k: "goto", target: target.header });
        }
        return;
      }
      case "return": {
        if (e.value) this.lowerInto({ local: 0, proj: [] }, e.value);
        else this.assign({ local: 0, proj: [] }, { k: "use", op: { k: "const" } }, span);
        this.exitScopes(0, span);
        this.terminate({ k: "return", span });
        return;
      }
      case "match": return this.lowerMatch(dest, e);
      case "range": {
        const ops = [e.start, e.end].filter((x): x is A.Expr => !!x).map((x) => this.lowerOperand(x));
        this.assign(dest, { k: "aggregate", ops }, span);
        return;
      }
      case "cast":
        this.assign(dest, { k: "pure", ops: [this.lowerOperand(e.expr)] }, span);
        return;
      case "try": {
        const p = this.lowerToTemp(e.expr);
        const ok = this.newBlock(), err = this.newBlock();
        this.emit({ k: "inspect", place: p, span });
        this.terminate({ k: "switch", targets: [ok, err] }, err);
        const kind = this.r.tryKinds.get(e.id);
        const errField: Place = { local: p.local, proj: [{ k: "field", index: 0, variant: kind === "option" ? 0 : 1 }] };
        this.assign({ local: 0, proj: [] }, { k: "aggregate", ops: kind === "option" ? [] : [this.operand(errField, ERROR)] }, span);
        this.terminate({ k: "return", span }, ok);
        const okField: Place = { local: p.local, proj: [{ k: "field", index: 0, variant: kind === "option" ? 1 : 0 }] };
        this.assign(dest, { k: "use", op: this.operand(okField, this.tyOf(e.id)) }, span);
        return;
      }
      case "macro": return this.lowerMacro(dest, e);
    }
  }

  private lowerBinary(dest: Place, e: Extract<A.Expr, { kind: "binary" }>) {
    const span = e.span;
    if (e.op === "&&" || e.op === "||") {
      this.lowerInto(dest, e.left);
      const rhs = this.newBlock(), join = this.newBlock();
      this.terminate({ k: "switch", targets: [rhs, join] }, rhs);
      this.lowerInto(dest, e.right);
      this.gotoBlock(join);
      return;
    }
    const isCmp = ["==", "!=", "<", "<=", ">", ">="].includes(e.op);
    const callee = this.r.callees.get(e.id);
    if (isCmp) {
      // Comparisons take their operands by reference: they never move.
      for (const side of [e.left, e.right]) {
        const op = this.lowerOperand(side);
        if (op.k !== "const") this.emit({ k: "inspect", place: op.place, span: side.span });
      }
      this.assign(dest, { k: "pure", ops: [] }, span);
      return;
    }
    const ops = [this.lowerOperand(e.left), this.lowerOperand(e.right)];
    if (callee) this.assign(dest, { k: "call", ops, flows: this.callFlows(callee.def), name: this.tcx.nameOf(callee.def) }, span);
    else this.assign(dest, { k: "pure", ops }, span);
  }

  private lowerAssign(e: Extract<A.Expr, { kind: "assign" }>) {
    const callee = this.r.callees.get(e.id);
    if (e.op === "=") {
      const value = this.lowerOperand(e.value);
      const target = this.lowerPlace(e.target);
      this.assign(target, { k: "use", op: value }, e.span);
      return;
    }
    if (callee) {
      // `a += b` via `AddAssign::add_assign(&mut a, b)`.
      const value = this.lowerOperand(e.value);
      const target = this.lowerPlace(e.target);
      const l = this.loan(target, true, e.target.span, true);
      const ref = this.temp({ k: "ref", mutable: true, inner: this.tyOf(e.target.id) }, e.span);
      this.assign({ local: ref, proj: [] }, { k: "ref", mutable: true, place: target, loan: l }, e.span);
      const t = this.temp(UNIT, e.span);
      this.assign({ local: t, proj: [] }, { k: "call", ops: [{ k: "move", place: { local: ref, proj: [] } }, value], flows: ["none", "none"], name: this.tcx.nameOf(callee.def) }, e.span);
      return;
    }
    const value = this.lowerOperand(e.value);
    const target = this.lowerPlace(e.target);
    this.emit({ k: "inspect", place: target, span: e.target.span });
    this.assign(target, { k: "pure", ops: [value] }, e.span);
  }

  private lowerMethodCall(dest: Place, e: Extract<A.Expr, { kind: "methodCall" }>) {
    const callee = this.r.callees.get(e.id);
    const adj = this.r.adjustments.get(e.receiver.id);
    const recvBase = this.isPlaceExpr(e.receiver) ? this.lowerPlace(e.receiver) : this.lowerToTemp(e.receiver);
    const { place: recvPlace, ty: recvTy } = this.applyDerefs(recvBase, e.receiver);
    // Arguments first, then the receiver's auto-borrow (two-phase borrows).
    const args = e.args.map((a) => this.lowerArg(a));
    let recvOp: RefOperand;
    const reborrow = !adj?.autoref && recvTy.k === "ref" && recvTy.mutable && this.isPlaceExpr(e.receiver);
    if (reborrow) {
      const target: Place = { local: recvPlace.local, proj: [...recvPlace.proj, { k: "deref", via: "refMut" }] };
      const l = this.loan(target, true, e.span, true);
      const t = this.temp(recvTy, e.span);
      this.assign({ local: t, proj: [] }, { k: "ref", mutable: true, place: target, loan: l }, e.span);
      this.borrowOf.set(t, target);
      recvOp = { k: "move", place: { local: t, proj: [] }, refs: true };
    } else if (adj?.autoref) {
      const mutable = adj.autoref === "mut";
      const l = this.loan(recvPlace, mutable, e.receiver.span.end === e.span.end ? e.span : { ...e.span, start: e.receiver.span.start }, true);
      const t = this.temp({ k: "ref", mutable, inner: recvTy }, e.span);
      this.assign({ local: t, proj: [] }, { k: "ref", mutable, place: recvPlace, loan: l }, e.span);
      this.borrowOf.set(t, recvPlace);
      recvOp = { k: "move", place: { local: t, proj: [] }, refs: true };
    } else {
      recvOp = this.operand(recvPlace, recvTy);
    }
    const flows = callee ? this.callFlows(callee.def) : [];
    this.assign(dest, { k: "call", ops: [recvOp, ...args], flows, name: callee ? this.tcx.nameOf(callee.def) : e.method }, e.span);
    if (this.tyOf(e.id).k === "never") this.terminate({ k: "unreachable" });
  }

  private lowerBlock(dest: Place, b: A.BlockExpr) {
    this.scopes.push([]);
    for (const s of b.stmts) {
      if (s.kind === "let") this.lowerLet(s);
      else if (s.kind === "expr") {
        const t = this.temp(this.tyOf(s.expr.id), s.expr.span);
        this.lowerInto({ local: t, proj: [] }, s.expr);
      }
    }
    if (b.tail) this.lowerInto(dest, b.tail);
    else this.assign(dest, { k: "use", op: { k: "const" } }, b.span);
    this.endScope(b.span);
  }

  private lowerLet(s: Extract<A.Stmt, { kind: "let" }>) {
    const simple = s.pat.kind === "ident" && !this.tcx.res.patternPaths.has(s.pat.id) && !s.pat.sub && (this.r.bindingModes.get(s.pat.id) ?? "move") === "move";
    if (!s.init) {
      this.declarePatternLocals(s.pat);
      return;
    }
    if (simple) {
      // Evaluate the initializer *before* the binding comes into scope (shadowing!).
      const t = this.temp(this.tyOf(s.pat.id), s.init.span);
      this.lowerInto({ local: t, proj: [] }, s.init);
      this.declarePatternLocals(s.pat);
      const l = this.localOf.get(s.pat.id)!;
      this.assign({ local: l, proj: [] }, { k: "use", op: this.operand({ local: t, proj: [] }, this.tyOf(s.pat.id)) }, s.span);
      return;
    }
    const place = this.isPlaceExpr(s.init) ? this.applyDerefs(this.lowerPlace(s.init), s.init).place : this.lowerToTemp(s.init);
    this.declarePatternLocals(s.pat);
    this.bindPattern(s.pat, place, this.r.types.get(s.init.id) ?? ERROR);
  }

  /** Bind the variables of pattern `p`, matched against `place` of type `ty`. */
  private bindPattern(p: A.Pattern, place: Place, ty: Ty) {
    const derefs = this.r.patDerefs.get(p.id) ?? 0;
    for (let i = 0; i < derefs; i++) {
      place = { local: place.local, proj: [...place.proj, this.derefVia(ty)] };
      ty = ty.k === "ref" ? ty.inner : ty;
    }
    switch (p.kind) {
      case "ident": {
        if (this.tcx.res.patternPaths.has(p.id)) return;
        const local = this.localOf.get(p.id);
        if (local === undefined) return;
        const mode = this.r.bindingModes.get(p.id) ?? "move";
        const valTy = this.r.types.get(p.id) ?? ty;
        if (mode === "move") {
          this.assign({ local, proj: [] }, { k: "use", op: this.operand(place, valTy) }, p.span);
        } else {
          const l = this.loan(place, mode === "refMut", p.span);
          this.assign({ local, proj: [] }, { k: "ref", mutable: mode === "refMut", place, loan: l }, p.span);
        }
        if (p.sub) this.bindPattern(p.sub, place, valTy);
        return;
      }
      case "tuple": {
        const t = this.r.types.get(p.id) ?? ty;
        p.elems.forEach((x, i) => this.bindPattern(x, { local: place.local, proj: [...place.proj, { k: "field", index: i }] }, t.k === "tuple" ? t.elems[i] : ERROR));
        return;
      }
      case "tupleStruct": case "struct": {
        const ctor = this.r.ctors.get(p.id);
        const d = ctor ? this.tcx.defs[ctor.def] : undefined;
        const variant = d?.kind === "variant" ? d.variantIndex : undefined;
        const t = this.r.types.get(p.id) ?? ty;
        const fieldTy = (i: number): Ty => {
          if (t.k !== "adt" || !ctor) return ERROR;
          const v = this.tcx.variants(t.def).find((x) => x.def === ctor.def);
          const f = v?.fields[i];
          if (!f) return ERROR;
          const subst = new Map((this.tcx.res.genericsOf.get(t.def) ?? []).map((g, j) => [g, t.args[j]]));
          return substitute(f.ty, subst);
        };
        const sub = p.kind === "tupleStruct" ? p.elems.map((x, i) => ({ x, i })) : p.fields.map((f) => ({ x: f.pat, i: this.r.fieldIndices.get(f.pat.id) ?? 0 }));
        for (const { x, i } of sub) {
          this.bindPattern(x, { local: place.local, proj: [...place.proj, { k: "field", index: i, variant }] }, fieldTy(i));
        }
        return;
      }
      case "ref": {
        const inner = ty.k === "ref" ? ty.inner : ERROR;
        this.bindPattern(p.inner, { local: place.local, proj: [...place.proj, this.derefVia(ty)] }, inner);
        return;
      }
      case "or":
        this.bindPattern(p.alts[0], place, ty);
        return;
    }
  }

  private lowerMatch(dest: Place, e: Extract<A.Expr, { kind: "match" }>) {
    const scrut = this.isPlaceExpr(e.scrutinee) ? this.applyDerefs(this.lowerPlace(e.scrutinee), e.scrutinee).place : this.lowerToTemp(e.scrutinee);
    const scrutTy = this.tyOf(e.scrutinee.id);
    this.emit({ k: "inspect", place: scrut, span: e.scrutinee.span });
    const armBlocks = e.arms.map(() => this.newBlock());
    const join = this.newBlock();
    this.terminate({ k: "switch", targets: armBlocks }, armBlocks[0] ?? join);
    e.arms.forEach((arm, i) => {
      this.cur = armBlocks[i];
      this.scopes.push([]);
      this.declarePatternLocals(arm.pat);
      this.bindPattern(arm.pat, scrut, scrutTy);
      if (arm.guard) {
        const g = this.lowerOperand(arm.guard);
        this.consume(g, arm.guard.span);
      }
      this.lowerInto(dest, arm.body);
      this.endScope(arm.span);
      this.terminate({ k: "goto", target: join });
    });
    this.cur = join;
  }

  private lowerFor(dest: Place, e: Extract<A.Expr, { kind: "for" }>) {
    const info = this.r.forLoops.get(e.id);
    const iterOp = this.lowerOperand(e.iter);
    const iterTy = info?.iterTy ?? ERROR;
    const iter = this.newLocal({ ty: iterTy, mutable: true, span: e.iter.span, kind: "temp", name: "iter" });
    this.assign({ local: iter, proj: [] }, { k: "call", ops: [iterOp], flows: info ? this.callFlows(info.intoIter.def) : ["full"], name: "into_iter" }, e.iter.span);
    const header = this.newBlock(), bodyB = this.newBlock(), exit = this.newBlock();
    this.gotoBlock(header);
    const l = this.loan({ local: iter, proj: [] }, true, e.iter.span, true);
    const ref = this.temp({ k: "ref", mutable: true, inner: iterTy }, e.iter.span);
    this.assign({ local: ref, proj: [] }, { k: "ref", mutable: true, place: { local: iter, proj: [] }, loan: l }, e.iter.span);
    this.borrowOf.set(ref, { local: iter, proj: [] });
    const optTy: Ty = info ? { k: "adt", def: this.tcx.lang("Option"), args: [info.itemTy] } : ERROR;
    const next = this.temp(optTy, e.iter.span);
    this.assign({ local: next, proj: [] }, { k: "call", ops: [{ k: "move", place: { local: ref, proj: [] }, refs: true }], flows: info ? this.callFlows(info.next.def) : ["inner"], name: "next" }, e.iter.span);
    this.terminate({ k: "switch", targets: [bodyB, exit] }, bodyB);
    this.loops.set(e.id, { header, exit, dest, depth: this.scopes.length });
    this.scopes.push([]);
    this.declarePatternLocals(e.pat);
    this.bindPattern(e.pat, { local: next, proj: [{ k: "field", index: 0, variant: 1 }] }, info?.itemTy ?? ERROR);
    this.lowerToTemp(e.body);
    this.endScope(e.body.span);
    this.gotoBlock(header);
    this.cur = exit;
    this.emit({ k: "dead", local: iter, span: e.span });
    this.assign(dest, { k: "use", op: { k: "const" } }, e.span);
  }

  private lowerMacro(dest: Place, e: Extract<A.Expr, { kind: "macro" }>) {
    const span = e.span;
    // Format arguments are taken by reference: inspect them, never move them.
    const inspectAll = (exprs: A.Expr[]) => {
      for (const a of exprs) {
        if (this.isPlaceExpr(a)) this.emit({ k: "inspect", place: this.applyDerefs(this.lowerPlace(a), a).place, span: a.span });
        else this.lowerToTemp(a);
      }
    };
    switch (e.name) {
      case "vec": {
        const ops = e.args.map((a) => this.lowerOperand(a));
        this.assign(dest, { k: "aggregate", ops }, span);
        return;
      }
      case "write": case "writeln": {
        const target = this.lowerOperand(e.args[0]);
        if (e.format) inspectAll(e.format.args);
        this.assign(dest, { k: "call", ops: [target], flows: ["none"], name: e.name }, span);
        return;
      }
      case "assert": case "assert_eq": case "assert_ne":
        inspectAll(e.args);
        if (e.format) inspectAll(e.format.args);
        this.assign(dest, { k: "use", op: { k: "const" } }, span);
        return;
      default:
        if (e.format) inspectAll(e.format.args);
        if (["panic", "unreachable", "todo", "unimplemented"].includes(e.name)) {
          this.terminate({ k: "unreachable" });
          return;
        }
        this.assign(dest, { k: "pure", ops: [] }, span);
    }
  }
}

