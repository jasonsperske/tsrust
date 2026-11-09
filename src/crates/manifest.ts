/**
 * # Package manifests (`Cargo.toml`)
 *
 * Cargo describes a package with a TOML file. TSRust understands the subset
 * that matters for building a dependency graph:
 *
 * ```toml
 * [package]
 * name = "app"
 * version = "0.1.0"
 *
 * [dependencies]
 * geometry = { path = "../geometry" }
 * ```
 *
 * Only `path` dependencies are supported: there is no registry to download
 * from, which keeps the whole build hermetic and browser-friendly.
 */
import { Diagnostics, type Span } from "../diagnostics.ts";

export interface Dependency {
  /** The name the dependent crate uses to refer to it, e.g. `geometry` in `use geometry::Point`. */
  name: string;
  path: string;
  span: Span;
}

export interface Manifest {
  name: string;
  version: string;
  dependencies: Dependency[];
  span: Span;
}

type TomlValue = string | number | boolean | { [key: string]: TomlValue };

/**
 * Parse the TOML subset: `[section]` headers, `key = value` pairs where value
 * is a string, number, boolean or inline table `{ k = v, ... }`, and `#`
 * comments.
 */
export function parseManifest(text: string, file: number, diags: Diagnostics): Manifest | undefined {
  const sections = new Map<string, Map<string, { value: TomlValue; span: Span }>>();
  let current = new Map<string, { value: TomlValue; span: Span }>();
  sections.set("", current);
  let offset = 0;
  let ok = true;
  for (const rawLine of text.split("\n")) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const span: Span = { file, start: lineStart, end: lineStart + rawLine.length };
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      diags.error("crates", span, `invalid manifest line: expected \`key = value\``);
      ok = false;
      continue;
    }
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    const parsed = parseValue(line.slice(eq + 1).trim());
    if (parsed === undefined) {
      diags.error("crates", span, `invalid value for \`${key}\``);
      ok = false;
      continue;
    }
    current.set(key, { value: parsed, span });
  }
  if (!ok) return undefined;

  const pkg = sections.get("package");
  const name = pkg?.get("name");
  const fileSpan: Span = { file, start: 0, end: Math.min(text.length, 1) };
  if (!pkg || typeof name?.value !== "string") {
    diags.error("crates", fileSpan, "manifest is missing `[package]` with a `name`");
    return undefined;
  }
  const version = pkg.get("version");
  const dependencies: Dependency[] = [];
  for (const [depName, { value, span }] of sections.get("dependencies") ?? []) {
    if (typeof value === "object" && typeof value.path === "string") {
      dependencies.push({ name: depName.replace(/-/g, "_"), path: value.path, span });
    } else {
      diags.error("crates", span, `dependency \`${depName}\` must be a path dependency, e.g. \`${depName} = { path = "../${depName}" }\``)
        .note("TSRust has no package registry; all dependencies are local paths");
    }
  }
  return {
    name: name.value.replace(/-/g, "_"),
    version: typeof version?.value === "string" ? version.value : "0.0.0",
    dependencies,
    span: name.span,
  };
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inString = !inString;
    if (line[i] === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(text: string): TomlValue | undefined {
  if (/^"([^"\\]|\\.)*"$/.test(text)) return JSON.parse(text);
  if (/^'[^']*'$/.test(text)) return text.slice(1, -1);
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("{") && text.endsWith("}")) {
    const table: { [key: string]: TomlValue } = {};
    const body = text.slice(1, -1).trim();
    if (!body) return table;
    // Split on commas that are not inside strings.
    const parts: string[] = [];
    let depth = 0, inString = false, start = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '"') inString = !inString;
      else if (!inString && c === "{") depth++;
      else if (!inString && c === "}") depth--;
      else if (!inString && depth === 0 && c === ",") { parts.push(body.slice(start, i)); start = i + 1; }
    }
    parts.push(body.slice(start));
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq < 0) return undefined;
      const value = parseValue(part.slice(eq + 1).trim());
      if (value === undefined) return undefined;
      table[part.slice(0, eq).trim()] = value;
    }
    return table;
  }
  return undefined;
}
