/**
 * # Format strings
 *
 * `println!("{} is {:?} ({name})", a, b)` contains a little language of its
 * own. rustc parses it at compile time (in the `format_args!` built-in macro)
 * so that a mismatch between holes and arguments is a *compile* error. We do
 * the same here.
 *
 * Supported hole syntax:
 *
 * | Hole       | Meaning                                         |
 * |------------|-------------------------------------------------|
 * | `{}`       | next positional argument, `Display` formatting  |
 * | `{:?}`     | next positional argument, `Debug` formatting    |
 * | `{:#?}`    | pretty `Debug`                                  |
 * | `{0}`      | explicit positional argument                    |
 * | `{name}`   | inline variable capture (Rust 2021)             |
 * | `{:.2}`    | precision, for floats                           |
 * | `{{` `}}`  | literal braces                                  |
 */
import type { FormatPiece } from "./ast.ts";

export interface ParsedFormat {
  pieces: FormatPiece[];
  /** Names captured inline, e.g. `{name}`. Their arg index is `explicitArgs + i`. */
  captures: string[];
  /** How many positional args the string expects at minimum. */
  positionalCount: number;
  error?: string;
}

/**
 * Parse `text`. `explicitArgs` is the number of arguments written after the
 * string; inline captures are numbered after them.
 */
export function parseFormatString(text: string, explicitArgs: number): ParsedFormat {
  const pieces: FormatPiece[] = [];
  const captures: string[] = [];
  let next = 0;
  let maxPositional = 0;
  let buf = "";
  const flush = () => {
    if (buf) pieces.push({ kind: "text", text: buf });
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" && text[i + 1] === "{") { buf += "{"; i++; continue; }
    if (c === "}" && text[i + 1] === "}") { buf += "}"; i++; continue; }
    if (c === "}") return { pieces, captures, positionalCount: 0, error: "unmatched `}` in format string" };
    if (c !== "{") { buf += c; continue; }
    const close = text.indexOf("}", i);
    if (close < 0) return { pieces, captures, positionalCount: 0, error: "unmatched `{` in format string" };
    const inner = text.slice(i + 1, close);
    i = close;
    const [argPart, spec = ""] = inner.split(":", 2);
    let arg: number;
    if (argPart === "") {
      arg = next++;
      maxPositional = Math.max(maxPositional, arg + 1);
    } else if (/^\d+$/.test(argPart)) {
      arg = parseInt(argPart, 10);
      maxPositional = Math.max(maxPositional, arg + 1);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(argPart)) {
      let idx = captures.indexOf(argPart);
      if (idx < 0) { captures.push(argPart); idx = captures.length - 1; }
      arg = explicitArgs + idx;
    } else {
      return { pieces, captures, positionalCount: 0, error: `invalid format string argument \`${argPart}\`` };
    }
    let debug = false, pretty = false, precision: number | undefined;
    let s = spec;
    const prec = /\.(\d+)/.exec(s);
    if (prec) { precision = parseInt(prec[1], 10); s = s.replace(prec[0], ""); }
    if (s === "?") debug = true;
    else if (s === "#?") { debug = true; pretty = true; }
    else if (s !== "") return { pieces, captures, positionalCount: 0, error: `unsupported format spec \`:${spec}\`` };
    flush();
    pieces.push({ kind: "hole", arg, debug, pretty, precision });
  }
  flush();
  return { pieces, captures, positionalCount: maxPositional };
}
