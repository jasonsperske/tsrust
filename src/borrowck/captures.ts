/**
 * # What does a closure capture?
 *
 * A closure borrows or takes ownership of the outer variables it uses, and
 * Rust works out which from the body alone:
 *
 * | The body...                         | Captured       | Closure can be |
 * |-------------------------------------|----------------|----------------|
 * | only reads `x`                      | `&x`           | `Fn`           |
 * | assigns to `x` or borrows it `&mut` | `&mut x`       | `FnMut`        |
 * | moves `x` out                       | `x` by value   | `FnOnce`       |
 *
 * `move` closures capture everything by value, but the *kind* still depends
 * only on what the body does. Captures are precise: using `p.x` captures just
 * that field, so `p.y` stays available to the enclosing function.
 *
 * The analysis reuses MIR lowering. Lowering the body turns auto-refs, match
 * ergonomics and copies into explicit statements, so each statement that
 * touches an outer variable says exactly how it is used. Inner closures are
 * analyzed first, and their captures appear as uses in the closure around them.
 */
import type { Diagnostics, Span } from "../diagnostics.ts";
import { InferCtxt } from "../typeck/infer.ts";
import type { Capture, CaptureProj, ClosureInfo, ClosureKind, TypeckResults } from "../typeck/results.ts";
import type { TyCtxt } from "../typeck/tcx.ts";
import { TraitSolver } from "../typeck/traits.ts";
import { Lowerer } from "./lower.ts";
import type { Operand, Place, Projection, Rvalue } from "./mir.ts";
import type { SignatureChecker } from "./signature.ts";

type Use = "ref" | "mut" | "move";
interface Event { place: Place; use: Use; span: Span; assign?: boolean }

const KIND_RANK: Record<ClosureKind, number> = { Fn: 0, FnMut: 1, FnOnce: 2 };
const USE_RANK = (by: Capture["by"]) => (by === "ref" ? 0 : by === "mut" ? 1 : 2);

/** The part of a place a closure can capture: it stops at indexing and at raw pointers. */
function capturable(p: Place, use: Use): { proj: CaptureProj[]; use: Use } {
  const proj: CaptureProj[] = [];
  for (const x of p.proj) {
    if (x.k === "index") return { proj, use: use === "move" ? "move" : use };
    if (x.k === "field" && (x.variant !== undefined || x.elem)) return { proj, use: use === "move" ? "move" : use === "mut" ? "mut" : "ref" };
    if (x.k === "deref" && (x.via === "raw" || x.via === "rawMut")) return { proj, use: "ref" };
    proj.push(x.k === "field" ? { k: "field", index: x.index } : { k: "deref", via: x.via });
  }
  return { proj, use };
}

const samePrefix = (a: CaptureProj[], b: CaptureProj[]) =>
  a.length <= b.length && a.every((x, i) => x.k === b[i].k && (x.k !== "field" || x.index === (b[i] as typeof x).index));

export function analyzeClosures(tcx: TyCtxt, r: TypeckResults, sigs: SignatureChecker, diags: Diagnostics) {
  // A closure's id is assigned after its body is parsed, so inner closures come first.
  for (const info of [...r.closures.values()].sort((a, b) => a.node.id - b.node.id)) analyze(info, tcx, r, sigs, diags);
}

