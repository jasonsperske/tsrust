/**
 * # Source files, spans and diagnostics
 *
 * Every stage of the compiler needs to answer the question "where in the
 * user's code did this come from?". We answer it with a {@link Span}: a pair of
 * byte offsets into one source file. Spans flow from tokens into AST nodes,
 * from AST nodes into types and borrow facts, and finally into the error
 * messages a user sees.
 *
 * Diagnostics are modelled on rustc's output:
 *
 * ```text
 * error[E0382]: use of moved value: `s`
 *  --> src/main.rs:4:20
 *   |
 * 4 |     println!("{}", s);
 *   |                    ^ value used here after move
 * ```
 *
 * Stages never throw on the first error. They push diagnostics into a
 * {@link Diagnostics} bag and keep going so the user sees as many problems as
 * possible at once; the driver decides whether to continue to the next stage.
 */

/** A half-open byte range `[start, end)` within the file identified by `file`. */
export interface Span {
  file: number;
  start: number;
  end: number;
}

/** A span that points nowhere. Used for compiler-synthesised nodes. */
export const DUMMY_SPAN: Span = { file: -1, start: 0, end: 0 };

/** Smallest span covering both `a` and `b` (they must be in the same file). */
export function joinSpans(a: Span, b: Span): Span {
  if (a.file !== b.file) return a;
  return { file: a.file, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

/** One loaded source file. `lineStarts` lets us turn offsets into line/column. */
export class SourceFile {
  readonly lineStarts: number[];
  readonly id: number;
  readonly name: string;
  readonly text: string;
  constructor(id: number, name: string, text: string) {
    this.id = id;
    this.name = name;
    this.text = text;
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStarts.push(i + 1);
  }

  /** Convert an offset to a 1-based `{ line, col }`. Binary search over line starts. */
  position(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo] + 1 };
  }

  lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? 0;
    const end = this.lineStarts[line] ?? this.text.length + 1;
    return this.text.slice(start, end - 1).replace(/\r$/, "");
  }
}

/** All files known to one compilation. File ids index into `files`. */
export class SourceMap {
  readonly files: SourceFile[] = [];

  add(name: string, text: string): SourceFile {
    const file = new SourceFile(this.files.length, name, text);
    this.files.push(file);
    return file;
  }

  get(id: number): SourceFile | undefined {
    return this.files[id];
  }

  snippet(span: Span): string {
    const f = this.get(span.file);
    return f ? f.text.slice(span.start, span.end) : "";
  }
}

export type Severity = "error" | "warning" | "note";

/** Which pipeline stage produced a diagnostic. Handy for teaching and for the playground. */
export type Stage = "lex" | "parse" | "crates" | "resolve" | "typeck" | "borrowck" | "codegen" | "emit" | "runtime";

export interface Label {
  span: Span;
  message: string;
  primary: boolean;
}

export interface Diagnostic {
  severity: Severity;
  stage: Stage;
  /** rustc-style error code, e.g. `E0382`. Only set where the meaning genuinely matches rustc's. */
  code?: string;
  message: string;
  labels: Label[];
  notes: string[];
}

/** A builder-style helper so stages can write `diags.error(...).label(...).note(...)`. */
export class DiagnosticBuilder {
  readonly diag: Diagnostic;
  constructor(diag: Diagnostic) {
    this.diag = diag;
  }
  label(span: Span, message: string): this {
    this.diag.labels.push({ span, message, primary: false });
    return this;
  }
  note(message: string): this {
    this.diag.notes.push(`note: ${message}`);
    return this;
  }
  help(message: string): this {
    this.diag.notes.push(`help: ${message}`);
    return this;
  }
}

/** A collection of diagnostics for one compilation. */
export class Diagnostics {
  readonly list: Diagnostic[] = [];

  error(stage: Stage, span: Span, message: string, code?: string): DiagnosticBuilder {
    return this.push("error", stage, span, message, code);
  }

  warning(stage: Stage, span: Span, message: string): DiagnosticBuilder {
    return this.push("warning", stage, span, message);
  }

  private push(severity: Severity, stage: Stage, span: Span, message: string, code?: string): DiagnosticBuilder {
    const diag: Diagnostic = {
      severity,
      stage,
      code,
      message,
      labels: [{ span, message: "", primary: true }],
      notes: [],
    };
    this.list.push(diag);
    return new DiagnosticBuilder(diag);
  }

  get hasErrors(): boolean {
    return this.list.some((d) => d.severity === "error");
  }

  errors(): Diagnostic[] {
    return this.list.filter((d) => d.severity === "error");
  }
}

/**
 * Render a diagnostic the way rustc does: a header, a `-->` location line, and
 * the offending source lines with `^^^` underlines.
 */
export function formatDiagnostic(diag: Diagnostic, sources: SourceMap): string {
  const header = `${diag.severity}${diag.code ? `[${diag.code}]` : ""}: ${diag.message}`;
  const out: string[] = [header];
  const labels = [...diag.labels].filter((l) => sources.get(l.span.file));
  const primary = labels.find((l) => l.primary) ?? labels[0];
  if (primary) {
    const file = sources.get(primary.span.file)!;
    const pos = file.position(primary.span.start);
    const lineNumbers = labels.map((l) => sources.get(l.span.file)!.position(l.span.start).line);
    const gutter = String(Math.max(...lineNumbers)).length;
    const pad = " ".repeat(gutter);
    out.push(`${pad}--> ${file.name}:${pos.line}:${pos.col}`);
    out.push(`${pad} |`);
    // Show labels in source order. Each source line is printed once, followed
    // by one underline row per label on that line.
    labels.sort((a, b) => a.span.file - b.span.file || a.span.start - b.span.start);
    let lastKey = "";
    for (const label of labels) {
      const f = sources.get(label.span.file)!;
      const start = f.position(label.span.start);
      const end = f.position(Math.max(label.span.start, label.span.end - 1));
      const text = f.lineText(start.line);
      const width = start.line === end.line ? Math.max(1, end.col - start.col + 1) : Math.max(1, text.length - start.col + 1);
      const marker = (label.primary ? "^" : "-").repeat(width);
      const key = `${f.id}:${start.line}`;
      if (key !== lastKey) out.push(`${String(start.line).padStart(gutter)} | ${text}`);
      lastKey = key;
      out.push(`${pad} | ${" ".repeat(start.col - 1)}${marker}${label.message ? " " + label.message : ""}`);
    }
  }
  for (const note of diag.notes) out.push(`${" ".repeat(String(primary ? 1 : 0).length)} = ${note}`);
  return out.join("\n");
}

/** Thrown only by the driver to abort the pipeline once a stage has reported errors. */
export class CompileError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(`compilation failed with ${diagnostics.length} error(s)`);
    this.diagnostics = diagnostics;
  }
}
