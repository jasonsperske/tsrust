/**
 * Conformance check: compile every example with the real `rustc` and with
 * TSRust, run both, and compare their output byte for byte. TSRust's output is
 * checked twice: from the bytecode VM, and (on Linux x86-64) from a native
 * executable built by the native backend.
 *
 *   npm run conformance            # compare against rustc (must be installed)
 *   npm run conformance -- --update # also refresh examples/*.expected
 *
 * The `.expected` files let the test suite check TSRust's output on machines
 * without a Rust toolchain.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSource, execute, renderDiagnostics } from "../src/driver.ts";
import { buildExecutable, hostTarget } from "../src/native/index.ts";

const native = hostTarget(process.platform, process.arch) === "linux";

const root = join(import.meta.dirname, "..");
const dir = join(root, "examples");
const update = process.argv.includes("--update");
const work = mkdtempSync(join(tmpdir(), "tsrust-conformance-"));
let failures = 0;

for (const name of readdirSync(dir).filter((f) => f.endsWith(".rs")).sort()) {
  const path = join(dir, name);
  const src = readFileSync(path, "utf8");
  let expected: string;
  try {
    const bin = join(work, name.replace(/\.rs$/, ""));
    execFileSync("rustc", ["--edition", "2021", "-A", "warnings", "-o", bin, path], { stdio: "pipe" });
    expected = execFileSync(bin, { encoding: "utf8" });
  } catch (e) {
    console.log(`✗ ${name}: rustc failed\n${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
    failures++;
    continue;
  }
  const c = compileSource(src);
  if (!c.bytes) {
    console.log(`✗ ${name}: TSRust failed to compile\n${renderDiagnostics(c)}`);
    failures++;
    continue;
  }
  const outputs: [string, string][] = [["vm", execute(c).stdout]];
  if (native) {
    const exe = join(work, name.replace(/\.rs$/, ".native"));
    writeFileSync(exe, buildExecutable(c.program!, "linux").bytes);
    chmodSync(exe, 0o755);
    outputs.push(["native", spawnSync(exe, { encoding: "utf8" }).stdout]);
  }
  const bad = outputs.filter(([, out]) => out !== expected);
  if (bad.length === 0) {
    console.log(`✓ ${name} (${outputs.map(([k]) => k).join(" + ")})`);
  } else {
    failures++;
    for (const [kind, actual] of bad) {
      console.log(`✗ ${name}: ${kind} output differs`);
      const a = actual.split("\n"), b = expected.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) console.log(`  line ${i + 1}:\n    rustc : ${JSON.stringify(b[i])}\n    tsrust: ${JSON.stringify(a[i])}`);
      }
    }
  }
  const expectedPath = path.replace(/\.rs$/, ".expected");
  if (update || !existsSync(expectedPath)) writeFileSync(expectedPath, expected);
}
console.log(failures ? `\n${failures} example(s) differ from rustc` : "\nall examples match rustc");
process.exit(failures ? 1 : 0);
