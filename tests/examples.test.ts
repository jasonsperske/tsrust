import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compile, compileSource, execute, renderDiagnostics } from "../src/driver.ts";
import { MemoryFileSystem } from "../src/crates/fs.ts";

const dir = join(import.meta.dirname, "..", "examples");

// Each example's expected output was produced by the real rustc (see scripts/conformance.ts).
for (const name of readdirSync(dir).filter((f) => f.endsWith(".rs")).sort()) {
  test(`example ${name} matches rustc's output`, () => {
    const c = compileSource(readFileSync(join(dir, name), "utf8"));
    assert.ok(c.bytes, renderDiagnostics(c));
    assert.equal(execute(c).stdout, readFileSync(join(dir, name.replace(/\.rs$/, ".expected")), "utf8"));
  });
}

for (const name of readdirSync(join(dir, "errors")).filter((f) => f.endsWith(".rs")).sort()) {
  test(`error example ${name}`, () => {
    const c = compileSource(readFileSync(join(dir, "errors", name), "utf8"));
    const code = /^(E\d{4})/.exec(name)?.[1];
    if (code) {
      assert.ok(!c.bytes, "expected a compile error");
      assert.ok(c.diagnostics.errors().some((e) => e.code === code), `expected ${code}, got:\n${renderDiagnostics(c)}`);
    } else {
      assert.ok(c.bytes, renderDiagnostics(c));
      const r = execute(c);
      assert.equal(r.exitCode, 101);
      assert.match(r.stderr, /panicked at/);
    }
  });
}

test("multi-crate package example", () => {
  const root = join(dir, "packages");
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[p.slice(root.length)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  const c = compile({ fs: new MemoryFileSystem(files), entry: "/app" });
  assert.ok(c.bytes, renderDiagnostics(c));
  assert.deepEqual(c.graph!.order.map((i) => c.graph!.crates[i].name), ["std", "util", "geometry", "app"]);
  assert.equal(execute(c).stdout, "=== shapes ===\ntotal area: 7.142\n***\n");
});
