/**
 * # Stage 5: Type checking
 *
 * ```mermaid
 * flowchart TD
 *   R[ResolveResults] --> T[TyCtxt<br/>item signatures, impl index]
 *   T --> W["Well-formedness<br/>• trait impls complete (E0046)<br/>• no infinitely-sized types (E0072)<br/>• derive(Copy) only on Copy fields (E0204)"]
 *   T --> B["Bodies: one FnCtxt per function<br/>inference, method lookup, coercions"]
 *   B --> X["Exhaustiveness<br/>match arms (E0004), let patterns (E0005)"]
 *   W --> OUT[TypeckResults]
 *   X --> OUT
 * ```
 */
import type { Diagnostics } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import { forEachChildExpr } from "../parser/visit.ts";
import type { DefId } from "../resolve/defs.ts";
import type { ResolveResults } from "../resolve/resolver.ts";
import { FnCtxt } from "./check.ts";
import { ExhaustivenessChecker } from "./exhaustive.ts";
import { InferCtxt } from "./infer.ts";
import { emptyResults, type TypeckResults } from "./results.ts";
import { TyCtxt } from "./tcx.ts";
import { TraitSolver } from "./traits.ts";
import { isUnit, substitute, type Ty } from "./types.ts";

export interface TypeckOutput {
  tcx: TyCtxt;
  results: TypeckResults;
}

export function typecheck(res: ResolveResults, diags: Diagnostics): TypeckOutput {
  const tcx = new TyCtxt(res, diags);
  const results = emptyResults();

  checkTraitImpls(tcx);
  checkRecursiveTypes(tcx);
  checkDerives(tcx);

  for (const def of tcx.defs.slice()) {
    if (def.kind === "fn" && def.node && (def.node as A.FnItem).body) {
      new FnCtxt(tcx, def.id, results).checkFn(def.node as A.FnItem);
      results.checkedBodies.push(def.id);
    } else if (def.kind === "const" && def.node) {
      new FnCtxt(tcx, def.id, results).checkConst(def.node as A.ConstItem, tcx.constTy(def.id));
    }
  }

  if (!diags.hasErrors) {
    const ex = new ExhaustivenessChecker(tcx, results, diags);
    for (const def of results.checkedBodies) {
      const fn = tcx.defs[def].node as A.FnItem;
      for (const p of fn.params) ex.checkIrrefutable(p.pat, outerPatTy(results, p.pat), "function argument");
      if (fn.body) walkPatterns(fn.body, results, ex);
    }
  }

  if (res.main !== undefined) {
    const sig = tcx.fnSig(res.main);
    const fn = tcx.defs[res.main].node as A.FnItem;
    if (sig.params.length || !isUnit(sig.ret) || fn.generics.params.length) {
      diags.error("typeck", fn.nameSpan, "`main` function has wrong type", "E0580")
        .note("expected signature `fn main()`");
    }
  }
  return { tcx, results };
}

/** The type a pattern was matched against, before match-ergonomics derefs. */
function outerPatTy(r: TypeckResults, p: A.Pattern): Ty | undefined {
  let t = r.types.get(p.id);
  if (!t) return undefined;
  for (let i = 0; i < (r.patDerefs.get(p.id) ?? 0); i++) t = { k: "ref", mutable: false, inner: t };
  return t;
}

function walkPatterns(e: A.Expr, r: TypeckResults, ex: ExhaustivenessChecker) {
  if (e.kind === "match") ex.checkMatch(e);
  if (e.kind === "for") ex.checkIrrefutable(e.pat, outerPatTy(r, e.pat), "`for` loop binding");
  if (e.kind === "block") {
    for (const s of e.stmts) if (s.kind === "let") ex.checkIrrefutable(s.pat, outerPatTy(r, s.pat), "local binding");
  }
  forEachChildExpr(e, (c) => walkPatterns(c, r, ex));
}

