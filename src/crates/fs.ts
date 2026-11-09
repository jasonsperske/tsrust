/**
 * # A tiny virtual filesystem
 *
 * The compiler never touches the real disk directly. It reads through this
 * interface, so the same code runs in Node (backed by real files) and in the
 * browser playground (backed by an in-memory map of example files).
 */

export interface FileSystem {
  /** Returns the file's text, or `undefined` if it doesn't exist. */
  readFile(path: string): string | undefined;
}

/** Collapse `.` and `..` segments and duplicate slashes: `/a/b/../c` → `/a/c`. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  return (absolute ? "/" : "") + out.join("/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? (path.startsWith("/") ? "/" : ".") : path.slice(0, i);
}

/** A filesystem backed by a plain object of `path → contents`. */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  constructor(files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.write(path, text);
  }

  write(path: string, text: string) {
    this.files.set(normalizePath(path.startsWith("/") ? path : "/" + path), text);
  }

  readFile(path: string): string | undefined {
    return this.files.get(normalizePath(path.startsWith("/") ? path : "/" + path));
  }

  paths(): string[] {
    return [...this.files.keys()];
  }
}

/** Layer several filesystems: the first one that has a file wins. */
export class OverlayFileSystem implements FileSystem {
  private readonly layers: FileSystem[];
  constructor(...layers: FileSystem[]) {
    this.layers = layers;
  }
  readFile(path: string): string | undefined {
    for (const layer of this.layers) {
      const text = layer.readFile(path);
      if (text !== undefined) return text;
    }
    return undefined;
  }
}
