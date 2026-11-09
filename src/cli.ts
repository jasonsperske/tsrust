#!/usr/bin/env node
/**
 * # The `tsrust` command-line tool
 *
 * ```text
 * tsrust run   <file.rs | package-dir | file.tsrb> [--native]
 *              compile (if needed) and run in the VM, or as a native executable
 * tsrust build <file.rs | package-dir | file.tsrb> [--target linux|macos|windows|bytecode] [-o out]
 *              compile to a native executable (default: for this machine) or to bytecode
 * tsrust check <file.rs | package-dir>                type- and borrow-check only
 * tsrust dump  <tokens|ast|types|mir|bytecode> <file.rs | package-dir>
 * ```
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Program } from "./bytecode/program.ts";
import { buildExecutable, hostTarget, NativeError, TARGETS, type Target } from "./native/index.ts";
import type { FileSystem } from "./crates/fs.ts";
import { compile, execute, renderDiagnostics, type Compilation } from "./driver.ts";
import { Diagnostics } from "./diagnostics.ts";
import { lex } from "./lexer/lexer.ts";
import { readProgram } from "./bytecode/writer.ts";
import { disassemble } from "./bytecode/program.ts";
import { run } from "./vm/vm.ts";

/** Reads straight from the real disk. */
class NodeFileSystem implements FileSystem {
  readFile(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
}

const color = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

function usage(): never {
  console.error(`TSRust — two can play at this game: a port of Rust to TypeScript

usage:
  tsrust run   <file.rs | package-dir | file.tsrb> [--native]
  tsrust build <file.rs | package-dir | file.tsrb> [--target linux|macos|windows|bytecode] [-o out]
  tsrust check <file.rs | package-dir>
  tsrust dump  <tokens|ast|types|mir|bytecode> <file.rs | package-dir>`);
  process.exit(2);
}

function compilePath(path: string, allowErrors = false): Compilation {
  const abs = resolve(path);
  const isDir = statSync(abs).isDirectory();
  const c = compile({ fs: new NodeFileSystem(), entry: isDir ? abs : abs });
  const text = renderDiagnostics(c);
  if (text) {
    const highlighted = text
      .replace(/^error(\[E\d+\])?:/gm, (m) => paint("1;31", m))
      .replace(/^warning:/gm, (m) => paint("1;33", m));
    console.error(highlighted + "\n");
  }
  const errors = c.diagnostics.errors().length;
  if (errors && !allowErrors) {
    console.error(paint("1;31", `error: could not compile \`${basename(abs)}\` due to ${errors} previous error${errors > 1 ? "s" : ""}`));
    process.exit(1);
  }
  return c;
}

function fail(message: string): never {
  console.error(paint("1;31", "error: ") + message);
  process.exit(2);
}

/** Compile a source path to a bytecode Program, or read one from a `.tsrb` file. */
function loadProgram(path: string): Program {
  return path.endsWith(".tsrb") ? readProgram(new Uint8Array(readFileSync(path))) : compilePath(path).program!;
}

function nativeBuild(program: Program, target: Target, out: string): string {
  try {
    const exe = buildExecutable(program, target);
    writeFileSync(out, exe.bytes);
    if (target !== "windows") chmodSync(out, 0o755);
    return resolve(out);
  } catch (e) {
    if (e instanceof NativeError) fail(e.message);
    throw e;
  }
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") usage();
  switch (cmd) {
    case "run": {
      const path = rest.find((a) => !a.startsWith("-")) ?? usage();
      if (rest.includes("--native")) {
        // Build an executable for this machine into a temp dir and run it.
        const target = hostTarget(process.platform, process.arch);
        if (!target) fail(`--native isn't supported on ${process.platform}/${process.arch}`);
        const exe = nativeBuild(loadProgram(path), target, join(mkdtempSync(join(tmpdir(), "tsrust-")), "main"));
        const r = spawnSync(exe, { stdio: "inherit" });
        if (r.signal) {
          // Native code has no stack-overflow check: deep recursion ends in SIGSEGV.
          console.error(paint("1;31", "error: ") + `process terminated by ${r.signal}${r.signal === "SIGSEGV" ? " (stack overflow from deep recursion?)" : ""}`);
          process.exit(134);
        }
        process.exit(r.status ?? 1);
      }
      const write = (text: string, stream: "stdout" | "stderr") => (stream === "stdout" ? process.stdout : process.stderr).write(text);
      const result = path.endsWith(".tsrb")
        ? run(readProgram(new Uint8Array(readFileSync(path))), { write })
        : execute(compilePath(path), { write });
      process.exit(result.exitCode);
    }
    case "build": {
      const path = rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "-o" && rest[i - 1] !== "--target") ?? usage();
      const tIdx = rest.indexOf("--target");
      const target = (tIdx >= 0 ? rest[tIdx + 1] : hostTarget(process.platform, process.arch) ?? "bytecode") as Target | "bytecode";
      if (target !== "bytecode" && !TARGETS.includes(target)) fail(`unknown target \`${target}\` (expected ${[...TARGETS, "bytecode"].join(", ")})`);
      const oIdx = rest.indexOf("-o");
      const stem = basename(resolve(path)).replace(/\.(rs|tsrb)$/, "");
      const started = performance.now();
      if (target === "bytecode") {
        const c = compilePath(path);
        const out = oIdx >= 0 ? rest[oIdx + 1] : stem + ".tsrb";
        writeFileSync(out, c.bytes!);
        console.error(`${paint("1;32", "    Finished")} ${out} (bytecode, ${c.bytes!.length} bytes, ${c.program!.functions.length} functions) in ${(performance.now() - started).toFixed(0)}ms`);
        return;
      }
      const out = oIdx >= 0 ? rest[oIdx + 1] : stem + (target === "windows" ? ".exe" : "");
      nativeBuild(loadProgram(path), target, out);
      console.error(`${paint("1;32", "    Finished")} ${out} (${target} x86-64 executable) in ${(performance.now() - started).toFixed(0)}ms`);
      return;
    }
    case "check": {
      const path = rest[0] ?? usage();
      const c = compilePath(path);
      console.error(`${paint("1;32", "    Finished")} no errors (${Object.entries(c.timings).map(([k, v]) => `${k} ${v!.toFixed(0)}ms`).join(", ")})`);
      return;
    }
    case "dump": {
      const [what, path] = rest;
      if (!what || !path) usage();
      if (what === "tokens") {
        const text = readFileSync(path, "utf8");
        for (const t of lex(text, 0, new Diagnostics())) console.log(`${t.kind.padEnd(9)} ${JSON.stringify(t.text)}${t.suffix ? ` (suffix ${t.suffix})` : ""}`);
        return;
      }
      // MIR is still available when only the borrow checker failed: dump it anyway.
      const c = compilePath(path, what === "mir");
      if (what === "mir" && !c.borrowck) process.exit(1);
      if (what === "ast") {
        const root = c.graph!.crates[c.graph!.root];
        console.log(JSON.stringify(root.items, (k, v) => (k === "span" || k === "nameSpan" || k === "id" ? undefined : v), 2));
      } else if (what === "types") {
        const { tcx, results } = c.typeck!;
        for (const [id, local] of results.locals) {
          if (tcx.defs[tcx.res.crateRoots[c.graph!.root]] && local.span.file >= 0 && c.sources.get(local.span.file)?.name.includes("__std__")) continue;
          const pos = c.sources.get(local.span.file)?.position(local.span.start);
          console.log(`${String(pos?.line).padStart(4)}:${String(pos?.col).padEnd(3)} ${local.mutable ? "mut " : ""}${local.name}: ${tcx.show(local.ty)}  (#${id})`);
        }
      } else if (what === "mir") {
        for (const def of c.borrowck!.bodies.keys()) console.log(c.borrowck!.mirText(def) + "\n");
      } else if (what === "bytecode") {
        console.log(disassemble(c.program!, (f) => !f.name.startsWith("std::") && !f.name.startsWith("<")));
      } else usage();
      return;
    }
    default:
      usage();
  }
}

main(process.argv.slice(2));