/** Every trait impl must provide each required method and associated type, and nothing extra. */
function checkTraitImpls(tcx: TyCtxt) {
  for (const impl of tcx.res.impls) {
    const header = tcx.implHeader(impl);
    if (!header?.trait) {
      const node = tcx.defs[impl].node as A.ImplItem;
      for (const t of node.assocTypes) tcx.diags.error("typeck", t.span, "associated types are not allowed in inherent impls", "E0202");
      continue;
    }
    const node = tcx.defs[impl].node as A.ImplItem;
    const trait = header.trait.trait;
    const traitNode = tcx.defs[trait].node as A.TraitItem;
    const info = tcx.traitInfo(trait);
    const missing: string[] = [];
    for (const m of traitNode.items) {
      if (!m.body && !node.items.some((f) => f.name === m.name)) missing.push(`\`${m.name}\``);
    }
    for (const t of traitNode.assocTypes) {
      if (!node.assocTypes.some((x) => x.name === t.name)) missing.push(`\`${t.name}\``);
    }
    if (missing.length) {
      tcx.diags.error("typeck", node.span, `not all trait items implemented, missing: ${missing.join(", ")}`, "E0046")
        .help(`implement the missing item${missing.length > 1 ? "s" : ""} in this \`impl ${tcx.nameOf(trait)} for ${tcx.show(header.selfTy)}\``);
    }
    for (const f of node.items) {
      const traitMethod = info.methods.get(f.name);
      if (traitMethod === undefined) {
        tcx.diags.error("typeck", f.nameSpan, `method \`${f.name}\` is not a member of trait \`${tcx.nameOf(trait)}\``, "E0407");
        continue;
      }
      const tm = tcx.defs[traitMethod].node as A.FnItem;
      if (!!tm.selfParam !== !!f.selfParam) {
        tcx.diags.error("typeck", f.nameSpan, tm.selfParam
          ? `method \`${f.name}\` has a \`self\` declaration in the trait, but not in the impl`
          : `method \`${f.name}\` has a \`self\` declaration in the impl, but not in the trait`, tm.selfParam ? "E0186" : "E0185");
      } else if (tm.params.length !== f.params.length) {
        tcx.diags.error("typeck", f.nameSpan, `method \`${f.name}\` has ${f.params.length + (f.selfParam ? 1 : 0)} parameter(s) but the declaration in trait \`${tcx.nameOf(trait)}\` has ${tm.params.length + (tm.selfParam ? 1 : 0)}`, "E0050");
      } else {
        compareMethodSigs(tcx, impl, traitMethod, tcx.res.defOfNode.get(f.id)!, header.selfTy, header.trait.args);
      }
    }
    for (const t of node.assocTypes) {
      if (!info.assocTypes.has(t.name)) tcx.diags.error("typeck", t.nameSpan, `type \`${t.name}\` is not a member of trait \`${tcx.nameOf(trait)}\``, "E0437");
    }
  }
}

/** E0053: the impl's method types must match the trait's, with `Self` replaced by the impl's type. */
function compareMethodSigs(tcx: TyCtxt, impl: DefId, traitMethod: DefId, implMethod: DefId, selfTy: Ty, traitArgs: Ty[]) {
  const trait = tcx.defs[traitMethod].parent!;
  const info = tcx.traitInfo(trait);
  const traitParams = tcx.allParams(trait);
  const subst = new Map<DefId, Ty>([[info.selfParam, selfTy], ...traitParams.slice(1).map((p, i) => [p, traitArgs[i]] as [DefId, Ty])]);
  // Method-level generics correspond by position.
  const tOwn = tcx.res.genericsOf.get(traitMethod) ?? [];
  const iOwn = tcx.res.genericsOf.get(implMethod) ?? [];
  tOwn.forEach((p, i) => { if (iOwn[i] !== undefined) subst.set(p, tcx.paramTy(iOwn[i])); });
  const ts = tcx.fnSig(traitMethod), is = tcx.fnSig(implMethod);
  const infcx = new InferCtxt();
  const solver = new TraitSolver(tcx, infcx, tcx.predicates(implMethod));
  const norm = (t: Ty) => solver.normalizeDeep(t, () => undefined);
  const pairs: [Ty, Ty, string][] = [
    ...ts.params.map((p, i) => [substitute(p, subst), is.params[i], `parameter ${i + 1}`] as [Ty, Ty, string]),
    [substitute(ts.ret, subst), is.ret, "return type"],
  ];
  for (const [expected, actual, what] of pairs) {
    if (!actual) continue;
    const e = norm(expected), a = norm(actual);
    if (!infcx.unify(e, a)) {
      const fn = tcx.defs[implMethod].node as A.FnItem;
      tcx.diags.error("typeck", fn.nameSpan, `method \`${fn.name}\` has an incompatible type for trait`, "E0053")
        .note(`${what}: expected \`${tcx.show(e)}\`, found \`${tcx.show(a)}\``);
      return;
    }
  }
  void impl;
}

