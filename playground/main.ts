/**
 * The TSRust browser playground.
 *
 * Everything runs locally in the page: the compiler, the standard library
 * (embedded as source), and the VM. Each run shows every stage's output in a
 * tab, so you can watch your program travel through the pipeline.
 */
import { compile, execute, renderDiagnostics, type Compilation } from "../src/driver.ts";
import { MemoryFileSystem } from "../src/crates/fs.ts";
import { Diagnostics, formatDiagnostic, type Diagnostic } from "../src/diagnostics.ts";
import { lex } from "../src/lexer/lexer.ts";
import { KEYWORDS, type Token } from "../src/lexer/token.ts";
import { disassemble, isStdFunction } from "../src/bytecode/program.ts";
import { buildExecutable, NativeError, type Target } from "../src/native/index.ts";
import { EXAMPLES, type Example } from "./examples.generated.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const source = $<HTMLTextAreaElement>("source");
const highlight = $<HTMLPreElement>("highlight");
const gutter = $<HTMLPreElement>("gutter");
const exampleSelect = $<HTMLSelectElement>("example");
const fileSelect = $<HTMLSelectElement>("file");
const filePicker = $<HTMLLabelElement>("file-picker");
const status = $<HTMLSpanElement>("status");
const tabsEl = $<HTMLDivElement>("tabs");
const tabBody = $<HTMLDivElement>("tab-body");
const downloadBtn = $<HTMLButtonElement>("download");
const downloadExeBtn = $<HTMLButtonElement>("download-exe");
const targetSelect = $<HTMLSelectElement>("target");
// Default the target to the visitor's operating system.
targetSelect.value = /Win/.test(navigator.userAgent) ? "windows" : /Mac/.test(navigator.userAgent) ? "macos" : "linux";

// ---------------------------------------------------------------------------
// Program state: one or more files, one of which is being edited.
// ---------------------------------------------------------------------------

interface Project {
  files: Record<string, string>;
  entry: string;
  current: string;
  name: string;
}

let project: Project = { files: {}, entry: "/main.rs", current: "/main.rs", name: "main" };
let last: Compilation | undefined;
let lastRun: { stdout: string; stderr: string; exitCode: number; steps: number } | undefined;

