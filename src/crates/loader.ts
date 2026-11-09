/**
 * # Stage 3: Loading crates and modules
 *
 * A Rust program is a *graph of crates*, and each crate is a *tree of
 * modules* that may be spread across many files. This stage discovers both
 * and hands later stages a set of fully-parsed crates in dependency order.
 *
 * ```mermaid
 * flowchart TD
 *   subgraph graph["1 · Package graph (Cargo.toml)"]
 *     app["app"] -->|depends on| geo["geometry"]
 *     app --> util["util"]
 *     geo --> util
 *     app -.->|implicit| std["std"]
 *     geo -.-> std
 *     util -.-> std
 *   end
 *   subgraph tree["2 · Module tree of one crate"]
 *     main["src/main.rs"] -->|"mod shapes;"| shapes["src/shapes.rs"]
 *     shapes -->|"mod circle;"| circle["src/shapes/circle.rs"]
 *     main -->|"mod util { ... }"| inline["(inline module)"]
 *   end
 * ```
 *
 * ## Package resolution
 *
 * Starting from the root package, we read each `Cargo.toml`, follow its
 * `path` dependencies, and run a depth-first search. The DFS does two jobs:
 *
 * - **Cycle detection**: a package that reaches itself through its own
 *   dependencies can never be built. We keep the current DFS path on a stack;
 *   seeing a package that is already on the stack means a cycle.
 * - **Topological order**: we append a package *after* all its dependencies
 *   are finished (post-order). That ordering is the build order: every crate
 *   appears after everything it depends on.
 *
 * ## Module files
 *
 * `mod shapes;` (with a semicolon) means "the body is in another file". Rust
 * looks for `shapes.rs` next to the current file, then `shapes/mod.rs`. If the
 * current file is not a "directory owner" (`main.rs`, `lib.rs`, `mod.rs`),
 * children live in a subdirectory named after the current module:
 * `src/shapes.rs` declares `mod circle;` found at `src/shapes/circle.rs`.
 */
import { Diagnostics, SourceMap, type Span } from "../diagnostics.ts";
import { lex } from "../lexer/lexer.ts";
import type * as A from "../parser/ast.ts";
import { NodeIdGen } from "../parser/ast.ts";
import { parseFile } from "../parser/parser.ts";
import { STD_FILES } from "../std/bundle.ts";
import { MemoryFileSystem, OverlayFileSystem, dirname, joinPath, type FileSystem } from "./fs.ts";
import { parseManifest, type Manifest } from "./manifest.ts";

export const STD_ROOT = "/__std__";

export interface Crate {
  id: number;
  name: string;
  /** Directory containing `Cargo.toml` (or the single source file). */
  dir: string;
  kind: "bin" | "lib";
  isStd: boolean;
  /** Items of the crate root module (`main.rs`/`lib.rs`), with all `mod x;` bodies loaded. */
  items: A.Item[];
  rootFile: number;
  /** Extern crate name → crate id. Always includes `std` (except for std itself). */
  deps: Map<string, number>;
}

export interface CrateGraph {
  crates: Crate[];
  /** Crate ids in build order: dependencies before dependents. */
  order: number[];
  root: number;
  std: number;
}

export interface LoadOptions {
  fs: FileSystem;
  /** Either a package directory containing `Cargo.toml`, or the path of a single `.rs` file. */
  entry: string;
  sources: SourceMap;
  diags: Diagnostics;
  ids: NodeIdGen;
}

/** Load the package graph starting at `entry`. Returns `undefined` if nothing could be loaded at all. */
export function loadCrates(opts: LoadOptions): CrateGraph | undefined {
  return new CrateLoader(opts).load();
}

class CrateLoader {
  private readonly crates: Crate[] = [];
  private readonly byDir = new Map<string, number>();
  private readonly order: number[] = [];
  /** Package names by directory, filled in as soon as each manifest is read. */
  private readonly names = new Map<string, string>();
  private readonly fs: FileSystem;
  private readonly opts: LoadOptions;

  constructor(opts: LoadOptions) {
    this.opts = opts;
    this.fs = new OverlayFileSystem(prefixFs(STD_ROOT, STD_FILES), opts.fs);
  }

  load(): CrateGraph | undefined {
    const std = this.loadPackage(STD_ROOT, [], undefined);
    if (std === undefined) return undefined;
    const entry = this.opts.entry;
    let root: number | undefined;
    if (entry.endsWith(".rs")) {
      root = this.loadSingleFile(entry);
    } else {
      root = this.loadPackage(entry, [], undefined, "bin");
    }
    if (root === undefined) return undefined;
    return { crates: this.crates, order: this.order, root, std };
  }

