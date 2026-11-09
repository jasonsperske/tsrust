/**
 * # Stage 6: Borrow checking
 *
 * ```mermaid
 * flowchart LR
 *   T[typed AST] --> S["signatures<br/>lifetime elision (E0106)"]
 *   T --> L["lower each fn<br/>to MIR (CFG)"] --> D["dataflow:<br/>moves · loans · liveness"] --> C["conflict checks<br/>E0382 E0499 E0502 E0505<br/>E0506 E0507 E0515 E0597 ..."]
 * ```
 *
 * The standard library is trusted and skipped (it contains intrinsics whose
 * bodies the borrow checker can't see), exactly like rustc doesn't re-check
 * your dependencies.
 */
import type { Diagnostics } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { DefId } from "../resolve/defs.ts";
import { InferCtxt } from "../typeck/infer.ts";
import type { TypeckOutput } from "../typeck/index.ts";
import { TraitSolver } from "../typeck/traits.ts";
import { BodyChecker } from "./check.ts";
import { Lowerer } from "./lower.ts";
import { bodyToString, type Body } from "./mir.ts";
import { SignatureChecker } from "./signature.ts";

export interface BorrowckOutput {
  /** MIR for each checked function, for inspection. */
  bodies: Map<DefId, Body>;
  /** Pretty-printed MIR for each checked function. */
  mirText(def: DefId): string;
}

export function borrowck(tc: TypeckOutput, diags: Diagnostics): BorrowckOutput {
  const { tcx, results } = tc;
  const sigs = new SignatureChecker(tcx, diags);
  const bodies = new Map<DefId, Body>();
  const before = diags.errors().length;
  sigs.checkAll();
  // Like rustc, signature errors (E0106) stop us before checking bodies.
  if (diags.errors().length > before) return { bodies, mirText: () => "" };
  for (const def of results.checkedBodies) {
    const d = tcx.defs[def];
    if (tcx.defs[tcx.res.crateRoots[d.crate]].name === "std") continue;
    const solver = new TraitSolver(tcx, new InferCtxt(), tcx.predicates(def));
    const lowerer = new Lowerer(tcx, results, solver, sigs, tcx.pathOf(def));
    const body = lowerer.lowerFn(d.node as A.FnItem, def);
    bodies.set(def, body);
    new BodyChecker(body, diags, {
      showTy: (t) => tcx.show(t),
      mayHoldRefs: (t) => lowerer.mayHoldRefs(t),
      borrowOf: lowerer.borrowOf,
    }).check();
  }
  return {
    bodies,
    mirText: (def) => {
      const b = bodies.get(def);
      return b ? bodyToString(b, (t) => tcx.show(t)) : "";
    },
  };
}
