/**
 * # The compiler driver
 *
 * The driver runs each stage in order and stops at the first stage that
 * reports errors (later stages assume earlier ones succeeded).
 *
 * ```mermaid
 * flowchart LR
 *   SRC[(source files)] --> CR["crates<br/>(lex + parse each file)"]
 *   CR --> RS[resolve] --> TC[typeck] --> BC[borrowck] --> CG[codegen] --> BW[bytecode writer]
 *   BW --> BIN[(.tsrb bytes)] --> VM[VM]
 * ```
 *
 * Every stage's output is kept on the {@link Compilation} object, so tools
 * like the playground can show tokens, the AST, inferred types, borrow-check
 * facts and the final bytecode side by side.
 */
import { CompileError, Diagnostics, SourceMap, formatDiagnostic, type Diagnostic, type Stage } from "./diagnostics.ts";
import { MemoryFileSystem, type FileSystem } from "./crates/fs.ts";
import { loadCrates, type CrateGraph } from "./crates/loader.ts";
import { NodeIdGen } from "./parser/ast.ts";
import { resolve, type ResolveResults } from "./resolve/resolver.ts";
import { typecheck, type TypeckOutput } from "./typeck/index.ts";
import { borrowck, type BorrowckOutput } from "./borrowck/index.ts";
import { generate } from "./codegen/codegen.ts";
import type { Program } from "./bytecode/program.ts";
import { readProgram, writeProgram } from "./bytecode/writer.ts";
import { run, type RunOptions, type RunResult } from "./vm/vm.ts";

export interface CompileOptions {
  fs: FileSystem;
  /** A package directory (with `Cargo.toml`) or a single `.rs` file. */
  entry: string;
  /** Stop after this stage (useful for teaching and tests). */
  stopAfter?: Stage;
}

export interface Compilation {
  sources: SourceMap;
  diagnostics: Diagnostics;
  /** Milliseconds spent in each stage. */
  timings: Partial<Record<Stage, number>>;
  graph?: CrateGraph;
  resolved?: ResolveResults;
  typeck?: TypeckOutput;
  borrowck?: BorrowckOutput;
  program?: Program;
  /** The serialized `.tsrb` bytecode. */
  bytes?: Uint8Array;
  /** Stage that failed, if any. */
  failedAt?: Stage;
}

export function compile(opts: CompileOptions): Compilation {
  const sources = new SourceMap();
  const diagnostics = new Diagnostics();
  const c: Compilation = { sources, diagnostics, timings: {} };
  const ids = new NodeIdGen();

  const run_ = <T>(stage: Stage, f: () => T): T | undefined => {
    const start = performance.now();
    const out = f();
    c.timings[stage] = performance.now() - start;
    if (diagnostics.hasErrors || out === undefined) {
      c.failedAt = stage;
      return undefined;
    }
    return out;
  };

  c.graph = run_("crates", () => loadCrates({ fs: opts.fs, entry: opts.entry, sources, diags: diagnostics, ids }));
  if (!c.graph || opts.stopAfter === "crates" || opts.stopAfter === "parse") return c;
  c.resolved = run_("resolve", () => resolve(c.graph!, diagnostics));
  if (!c.resolved || opts.stopAfter === "resolve") return c;
  c.typeck = run_("typeck", () => typecheck(c.resolved!, diagnostics));
  if (!c.typeck || opts.stopAfter === "typeck") return c;
  // Keep the MIR even if borrow checking fails: it's the best way to understand the error.
  let mir: BorrowckOutput | undefined;
  c.borrowck = run_("borrowck", () => (mir = borrowck(c.typeck!, diagnostics)));
  if (!c.borrowck) { c.borrowck = mir; return c; }
  if (opts.stopAfter === "borrowck") return c;
  c.program = run_("codegen", () => generate(c.typeck!, sources, diagnostics));
  if (!c.program || opts.stopAfter === "codegen") return c;
  c.bytes = run_("emit", () => writeProgram(c.program!));
  return c;
}

/** Convenience: compile a single source string as `main.rs`. */
export function compileSource(text: string, stopAfter?: Stage): Compilation {
  return compile({ fs: new MemoryFileSystem({ "/main.rs": text }), entry: "/main.rs", stopAfter });
}

/**
 * Run a successful compilation. The program is read back from its serialized
 * bytes first, proving the `.tsrb` file contains everything needed.
 */
export function execute(c: Compilation, opts: RunOptions = {}): RunResult {
  if (!c.bytes) throw new Error("nothing to run: compilation failed");
  const start = performance.now();
  const result = run(readProgram(c.bytes), opts);
  c.timings.runtime = performance.now() - start;
  return result;
}

export function renderDiagnostics(c: Compilation, list: Diagnostic[] = c.diagnostics.list): string {
  return list.map((d) => formatDiagnostic(d, c.sources)).join("\n\n");
}

export { CompileError };
