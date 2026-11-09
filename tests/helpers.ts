import { compileSource, execute, renderDiagnostics, type Compilation } from "../src/driver.ts";

/** Compile and run a program, failing loudly on compile errors. Returns stdout. */
export function runOk(src: string): string {
  const c = compileSource(src);
  if (!c.bytes) throw new Error(`expected program to compile:\n${renderDiagnostics(c)}`);
  return execute(c).stdout;
}

/** Compile a program expected to fail; returns the error codes (and messages) reported. */
export function errorsOf(src: string): { codes: string[]; messages: string[]; c: Compilation } {
  const c = compileSource(src);
  const errs = c.diagnostics.errors();
  return { codes: errs.map((e) => e.code ?? ""), messages: errs.map((e) => e.message), c };
}

/** Wrap statements in `fn main() { ... }`. */
export const main = (body: string, items = "") => `${items}\nfn main() {\n${body}\n}\n`;