function loadExample(ex: Example) {
  project = { files: { ...ex.files }, entry: ex.entry, current: ex.open, name: ex.name };
  filePicker.hidden = Object.keys(ex.files).filter((f) => f.endsWith(".rs")).length < 2 && !Object.keys(ex.files).some((f) => f.endsWith(".toml"));
  fileSelect.innerHTML = "";
  for (const path of Object.keys(ex.files).sort()) {
    const opt = document.createElement("option");
    opt.value = path;
    opt.textContent = path.replace(/^\//, "");
    fileSelect.append(opt);
  }
  fileSelect.value = project.current;
  showFile(project.current);
}

function showFile(path: string) {
  project.current = path;
  source.value = project.files[path] ?? "";
  refreshEditor();
}

// ---------------------------------------------------------------------------
// Editor: a textarea over a syntax-highlighted <pre>, highlighted by TSRust's own lexer.
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PRIMITIVE_TYPES = new Set(["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "bool", "char", "str", "String", "Vec", "Option", "Result", "Box", "HashMap", "Self"]);

function tokenClass(t: Token, next: Token | undefined): string {
  switch (t.kind) {
    case "keyword": return t.value === "true" || t.value === "false" ? "tok-lit" : "tok-kw";
    case "int": case "float": return "tok-num";
    case "string": case "char": return "tok-str";
    case "lifetime": return "tok-life";
    case "ident":
      if (next?.kind === "punct" && next.value === "!") return "tok-macro";
      if (PRIMITIVE_TYPES.has(String(t.value)) || /^[A-Z]/.test(String(t.value))) return "tok-type";
      if (next?.kind === "punct" && next.value === "(") return "tok-fn";
      return "";
    default: return "";
  }
}

function highlightRust(text: string, marks: { start: number; end: number; cls: string }[] = []): string {
  const toks = lex(text, 0, new Diagnostics());
  let out = "";
  let pos = 0;
  const pending = [...marks].sort((a, b) => a.start - b.start);
  const emitPlain = (to: number) => {
    // Gaps between tokens are whitespace and comments.
    const gap = text.slice(pos, to);
    out += gap.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|([^/]+|\/)/g, (m, comment) => (comment ? `<span class="tok-comment">${escapeHtml(m)}</span>` : escapeHtml(m)));
    pos = to;
  };
  toks.forEach((t, i) => {
    if (t.kind === "eof") return;
    emitPlain(t.span.start);
    const cls = tokenClass(t, toks[i + 1]);
    const mark = pending.find((m) => t.span.start < m.end && t.span.end > m.start);
    const classes = [cls, mark?.cls].filter(Boolean).join(" ");
    const body = escapeHtml(text.slice(t.span.start, t.span.end));
    out += classes ? `<span class="${classes}">${body}</span>` : body;
    pos = t.span.end;
  });
  emitPlain(text.length);
  return out + "\n";
}

let errorMarks: { start: number; end: number; cls: string }[] = [];

function refreshEditor() {
  project.files[project.current] = source.value;
  highlight.innerHTML = project.current.endsWith(".rs") ? highlightRust(source.value, errorMarks) : escapeHtml(source.value) + "\n";
  const lines = source.value.split("\n").length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n");
  syncScroll();
}

function syncScroll() {
  highlight.scrollTop = source.scrollTop;
  highlight.scrollLeft = source.scrollLeft;
  gutter.scrollTop = source.scrollTop;
}

source.addEventListener("input", () => {
  errorMarks = [];
  refreshEditor();
});
source.addEventListener("scroll", syncScroll);
source.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: end } = source;
    source.setRangeText("    ", s, end, "end");
    refreshEditor();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void build(!e.shiftKey);
  } else if (e.key === "Enter") {
    // Keep the current line's indentation.
    const before = source.value.slice(0, source.selectionStart);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const indent = /^\s*/.exec(line)![0] + (/[{(\[]\s*$/.test(line) ? "    " : "");
    e.preventDefault();
    source.setRangeText("\n" + indent, source.selectionStart, source.selectionEnd, "end");
    refreshEditor();
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type TabId = "output" | "diagnostics" | "tokens" | "ast" | "types" | "mir" | "bytecode" | "native" | "pipeline";
const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "output", label: "Output", hint: "What the program printed" },
  { id: "diagnostics", label: "Diagnostics", hint: "Errors and warnings, rustc-style" },
  { id: "tokens", label: "Tokens", hint: "Stage 1: the lexer's output" },
  { id: "ast", label: "AST", hint: "Stage 2: the parser's syntax tree" },
  { id: "types", label: "Types", hint: "Stage 5: every variable's inferred type" },
  { id: "mir", label: "MIR", hint: "Stage 6: the control-flow graph the borrow checker analyzes" },
  { id: "bytecode", label: "Bytecode", hint: "Stage 7: the stack-machine code the VM runs" },
  { id: "native", label: "Native", hint: "Stage 10: x86-64 machine code and the executable's layout" },
  { id: "pipeline", label: "Pipeline", hint: "Crate graph and time spent in each stage" },
];
let activeTab: TabId = "output";

for (const t of TABS) {
  const b = document.createElement("button");
  b.role = "tab";
  b.id = `tab-${t.id}`;
  b.textContent = t.label;
  b.title = t.hint;
  b.addEventListener("click", () => selectTab(t.id));
  tabsEl.append(b);
}

function selectTab(id: TabId) {
  activeTab = id;
  for (const t of TABS) $(`tab-${t.id}`).setAttribute("aria-selected", String(t.id === id));
  renderTab();
}

function pre(text: string, cls = ""): string {
  return `<pre class="out ${cls}">${escapeHtml(text)}</pre>`;
}

function note(html: string): string {
  return `<p class="tab-note">${html}</p>`;
}

/** Diagnostics with colored headers. */
function renderDiagnosticsHtml(c: Compilation, list: Diagnostic[]): string {
  if (!list.length) return note("No errors or warnings.");
  return list.map((d) => {
    const text = escapeHtml(formatDiagnostic(d, c.sources))
      .replace(/^(error(\[E\d+\])?)/, `<span class="diag-error">$1</span>`)
      .replace(/^(warning)/, `<span class="diag-warning">$1</span>`)
      .replace(/\[(E\d{4})\]/, `[<a href="https://doc.rust-lang.org/error_codes/$1.html" target="_blank" rel="noopener">$1</a>]`);
    return `<pre class="out diag">${text}</pre>`;
  }).join("");
}

function astTree(value: unknown, key?: string, depth = 0): string {
  const label = key !== undefined ? `<span class="ast-key">${escapeHtml(key)}</span>: ` : "";
  if (value === null || typeof value !== "object") {
    return `<div class="ast-leaf">${label}<span class="ast-val">${escapeHtml(String(JSON.stringify(value)))}</span></div>`;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value).filter(([k]) => !["span", "nameSpan", "id", "methodSpan"].includes(k));
  const kind = !Array.isArray(value) && "kind" in (value as object) ? ` <span class="ast-kind">${escapeHtml(String((value as { kind: unknown }).kind))}${"name" in (value as object) ? " " + escapeHtml(String((value as { name: unknown }).name)) : ""}</span>` : "";
  const summary = Array.isArray(value) ? `${label}<span class="ast-dim">[${value.length}]</span>` : `${label}${kind || '<span class="ast-dim">{…}</span>'}`;
  if (entries.length === 0) return `<div class="ast-leaf">${summary}</div>`;
  return `<details ${depth < 2 ? "open" : ""}><summary>${summary}</summary>${entries.map(([k, v]) => astTree(v, k, depth + 1)).join("")}</details>`;
}

function isUserFile(c: Compilation, file: number): boolean {
  const name = c.sources.get(file)?.name ?? "";
  return !name.startsWith("/__std__");
}

function renderTab() {
  try {
    renderTabInner();
  } catch (e) {
    console.error(e);
    tabBody.innerHTML = pre(`Internal error while rendering this tab: ${(e as Error).message}`, "stderr");
  }
}

function renderTabInner() {
  const c = last;
  let html = "";
  switch (activeTab) {
    case "output": {
      if (!c) { html = note("Press <b>Run</b> (or Ctrl+Enter) to compile and run your program."); break; }
      if (c.failedAt) {
        html = note(`Compilation failed during <b>${c.failedAt}</b>. See the Diagnostics tab.`) + renderDiagnosticsHtml(c, c.diagnostics.list);
        break;
      }
      if (!lastRun) { html = note("Checked successfully: no errors. Press <b>Run</b> to execute."); break; }
      html = (lastRun.stdout ? pre(lastRun.stdout) : note("(the program printed nothing)")) +
        (lastRun.stderr ? pre(lastRun.stderr, "stderr") : "") +
        note(`Process exited with code ${lastRun.exitCode} after ${lastRun.steps.toLocaleString()} VM instructions.`);
      break;
    }
    case "diagnostics":
      html = c ? renderDiagnosticsHtml(c, c.diagnostics.list) : note("Nothing compiled yet.");
      break;
    case "tokens": {
      const text = project.files[project.current] ?? "";
      if (!project.current.endsWith(".rs")) { html = note("Select a .rs file to see its tokens."); break; }
      const toks = lex(text, 0, new Diagnostics());
      const rows = toks.slice(0, 2000).map((t) => {
        const pos = lineCol(text, t.span.start);
        return `<tr><td class="num">${pos}</td><td><span class="pill pill-${t.kind}">${t.kind}</span></td><td><code>${escapeHtml(t.text)}</code></td><td class="ast-dim">${t.suffix ? `suffix ${t.suffix}` : t.kind === "keyword" || t.kind === "ident" || t.kind === "punct" ? "" : escapeHtml(JSON.stringify(t.value))}</td></tr>`;
      });
      html = note(`${toks.length} tokens in <code>${escapeHtml(project.current)}</code>. Whitespace and comments are skipped.`) +
        `<table class="grid"><thead><tr><th>line:col</th><th>kind</th><th>text</th><th>value</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
      break;
    }
    case "ast": {
      if (!c?.graph) { html = note("Run or check the program to see its AST."); break; }
      const root = c.graph.crates[c.graph.root];
      html = note(`Items of crate <code>${escapeHtml(root.name)}</code>. Spans and node ids are hidden.`) + `<div class="ast">${astTree(root.items)}</div>`;
      break;
    }
    case "types": {
      if (!c?.typeck) { html = note(c ? "Type checking didn't complete; fix earlier errors first." : "Run or check the program to see inferred types."); break; }
      const { tcx, results } = c.typeck;
      const rows: string[] = [];
      const locals = [...results.locals.values()].filter((l) => isUserFile(c, l.span.file)).sort((a, b) => a.span.file - b.span.file || a.span.start - b.span.start);
      for (const l of locals) {
        const f = c.sources.get(l.span.file)!;
        const p = f.position(l.span.start);
        rows.push(`<tr><td class="num">${escapeHtml(f.name.replace(/^\//, ""))}:${p.line}</td><td><code>${l.mutable ? "mut " : ""}${escapeHtml(l.name)}</code></td><td><code class="ty">${escapeHtml(tcx.show(l.ty))}</code></td></tr>`);
      }
      html = note("Every variable binding and the type the checker inferred for it.") + `<table class="grid"><thead><tr><th>where</th><th>binding</th><th>type</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
      break;
    }
    case "mir": {
      if (!c?.borrowck) { html = note(c ? "Borrow checking didn't run; fix earlier errors first." : "Run or check the program to see its MIR."); break; }
      const texts = [...c.borrowck.bodies.keys()].map((d) => c.borrowck!.mirText(d));
      html = note("Each function lowered to a control-flow graph. Every <code>&amp;</code> creates a numbered loan; the borrow checker tracks which locals hold each loan and where they are still live.") + pre(texts.join("\n\n"));
      break;
    }
    case "bytecode": {
      if (!c?.program) { html = note(c ? "Code generation didn't run; fix earlier errors first." : "Run or check the program to see its bytecode."); break; }
      const userOnly = disassemble(c.program, (f) => !f.name.startsWith("std::") && !f.name.startsWith("<"));
      html = note(`${c.program.functions.length} monomorphized functions (only yours are shown below), ${c.program.constants.length} constants, ${c.bytes?.length ?? 0} bytes as a <code>.tsrb</code> file.`) + pre(userOnly);
      break;
    }
    case "native": {
      if (!c?.program) { html = note(c ? "Code generation didn't run; fix earlier errors first." : "Run or check the program to see its machine code."); break; }
      let exe;
      try {
        exe = buildExecutable(c.program, targetSelect.value as Target);
      } catch (e) {
        html = note(`The native backend can't compile this program: ${escapeHtml((e as Error).message)}`);
        break;
      }
      const img = exe.image;
      const hex = (n: number) => "0x" + n.toString(16).padStart(5, "0");
      const layout = [
        ["0x00000", "headers", `${exe.target === "linux" ? "ELF" : exe.target === "macos" ? "Mach-O" : "PE"} file and program headers`],
        [hex(img.codeStart), "your code", `${img.stats.code.toLocaleString()} bytes of x86-64 for ${img.stats.functions} functions, plus the entry point and OS shim`],
        [hex(img.rxEnd - RUNTIME_CODE(img)), "runtime code", "the native runtime (allocation, strings, formatting, Vec, HashMap...)"],
        [hex(img.rxEnd), "runtime data", "runtime globals: heap pointer, stdout buffer"],
        [hex(img.bytes.length - img.stats.data), "program data", `${img.stats.data.toLocaleString()} bytes: type descriptors, string constants${exe.target === "windows" ? ", KERNEL32 imports" : ""}`],
      ];
      const rows = layout.map(([at, what, desc]) => `<tr><td class="num">${at}</td><td>${what}</td><td>${desc}</td></tr>`).join("");
      const fns = c.program.functions.map((f, i) => ({ f, i })).filter(({ f }) => !isStdFunction(c.program!, f));
      const dumps = fns.map(({ f, i }) => {
        const start = img.functionOffsets[i];
        const end = img.functionOffsets.filter((o) => o > start).reduce((m, o) => Math.min(m, o), img.codeEnd);
        const bytes = [...img.bytes.slice(start, Math.min(end, start + 256))];
        const lines: string[] = [];
        for (let k = 0; k < bytes.length; k += 16) lines.push(`${hex(start + k)}  ${bytes.slice(k, k + 16).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
        return `fn ${f.name}  (${end - start} bytes${end - start > 256 ? ", first 256 shown" : ""})\n${lines.join("\n")}`;
      });
      html = note(`The native backend translates each bytecode instruction into x86-64 machine code and links it with the precompiled runtime into a <b>${escapeHtml(targetSelect.options[targetSelect.selectedIndex].text)}</b> executable of ${exe.bytes.length.toLocaleString()} bytes. Change the target in the toolbar, then use <b>Download executable</b>.`) +
        `<table class="grid"><thead><tr><th>offset</th><th>part</th><th>contents</th></tr></thead><tbody>${rows}</tbody></table>` +
        `<h3>Your functions as machine code</h3>` + pre(dumps.join("\n\n"));
      break;
    }
    case "pipeline": {
      if (!c) { html = note("Run or check the program to see the pipeline."); break; }
      const stages = ["crates", "resolve", "typeck", "borrowck", "codegen", "emit", "runtime"] as const;
      const total = Math.max(1, ...stages.map((s) => c.timings[s] ?? 0));
      const bars = stages.map((s) => {
        const ms = c.timings[s];
        const state = c.failedAt === s ? "failed" : ms === undefined ? "skipped" : "ok";
        const w = ms === undefined ? 0 : Math.max(1, (ms / total) * 100);
        return `<div class="stage stage-${state}"><span class="stage-name">${s}</span><span class="bar" style="width:${w}%"></span><span class="stage-ms">${ms === undefined ? "—" : `${ms.toFixed(1)} ms`}</span></div>`;
      }).join("");
      const g = c.graph;
      const crates = g ? g.order.map((i) => {
        const cr = g.crates[i];
        const deps = [...cr.deps.keys()];
        return `<li><code>${escapeHtml(cr.name)}</code>${cr.isStd ? " (standard library)" : ""}${deps.length ? ` → depends on ${deps.map((d) => `<code>${escapeHtml(d)}</code>`).join(", ")}` : ""}</li>`;
      }).join("") : "";
      html = note("Time spent in each stage of this compilation. <i>crates</i> includes lexing and parsing every file, including the standard library.") +
        `<div class="stages">${bars}</div>` + (crates ? `<h3>Crates, in build order</h3><ol class="crates">${crates}</ol>` : "");
      break;
    }
  }
  tabBody.innerHTML = html;
  for (const t of TABS) $(`tab-${t.id}`).classList.toggle("has-errors", t.id === "diagnostics" && !!c?.diagnostics.list.length);
}

/** Size of the runtime's code part (it sits just before the read+write data). */
function RUNTIME_CODE(img: { rxEnd: number; codeEnd: number }): number {
  return img.rxEnd - Math.ceil(img.codeEnd / 4096) * 4096;
}

function lineCol(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return `${line}:${offset - before.lastIndexOf("\n")}`;
}

// ---------------------------------------------------------------------------
// Building and running
// ---------------------------------------------------------------------------

async function build(runIt: boolean) {
  project.files[project.current] = source.value;
  status.textContent = "Compiling…";
  status.className = "status busy";
  await new Promise((r) => setTimeout(r, 10)); // let the UI repaint
  const started = performance.now();
  let c: Compilation;
  try {
    c = compile({ fs: new MemoryFileSystem(project.files), entry: project.entry });
  } catch (e) {
    status.textContent = `Internal compiler error: ${(e as Error).message}`;
    status.className = "status error";
    console.error(e);
    return;
  }
  last = c;
  lastRun = undefined;
  // Mark error spans in the editor for the open file.
  errorMarks = [];
  for (const d of c.diagnostics.list) {
    for (const l of d.labels) {
      const f = c.sources.get(l.span.file);
      if (f && f.name === project.current && l.primary) errorMarks.push({ start: l.span.start, end: Math.max(l.span.end, l.span.start + 1), cls: d.severity === "error" ? "mark-error" : "mark-warning" });
    }
  }
  refreshEditor();
  downloadBtn.disabled = !c.bytes;
  downloadExeBtn.disabled = !c.program;
  const compileMs = performance.now() - started;
  if (!c.bytes) {
    const n = c.diagnostics.errors().length;
    status.textContent = `${n} error${n === 1 ? "" : "s"} (stopped at ${c.failedAt}).`;
    status.className = "status error";
    selectTab(activeTab === "output" || activeTab === "diagnostics" ? "diagnostics" : activeTab);
    return;
  }
  if (runIt) {
    status.textContent = "Running…";
    await new Promise((r) => setTimeout(r, 0));
    try {
      lastRun = execute(c, { maxSteps: 50_000_000 });
    } catch (e) {
      lastRun = { stdout: "", stderr: `VM error: ${(e as Error).message}`, exitCode: -1, steps: 0 };
      console.error(e);
    }
    status.textContent = `Compiled in ${compileMs.toFixed(0)} ms, ran in ${(c.timings.runtime ?? 0).toFixed(0)} ms${lastRun.exitCode ? ` (exit ${lastRun.exitCode})` : ""}.`;
    status.className = lastRun.exitCode ? "status error" : "status ok";
    selectTab(activeTab === "diagnostics" ? "output" : activeTab);
  } else {
    status.textContent = `No errors (${compileMs.toFixed(0)} ms).`;
    status.className = "status ok";
    renderTab();
  }
  void renderDiagnostics;
}

$("run").addEventListener("click", () => void build(true));
$("check").addEventListener("click", () => void build(false));

downloadBtn.addEventListener("click", () => {
  if (!last?.bytes) return;
  const blob = new Blob([last.bytes as BlobPart], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name}.tsrb`;
  a.click();
  URL.revokeObjectURL(a.href);
});

downloadExeBtn.addEventListener("click", () => {
  if (!last?.program) return;
  const target = targetSelect.value as Target;
  try {
    const exe = buildExecutable(last.program, target);
    const blob = new Blob([exe.bytes as BlobPart], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name}${exe.extension}`;
    a.click();
    URL.revokeObjectURL(a.href);
    const hint = target === "windows" ? "Run it from a terminal." : `Run it with: chmod +x ${project.name} && ./${project.name}`;
    status.textContent = `Built a ${exe.bytes.length.toLocaleString()}-byte ${targetSelect.options[targetSelect.selectedIndex].text} executable. ${hint}`;
    status.className = "status ok";
  } catch (e) {
    status.textContent = e instanceof NativeError ? `Native backend: ${e.message}` : `Internal error: ${(e as Error).message}`;
    status.className = "status error";
  }
});
targetSelect.addEventListener("change", () => { if (activeTab === "native") renderTab(); });

// Sharing: the program travels in the URL fragment, base64-encoded.
$("share").addEventListener("click", async () => {
  project.files[project.current] = source.value;
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ files: project.files, entry: project.entry, current: project.current }))));
  const url = `${location.origin}${location.pathname}#code=${payload}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = "Link copied to clipboard.";
  } catch {
    status.textContent = "Link is in the address bar.";
  }
  status.className = "status ok";
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const groups = new Map<string, HTMLOptGroupElement>();
EXAMPLES.forEach((ex, i) => {
  let g = groups.get(ex.group);
  if (!g) {
    g = document.createElement("optgroup");
    g.label = ex.group;
    groups.set(ex.group, g);
    exampleSelect.append(g);
  }
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = ex.title;
  g.append(opt);
});

exampleSelect.addEventListener("change", () => {
  loadExample(EXAMPLES[Number(exampleSelect.value)]);
  last = undefined;
  lastRun = undefined;
  errorMarks = [];
  refreshEditor();
  history.replaceState(null, "", `#example=${EXAMPLES[Number(exampleSelect.value)].id}`);
  void build(true);
});
fileSelect.addEventListener("change", () => {
  project.files[project.current] = source.value;
  errorMarks = [];
  showFile(fileSelect.value);
  renderTab();
});

function start() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get("code");
  const exampleId = hash.get("example");
  if (code) {
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(code))));
      loadExample({ id: "shared", title: "Shared program", group: "Shared", files: data.files, entry: data.entry, open: data.current ?? data.entry, name: "shared" });
    } catch {
      loadExample(EXAMPLES[0]);
    }
  } else {
    const i = Math.max(0, EXAMPLES.findIndex((e) => e.id === exampleId));
    exampleSelect.value = String(i);
    loadExample(EXAMPLES[i]);
  }
  selectTab("output");
  void build(true);
}

start();

// Expose for debugging in the browser console.
(window as unknown as { tsrust: unknown }).tsrust = { compile, execute, buildExecutable, KEYWORDS };
