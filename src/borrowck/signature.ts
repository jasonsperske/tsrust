/**
 * # Lifetimes in signatures
 *
 * Inside a function, the borrow checker can see every borrow. *Across* a
 * call it can't look into the callee, so it trusts the callee's
 * **signature**. Lifetimes in the signature say which arguments the result
 * may borrow from:
 *
 * ```rust
 * fn longest<'a>(x: &'a str, y: &'a str) -> &'a str   // result borrows from x AND y
 * fn first_word(s: &str) -> &str                       // elided: result borrows from s
 * fn len(v: &Vec<i32>) -> usize                        // no references out: borrows nothing
 * ```
 *
 * ## Lifetime elision
 *
 * Writing every lifetime would be noisy, so Rust fills in output lifetimes
 * using three rules:
 *
 * 1. Each elided input lifetime becomes a distinct lifetime parameter.
 * 2. If there is exactly one input lifetime, it is used for all elided outputs.
 * 3. If there is a `&self` or `&mut self`, its lifetime is used for all elided outputs.
 *
 * Otherwise an elided output lifetime is ambiguous: **E0106 missing lifetime
 * specifier**.
 *
 * ```mermaid
 * flowchart TD
 *   A{"return type has an<br/>elided lifetime?"} -- no --> OK[fine]
 *   A -- yes --> B{"&self or &mut self?"}
 *   B -- yes --> S["use self's lifetime"]
 *   B -- no --> C{"exactly one<br/>input lifetime?"}
 *   C -- yes --> U[use it]
 *   C -- no --> E["error E0106:<br/>missing lifetime specifier"]
 * ```
 *
 * ## Flows
 *
 * From the (elided-and-resolved) signature we compute, for each parameter,
 * an {@link ArgFlow}:
 *
 * - `full`: the result may hold the argument itself (and whatever it borrows).
 *   `fn get(&self) -> Option<&T>`: the result keeps `self` borrowed.
 * - `inner`: the result may hold what the argument *points to* borrows, but
 *   not the reference itself. `fn next(&mut self) -> Option<Self::Item>` on
 *   `Iter<'a, T>` returns `&'a T`: it borrows the vector, not the iterator.
 * - `none`: the result is independent of the argument.
 */
import type { Diagnostics } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { DefId } from "../resolve/defs.ts";
import type { TyCtxt } from "../typeck/tcx.ts";
import type { ArgFlow } from "./mir.ts";

export interface FlowSig {
  /** One entry per parameter, `self` first. */
  flows: ArgFlow[];
}

interface Names {
  lifetimes: Set<string>;
  params: Set<string>;
}

export class SignatureChecker {
  private readonly cache = new Map<DefId, FlowSig>();
  private elidedCounter = 0;
  private readonly tcx: TyCtxt;
  private readonly diags: Diagnostics;

  constructor(tcx: TyCtxt, diags: Diagnostics) {
    this.tcx = tcx;
    this.diags = diags;
  }

  flowSig(def: DefId): FlowSig {
    const cached = this.cache.get(def);
    if (cached) return cached;
    const sig = this.compute(def, false);
    this.cache.set(def, sig);
    return sig;
  }

  /** Check every user function's signature for E0106/E0261. */
  checkAll() {
    for (const d of this.tcx.defs) {
      if (d.kind !== "fn" || !d.node || this.tcx.res.defs[d.id] === undefined) continue;
      const crate = d.crate;
      if (this.tcx.res.crateRoots[crate] !== undefined && this.isStdCrate(crate)) continue;
      this.compute(d.id, true);
    }
  }

  private isStdCrate(crate: number): boolean {
    return this.tcx.defs[this.tcx.res.crateRoots[crate]].name === "std";
  }

  /** Lifetimes declared on the fn and its impl/trait. */
  private declaredLifetimes(def: DefId): Set<string> {
    const out = new Set<string>(["static", "_"]);
    const fn = this.tcx.defs[def].node as A.FnItem;
    fn.generics.lifetimes.forEach((l) => out.add(l));
    const parent = this.tcx.defs[def].parent;
    if (parent !== undefined) {
      const p = this.tcx.defs[parent];
      if (p.kind === "impl" || p.kind === "trait") (p.node as A.ImplItem | A.TraitItem).generics.lifetimes.forEach((l) => out.add(l));
    }
    return out;
  }

