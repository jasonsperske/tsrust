import { test } from "node:test";
import assert from "node:assert/strict";
import { Diagnostics, SourceMap } from "../src/diagnostics.ts";
import { MemoryFileSystem, normalizePath } from "../src/crates/fs.ts";
import { loadCrates } from "../src/crates/loader.ts";
import { parseManifest } from "../src/crates/manifest.ts";
import { NodeIdGen } from "../src/parser/ast.ts";

function load(files: Record<string, string>, entry: string) {
  const diags = new Diagnostics();
  const sources = new SourceMap();
  const graph = loadCrates({ fs: new MemoryFileSystem(files), entry, sources, diags, ids: new NodeIdGen() });
  return { graph, diags };
}

test("paths normalize", () => {
  assert.equal(normalizePath("/a/b/../c/./d"), "/a/c/d");
  assert.equal(normalizePath("a//b/"), "a/b");
});

test("manifest parsing", () => {
  const d = new Diagnostics();
  const m = parseManifest('[package]\nname = "my-app" # comment\nversion = "1.2.3"\n\n[dependencies]\ngeo = { path = "../geo" }\n', 0, d)!;
  assert.equal(m.name, "my_app");
  assert.equal(m.version, "1.2.3");
  assert.deepEqual(m.dependencies.map((x) => [x.name, x.path]), [["geo", "../geo"]]);
});

test("non-path dependencies are rejected", () => {
  const d = new Diagnostics();
  parseManifest('[package]\nname = "a"\n[dependencies]\nserde = "1.0"\n', 0, d);
  assert.match(d.list[0].message, /must be a path dependency/);
});

test("dependency graph is built in topological order, diamonds loaded once", () => {
  const { graph, diags } = load({
    "/app/Cargo.toml": '[package]\nname = "app"\n[dependencies]\nb = { path = "../b" }\nc = { path = "../c" }\n',
    "/app/src/main.rs": "fn main() {}",
    "/b/Cargo.toml": '[package]\nname = "b"\n[dependencies]\nc = { path = "../c" }\n',
    "/b/src/lib.rs": "",
    "/c/Cargo.toml": '[package]\nname = "c"\n',
    "/c/src/lib.rs": "",
  }, "/app");
  assert.equal(diags.list.length, 0);
  const names = graph!.order.map((i) => graph!.crates[i].name);
  assert.deepEqual(names, ["std", "c", "b", "app"]);
});

test("cyclic package dependencies are an error", () => {
  const { diags } = load({
    "/a/Cargo.toml": '[package]\nname = "a"\n[dependencies]\nb = { path = "../b" }\n',
    "/a/src/main.rs": "fn main() {}",
    "/b/Cargo.toml": '[package]\nname = "b"\n[dependencies]\na = { path = "../a" }\n',
    "/b/src/lib.rs": "",
  }, "/a");
  assert.match(diags.list[0].message, /cyclic package dependency: a -> b -> a/);
});

test("`mod x;` loads x.rs, x/mod.rs, and nested x/y.rs", () => {
  const { graph, diags } = load({
    "/p/main.rs": "mod a; mod b; fn main() {}",
    "/p/a.rs": "mod inner;",
    "/p/a/inner.rs": "pub fn f() {}",
    "/p/b/mod.rs": "pub fn g() {}",
  }, "/p/main.rs");
  assert.equal(diags.list.length, 0, diags.list.map((d) => d.message).join());
  const root = graph!.crates[graph!.root];
  const a = root.items[0] as { items: { kind: string; items: unknown[] }[] };
  assert.equal(a.items[0].kind, "mod");
  assert.equal(a.items[0].items.length, 1);
});

test("missing module file is E0583", () => {
  const { diags } = load({ "/p/main.rs": "mod nope; fn main() {}" }, "/p/main.rs");
  assert.equal(diags.list[0].code, "E0583");
});