  /** A lone `main.rs` with no manifest: an implicit binary crate named after the file. */
  private loadSingleFile(path: string): number | undefined {
    const text = this.fs.readFile(path);
    if (text === undefined) {
      this.opts.diags.error("crates", { file: -1, start: 0, end: 0 }, `couldn't read \`${path}\``);
      return undefined;
    }
    const name = path.replace(/^.*\//, "").replace(/\.rs$/, "").replace(/-/g, "_");
    const crate = this.newCrate(name, dirname(path), "bin");
    crate.deps.set("std", 0);
    const file = this.parseSource(path, text);
    crate.rootFile = file.file;
    crate.items = file.items;
    this.loadModFiles(crate.items, dirname(path), true);
    this.order.push(crate.id);
    return crate.id;
  }

  private newCrate(name: string, dir: string, kind: "bin" | "lib"): Crate {
    const crate: Crate = { id: this.crates.length, name, dir, kind, isStd: dir === STD_ROOT, items: [], rootFile: -1, deps: new Map() };
    this.crates.push(crate);
    this.byDir.set(dir, crate.id);
    return crate;
  }

  /**
   * Load the package in `dir` and, recursively, its dependencies.
   * `stack` is the current DFS path, used for cycle detection.
   */
  private loadPackage(dir: string, stack: string[], requestedBy: Span | undefined, kind: "bin" | "lib" = "lib"): number | undefined {
    const { diags } = this.opts;
    const existing = this.byDir.get(dir);
    if (stack.includes(dir)) {
      const cycle = [...stack.slice(stack.indexOf(dir)), dir].map((d) => this.names.get(d) ?? d);
      diags.error("crates", requestedBy ?? { file: -1, start: 0, end: 0 }, `cyclic package dependency: ${cycle.join(" -> ")}`)
        .note("crates must form a DAG (directed acyclic graph) so there is an order to build them in");
      return undefined;
    }
    if (existing !== undefined) return existing; // already fully loaded (a "diamond" dependency)

    const manifestPath = joinPath(dir, "Cargo.toml");
    const manifestText = this.fs.readFile(manifestPath);
    if (manifestText === undefined) {
      diags.error("crates", requestedBy ?? { file: -1, start: 0, end: 0 }, `failed to read \`${manifestPath}\``);
      return undefined;
    }
    const manifestFile = this.opts.sources.add(manifestPath, manifestText);
    const manifest: Manifest | undefined = parseManifest(manifestText, manifestFile.id, diags);
    if (!manifest) return undefined;
    this.names.set(dir, manifest.name);

    // Find the crate root: binaries prefer `src/main.rs`, libraries need `src/lib.rs`.
    const candidates = kind === "bin" ? ["src/main.rs", "src/lib.rs"] : ["src/lib.rs"];
    const rootPath = candidates.map((c) => joinPath(dir, c)).find((p) => this.fs.readFile(p) !== undefined);
    if (!rootPath) {
      diags.error("crates", manifest.span, `package \`${manifest.name}\` has no ${candidates.map((c) => `\`${c}\``).join(" or ")}`);
      return undefined;
    }
    const crate = this.newCrate(manifest.name, dir, rootPath.endsWith("main.rs") ? "bin" : "lib");
    // Remove from byDir until finished so diamonds are distinguished from cycles.
    this.byDir.delete(dir);

    stack.push(dir);
    if (!crate.isStd) crate.deps.set("std", 0);
    for (const dep of manifest.dependencies) {
      const depId = this.loadPackage(joinPath(dir, dep.path), stack, dep.span);
      if (depId !== undefined) crate.deps.set(dep.name, depId);
    }
    stack.pop();
    this.byDir.set(dir, crate.id);

    const file = this.parseSource(rootPath, this.fs.readFile(rootPath)!);
    crate.rootFile = file.file;
    crate.items = file.items;
    this.loadModFiles(crate.items, dirname(rootPath), true);
    this.order.push(crate.id); // post-order: after all dependencies
    return crate.id;
  }

  private parseSource(path: string, text: string): A.SourceModule {
    const file = this.opts.sources.add(path, text);
    const tokens = lex(text, file.id, this.opts.diags);
    return parseFile(tokens, file.id, this.opts.ids, this.opts.diags);
  }

  /**
   * Walk `items` and fill in the body of every out-of-line `mod name;`.
   * `dir` is where this module's children live.
   */
  private loadModFiles(items: A.Item[], dir: string, _isDirOwner: boolean) {
    for (const item of items) {
      if (item.kind !== "mod") continue;
      if (item.items) {
        // Inline module: its own out-of-line children live in `dir/name/`.
        this.loadModFiles(item.items, joinPath(dir, item.name), true);
        continue;
      }
      const flat = joinPath(dir, `${item.name}.rs`);
      const nested = joinPath(dir, item.name, "mod.rs");
      const path = [flat, nested].find((p) => this.fs.readFile(p) !== undefined);
      if (!path) {
        this.opts.diags.error("crates", item.span, `file not found for module \`${item.name}\``, "E0583")
          .help(`to create the module \`${item.name}\`, create file "${flat}" or "${nested}"`);
        item.items = [];
        continue;
      }
      const file = this.parseSource(path, this.fs.readFile(path)!);
      item.items = file.items;
      item.file = file.file;
      // `foo.rs` keeps children in `foo/`; `foo/mod.rs` keeps them beside itself.
      this.loadModFiles(item.items, path === flat ? joinPath(dir, item.name) : dirname(path), true);
    }
  }
}

function prefixFs(prefix: string, files: Record<string, string>): FileSystem {
  const fs = new MemoryFileSystem();
  for (const [path, text] of Object.entries(files)) fs.write(joinPath(prefix, path), text);
  return fs;
}
