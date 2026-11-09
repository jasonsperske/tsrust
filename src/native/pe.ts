/**
 * # PE: executables for Windows
 *
 * The Portable Executable format still starts with a 1981 MS-DOS header
 * ("MZ"), whose only job today is to point at the real "PE" header.
 *
 * ```text
 * 0x000  DOS header        "MZ" ... e_lfanew = 0x40
 * 0x040  "PE\0\0"
 * 0x044  COFF header       machine x86-64, 2 sections, characteristics
 * 0x058  optional header   PE32+: entry point, image base, alignments,
 *                          subsystem = console, data directories (imports)
 * 0x148  section table     .text (code, r-x)   .data (data + imports, rw-)
 * ...    zero padding to 0x1000, then the image
 * ```
 *
 * Windows has no stable system-call numbers, so a program must import
 * functions from KERNEL32.dll. The *import directory* names the DLL and the
 * functions; the loader writes their addresses into the *import address table*
 * (IAT), and our OS shim calls them with `call [rip + slot]`. The import
 * tables are built by the code generator (they need image addresses), and
 * this writer just points the data directories at them.
 *
 * We set the file alignment equal to the section alignment (4 KiB), so file
 * offsets equal relative virtual addresses (RVAs) and the image is written as is.
 */
import { PAGE, type Image } from "./compile.ts";

export const PE_BASE = 0x140000000;

export function writePE(img: Image): Uint8Array {
  if (!img.imports) throw new Error("PE images need an import table (build with target windows)");
  const end = img.bytes.length;
  const fileSize = Math.ceil(end / PAGE) * PAGE;
  const out = new Uint8Array(fileSize);
  out.set(img.bytes);
  const v = new DataView(out.buffer);
  const u16 = (o: number, x: number) => v.setUint16(o, x, true);
  const u32 = (o: number, x: number) => v.setUint32(o, x >>> 0, true);
  const u64 = (o: number, x: number) => v.setBigUint64(o, BigInt(x), true);

  // DOS header
  out.set([0x4d, 0x5a], 0); // "MZ"
  u32(0x3c, 0x40); // e_lfanew

  // PE signature + COFF file header
  out.set([0x50, 0x45, 0, 0], 0x40);
  const coff = 0x44;
  u16(coff, 0x8664); // IMAGE_FILE_MACHINE_AMD64
  u16(coff + 2, 2); // NumberOfSections
  u32(coff + 4, 0); // TimeDateStamp
  u16(coff + 16, 240); // SizeOfOptionalHeader (PE32+)
  u16(coff + 18, 0x0001 | 0x0002 | 0x0020); // RELOCS_STRIPPED | EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

  // Optional header (PE32+)
  const o = coff + 20;
  const textSize = img.rxEnd - img.codeStart;
  const dataSize = end - img.rxEnd;
  u16(o, 0x20b); // magic: PE32+
  out[o + 2] = 14; // linker version
  u32(o + 4, textSize); // SizeOfCode
  u32(o + 8, dataSize); // SizeOfInitializedData
  u32(o + 16, img.entry); // AddressOfEntryPoint (RVA)
  u32(o + 20, img.codeStart); // BaseOfCode
  u64(o + 24, PE_BASE); // ImageBase
  u32(o + 32, PAGE); // SectionAlignment
  u32(o + 36, PAGE); // FileAlignment
  u16(o + 40, 6); // OS version 6.0 (Vista+)
  u16(o + 48, 6); // subsystem version 6.0
  u32(o + 56, fileSize); // SizeOfImage
  u32(o + 60, img.codeStart); // SizeOfHeaders
  u16(o + 68, 3); // Subsystem: WINDOWS_CUI (console)
  u16(o + 70, 0x0100 | 0x8000); // DllCharacteristics: NX_COMPAT | TERMINAL_SERVER_AWARE
  u64(o + 72, 0x800000); // SizeOfStackReserve (8 MiB, like Linux)
  u64(o + 80, 0x1000); // SizeOfStackCommit
  u64(o + 88, 0x100000); // SizeOfHeapReserve
  u64(o + 96, 0x1000); // SizeOfHeapCommit
  u32(o + 108, 16); // NumberOfRvaAndSizes
  const dir = (i: number, rva: number, size: number) => { u32(o + 112 + 8 * i, rva); u32(o + 116 + 8 * i, size); };
  dir(1, img.imports.dir, img.imports.dirSize); // import table
  dir(12, img.imports.iat, img.imports.iatSize); // import address table

  // Section table
  const section = (i: number, name: string, rva: number, vsize: number, rawSize: number, flags: number) => {
    const s = o + 240 + 40 * i;
    for (let k = 0; k < 8; k++) out[s + k] = k < name.length ? name.charCodeAt(k) : 0;
    u32(s + 8, vsize); // VirtualSize
    u32(s + 12, rva); // VirtualAddress
    u32(s + 16, rawSize); // SizeOfRawData
    u32(s + 20, rva); // PointerToRawData (== RVA, see above)
    u32(s + 36, flags);
  };
  section(0, ".text", img.codeStart, textSize, textSize, 0x60000020); // CODE | EXECUTE | READ
  section(1, ".data", img.rxEnd, dataSize, fileSize - img.rxEnd, 0xc0000040); // INITIALIZED_DATA | READ | WRITE
  return out;
}