/** A struct that contains itself by value would need infinite memory (E0072). */
function checkRecursiveTypes(tcx: TyCtxt) {
  for (const def of tcx.defs) {
    if ((def.kind !== "struct" && def.kind !== "enum") || tcx.isNativeAdt(def.id)) continue;
    const visiting = new Set<string>();
    const reaches = (t: Ty): boolean => {
      if (t.k === "tuple") return t.elems.some(reaches);
      if (t.k !== "adt" || tcx.isNativeAdt(t.def)) return false; // refs, Box, Vec: indirection
      if (t.def === def.id) return true;
      const key = `${t.def}:${JSON.stringify(t.args)}`;
      if (visiting.has(key)) return false;
      visiting.add(key);
      // Look through generic containers: `Option<Node>` stores a `Node` inline.
      const subst = new Map((tcx.res.genericsOf.get(t.def) ?? []).map((p, i) => [p, t.args[i]]));
      return tcx.variants(t.def).some((v) => v.fields.some((f) => reaches(substitute(f.ty, subst))));
    };
    if (tcx.variants(def.id).some((v) => v.fields.some((f) => reaches(f.ty)))) {
      tcx.diags.error("typeck", def.span, `recursive type \`${def.name}\` has infinite size`, "E0072")
        .help(`insert some indirection (e.g., a \`Box\`) to break the cycle: \`Box<${def.name}>\``);
    }
  }
}

/** `#[derive(Copy)]` requires every field to be Copy (E0204) and the type to be Clone. */
function checkDerives(tcx: TyCtxt) {
  const copy = tcx.res.lang.get("Copy"), clone = tcx.res.lang.get("Clone");
  if (copy === undefined || clone === undefined) return;
  for (const [adt, traits] of tcx.derives) {
    if (!traits.has(copy)) continue;
    if (!traits.has(clone)) {
      tcx.diags.error("typeck", tcx.defs[adt].span, `the trait bound \`${tcx.defs[adt].name}: Clone\` is not satisfied`, "E0277")
        .note("`Copy` requires `Clone`: add `Clone` to the derive list");
    }
    // Assume each type parameter is Copy, as the derived impl's where-clause will.
    const params = tcx.res.genericsOf.get(adt) ?? [];
    const infcx = new InferCtxt();
    const solver: TraitSolver = new TraitSolver(tcx, infcx, params.map((p) => ({ kind: "trait" as const, self: tcx.paramTy(p), trait: copy, args: [] })));
    for (const v of tcx.variants(adt)) {
      for (const f of v.fields) {
        if (!solver.holds(f.ty, copy)) {
          tcx.diags.error("typeck", tcx.defs[adt].span, "the trait `Copy` cannot be implemented for this type", "E0204")
            .label(f.span, `this field does not implement \`Copy\` (its type is \`${tcx.show(f.ty)}\`)`)
            .note("a `Copy` type is duplicated bit-for-bit, so it may only contain other `Copy` types");
        }
      }
    }
  }
  const def = tcx.res.lang.get("Default");
  for (const [adt, traits] of tcx.derives) {
    if (def !== undefined && traits.has(def)) {
      tcx.diags.error("typeck", tcx.defs[adt].span, "`#[derive(Default)]` is not supported by TSRust yet")
        .help("write `impl Default for ... { fn default() -> Self { ... } }` by hand");
    }
  }
}