function analyze(info: ClosureInfo, tcx: TyCtxt, r: TypeckResults, sigs: SignatureChecker, diags: Diagnostics) {
  const solver = new TraitSolver(tcx, new InferCtxt(), tcx.predicates(info.owner));
  const low = new Lowerer(tcx, r, solver, sigs, "{closure}");
  const body = low.lowerClosure(info);
  const events: Event[] = [];
  const isUpvar = (p: Place) => body.locals[p.local].kind === "upvar";
  const onOperand = (op: Operand, span: Span) => {
    if (op.k === "const" || !isUpvar(op.place)) return;
    events.push({ place: op.place, use: op.k === "move" ? "move" : "ref", span });
  };
  const operands = (rv: Rvalue): Operand[] => (rv.k === "use" ? [rv.op] : rv.k === "ref" ? [] : rv.ops);
  for (const b of body.blocks) {
    for (const s of b.stmts) {
      if (s.k === "inspect" && isUpvar(s.place)) events.push({ place: s.place, use: "ref", span: s.span });
      if (s.k !== "assign") continue;
      operands(s.rv).forEach((op) => onOperand(op, s.span));
      if (s.rv.k === "ref" && isUpvar(s.rv.place)) events.push({ place: s.rv.place, use: s.rv.mutable ? "mut" : "ref", span: s.span });
      if (isUpvar(s.dest)) events.push({ place: s.dest, use: "mut", span: s.span, assign: true });
    }
  }

  // The closure's kind comes from what the body does, even for `move` closures.
  let kind: ClosureKind = "Fn";
  let worst: Event | undefined;
  const captures: Capture[] = [];
  for (const ev of events) {
    const cut = capturable(ev.place, ev.use);
    const k: ClosureKind = cut.use === "move" ? "FnOnce" : cut.use === "mut" ? "FnMut" : "Fn";
    if (KIND_RANK[k] > KIND_RANK[kind]) { kind = k; worst = ev; }
    let proj = cut.proj;
    let by: Capture["by"] = cut.use === "move" ? undefined : cut.use;
    // By-value captures stop at the first dereference: you capture the pointer itself.
    if (by === undefined || info.node.isMove) {
      const at = proj.findIndex((x) => x.k === "deref");
      if (at >= 0) proj = proj.slice(0, at);
      by = undefined;
    }
    const root = low.upvarRoot(ev.place.local)!;
    merge(captures, { root, proj, by, ty: tcx.projTy(r.locals.get(root)!.ty, proj) }, tcx, r);
  }
  info.captures = captures;
  info.kind = kind;
  report(info, kind, worst, diags);
}

function merge(list: Capture[], c: Capture, tcx: TyCtxt, r: TypeckResults) {
  const stronger = (a: Capture["by"], b: Capture["by"]) => (USE_RANK(a) >= USE_RANK(b) ? a : b);
  for (const x of list) {
    // Already covered by a capture of the same place or an enclosing one.
    if (x.root === c.root && samePrefix(x.proj, c.proj)) { x.by = stronger(x.by, c.by); shorten(x, tcx, r); return; }
  }
  let by = c.by;
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i];
    if (x.root === c.root && samePrefix(c.proj, x.proj)) { by = stronger(by, x.by); list.splice(i, 1); }
  }
  const out = { ...c, by };
  shorten(out, tcx, r);
  list.push(out);
}

function shorten(c: Capture, tcx: TyCtxt, r: TypeckResults) {
  if (c.by !== undefined) return;
  const at = c.proj.findIndex((x) => x.k === "deref");
  if (at >= 0) c.proj = c.proj.slice(0, at);
  c.ty = tcx.projTy(r.locals.get(c.root)!.ty, c.proj);
}

function report(info: ClosureInfo, kind: ClosureKind, worst: Event | undefined, diags: Diagnostics) {
  if (info.toFnPtr && info.captures!.length) {
    diags.error("typeck", info.toFnPtr, "mismatched types", "E0308").note("closures can only be coerced to `fn` types if they do not capture any variables");
  }
  const limit = info.expectedKind;
  if (limit && KIND_RANK[kind] > KIND_RANK[limit] && worst) {
    // The bound fixed the closure's kind up front, so the offending use is the error.
    if (kind === "FnOnce") diags.error("borrowck", worst.span, `cannot move out of a captured variable in an \`${limit}\` closure`, "E0507");
    else if (worst.assign) diags.error("borrowck", worst.span, "cannot assign to a captured variable in a `Fn` closure", "E0594");
    else diags.error("borrowck", worst.span, "cannot borrow a captured variable in a `Fn` closure as mutable", "E0596");
    return;
  }
  if (limit) return;
  for (const req of info.required) {
    if (KIND_RANK[kind] <= KIND_RANK[req.kind]) continue;
    diags.error("typeck", info.node.span, `expected a closure that implements the \`${req.kind}\` trait, but this closure only implements \`${kind}\``, "E0525")
      .label(req.span, `the requirement to implement \`${req.kind}\` comes from here`);
    return;
  }
}

export type { Projection };