  /** Lifetime and type-parameter names mentioned in a type. Elided lifetimes get fresh names `'_N`. */
  private names(t: A.TypeExpr, report: boolean, declared: Set<string>): Names & { elided: string[] } {
    const out = { lifetimes: new Set<string>(), params: new Set<string>(), elided: [] as string[] };
    const fresh = () => {
      const n = `_${this.elidedCounter++}`;
      out.elided.push(n);
      out.lifetimes.add(n);
    };
    const useLt = (l: string, span: A.TypeExpr["span"]) => {
      if (l === "_") { fresh(); return; }
      if (report && !declared.has(l)) {
        this.diags.error("borrowck", span, `use of undeclared lifetime name \`'${l}\``, "E0261")
          .help(`consider introducing lifetime \`'${l}\` here: \`fn name<'${l}>(...)\``);
      }
      if (l !== "static") out.lifetimes.add(l);
    };
    const go = (t: A.TypeExpr) => {
      switch (t.kind) {
        case "ref":
          if (t.lifetime) useLt(t.lifetime, t.span);
          else fresh();
          go(t.inner);
          break;
        case "tuple": t.elems.forEach(go); break;
        case "qpath": go(t.self); break;
        case "path": {
          const pr = this.tcx.res.paths.get(t.path.id);
          const last = t.path.segments[t.path.segments.length - 1];
          if (pr?.base.kind === "selfTy") out.params.add("Self");
          if (pr?.base.kind === "def") {
            const d = this.tcx.defs[pr.base.def];
            if (d.kind === "tyParam") out.params.add(d.name);
            if (d.kind === "struct" || d.kind === "enum") {
              const declaredLts = (d.node as A.StructItem | A.EnumItem).generics.lifetimes.length;
              const written = last.lifetimes ?? [];
              written.forEach((l) => useLt(l, t.span));
              for (let i = written.length; i < declaredLts; i++) fresh();
            }
          }
          for (const seg of t.path.segments) seg.generics?.forEach(go);
          break;
        }
      }
    };
    go(t);
    return out;
  }

  private compute(def: DefId, report: boolean): FlowSig {
    const fn = this.tcx.defs[def].node as A.FnItem;
    const declared = this.declaredLifetimes(def);
    const parent = this.tcx.defs[def].parent;
    const implSelf = parent !== undefined && this.tcx.defs[parent].kind === "impl" ? (this.tcx.defs[parent].node as A.ImplItem).selfTy : undefined;

    // Inputs.
    type Input = { outer?: string; inner: Names; isRef: boolean };
    const inputs: Input[] = [];
    const allInputLts: string[] = [];
    let selfLt: string | undefined;
    if (fn.selfParam) {
      const inner: Names = { lifetimes: new Set(), params: new Set(["Self"]) };
      if (implSelf) {
        const n = this.names(implSelf, false, declared);
        n.lifetimes.forEach((l) => inner.lifetimes.add(l));
        n.params.forEach((p) => inner.params.add(p));
      }
      if (fn.selfParam.kind === "value") {
        inputs.push({ inner, isRef: false });
      } else {
        selfLt = `_self${this.elidedCounter++}`;
        inputs.push({ outer: selfLt, inner, isRef: true });
        allInputLts.push(selfLt);
      }
      inner.lifetimes.forEach((l) => allInputLts.push(l));
    }
    for (const p of fn.params) {
      if (p.ty.kind === "ref") {
        const outer = p.ty.lifetime && p.ty.lifetime !== "_" ? p.ty.lifetime : `_${this.elidedCounter++}`;
        if (p.ty.lifetime && p.ty.lifetime !== "_" && report && !declared.has(p.ty.lifetime)) this.names(p.ty, report, declared);
        const inner = this.names(p.ty.inner, report, declared);
        inputs.push({ outer, inner, isRef: true });
        if (outer !== "static") allInputLts.push(outer);
        inner.lifetimes.forEach((l) => allInputLts.push(l));
      } else {
        const n = this.names(p.ty, report, declared);
        inputs.push({ inner: n, isRef: false });
        n.lifetimes.forEach((l) => allInputLts.push(l));
      }
    }

    // Output.
    const ret = fn.ret ? this.names(fn.ret, report, declared) : { lifetimes: new Set<string>(), params: new Set<string>(), elided: [] };
    if (ret.elided.length) {
      const unique = [...new Set(allInputLts)];
      let target: string | undefined;
      if (selfLt) target = selfLt;
      else if (unique.length === 1) target = unique[0];
      if (target) {
        for (const e of ret.elided) ret.lifetimes.delete(e);
        ret.lifetimes.add(target);
      } else if (report && fn.ret) {
        const b = this.diags.error("borrowck", fn.ret.span, "missing lifetime specifier", "E0106");
        b.diag.labels[0].message = "expected named lifetime parameter";
        if (unique.length === 0) {
          b.help("this function's return type contains a borrowed value, but there is no value for it to be borrowed from")
            .help("consider using the `'static` lifetime, or returning an owned value like `String`");
        } else {
          const names = fn.params.filter((p) => p.ty.kind === "ref").map((p) => (p.pat.kind === "ident" ? `\`${p.pat.name}\`` : "an argument"));
          b.help(`this function's return type contains a borrowed value, but the signature does not say whether it is borrowed from ${names.join(" or ")}`)
            .help("consider introducing a named lifetime parameter: `fn name<'a>(x: &'a T, y: &'a T) -> &'a T`");
        }
      }
    }
    const retNames = new Set([...ret.lifetimes, ...ret.params]);
    const flows: ArgFlow[] = inputs.map((inp) => {
      if (inp.isRef && inp.outer && retNames.has(inp.outer)) return "full";
      const innerHit = [...inp.inner.lifetimes, ...inp.inner.params].some((n) => retNames.has(n));
      if (!innerHit) return "none";
      return inp.isRef ? "inner" : "full";
    });
    return { flows };
  }
}
