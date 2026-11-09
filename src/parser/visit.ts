/**
 * Generic helpers for walking the AST. Each stage has its own detailed
 * traversal, but sometimes we just need "every child expression" (for example,
 * to find item declarations nested inside function bodies).
 */
import type * as A from "./ast.ts";

/** Call `f` on each direct child expression of `e` (blocks' statements included). */
export function forEachChildExpr(e: A.Expr, f: (child: A.Expr) => void): void {
  switch (e.kind) {
    case "lit": case "path": case "continue": return;
    case "unary": case "ref": case "cast": case "try": case "field": f(e.expr); return;
    case "binary": f(e.left); f(e.right); return;
    case "assign": f(e.target); f(e.value); return;
    case "call": f(e.callee); e.args.forEach(f); return;
    case "methodCall": f(e.receiver); e.args.forEach(f); return;
    case "index": f(e.expr); f(e.index); return;
    case "structLit": e.fields.forEach((x) => f(x.value)); if (e.base) f(e.base); return;
    case "tuple": e.elems.forEach(f); return;
    case "block":
      for (const s of e.stmts) {
        if (s.kind === "let") { if (s.init) f(s.init); }
        else if (s.kind === "expr") f(s.expr);
      }
      if (e.tail) f(e.tail);
      return;
    case "if": f(e.cond); f(e.then); if (e.else) f(e.else); return;
    case "while": f(e.cond); f(e.body); return;
    case "loop": f(e.body); return;
    case "for": f(e.iter); f(e.body); return;
    case "break": case "return": if (e.value) f(e.value); return;
    case "match": f(e.scrutinee); for (const arm of e.arms) { if (arm.guard) f(arm.guard); f(arm.body); } return;
    case "range": if (e.start) f(e.start); if (e.end) f(e.end); return;
    case "macro": e.args.forEach(f); e.format?.args.forEach(f); return;
  }
}

/** Visit every block in `e` (including `e` itself), recursively. */
export function forEachBlock(e: A.Expr, f: (block: A.BlockExpr) => void): void {
  if (e.kind === "block") f(e);
  forEachChildExpr(e, (c) => forEachBlock(c, f));
}

/** Every binding name introduced by a pattern, with the pattern node that introduces it. */
export function patternBindings(p: A.Pattern, out: A.Pattern[] = []): A.Pattern[] {
  switch (p.kind) {
    case "ident": out.push(p); if (p.sub) patternBindings(p.sub, out); break;
    case "tuple": case "tupleStruct": p.elems.forEach((x) => patternBindings(x, out)); break;
    case "struct": p.fields.forEach((x) => patternBindings(x.pat, out)); break;
    case "ref": patternBindings(p.inner, out); break;
    case "or": patternBindings(p.alts[0], out); break;
  }
  return out;
}
