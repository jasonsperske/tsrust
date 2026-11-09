/**
 * # Building native executables
 *
 * `bytecode Program → x86-64 image → executable file` for the chosen target:
 *
 * | Target    | Format  | OS interface                         | Runs on                          |
 * |-----------|---------|--------------------------------------|----------------------------------|
 * | `linux`   | ELF     | Linux system calls                   | x86-64 Linux                     |
 * | `macos`   | Mach-O  | macOS (BSD) system calls             | Intel Macs; Apple Silicon via Rosetta 2 |
 * | `windows` | PE      | KERNEL32.dll imports                 | 64-bit Windows                   |
 *
 * The machine code is identical for all three; only the container format and
 * the tiny OS shim (write, exit, allocate memory) differ.
 */
import type { Program } from "../bytecode/program.ts";
import { buildImage, NativeError, TARGETS, type Image, type Target } from "./compile.ts";
import { writeElf } from "./elf.ts";
import { writeMachO } from "./macho.ts";
import { writePE } from "./pe.ts";

export { NativeError, TARGETS, type Target };

export interface Executable {
  bytes: Uint8Array;
  target: Target;
  /** Suggested file extension (".exe" on Windows). */
  extension: string;
  stats: { code: number; runtime: number; data: number; functions: number };
  /** The linked image, before headers: for showing machine code. */
  image: Image;
}

export function buildExecutable(program: Program, target: Target): Executable {
  const img = buildImage(program, target);
  const bytes = target === "linux" ? writeElf(img) : target === "macos" ? writeMachO(img) : writePE(img);
  return { bytes, target, extension: target === "windows" ? ".exe" : "", stats: img.stats, image: img };
}

/** The target matching the machine we're running on, if it's supported. */
export function hostTarget(platform: string, arch: string): Target | undefined {
  if (arch !== "x64" && !(platform === "darwin" && arch === "arm64")) return undefined;
  return platform === "linux" ? "linux" : platform === "darwin" ? "macos" : platform === "win32" ? "windows" : undefined;
}
