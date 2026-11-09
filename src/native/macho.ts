/**
 * # Mach-O: executables for macOS
 *
 * A Mach-O file is a header followed by *load commands*, each telling the
 * kernel or the dynamic loader (`dyld`) one thing: map this segment, start
 * here, load that library.
 *
 * ```text
 * mach_header_64         magic 0xfeedfacf, x86-64, MH_EXECUTE, flags (PIE)
 * LC_SEGMENT_64 __PAGEZERO   4 GiB of inaccessible memory at address 0 (catches null pointers)
 * LC_SEGMENT_64 __TEXT       headers + code + runtime code      r-x
 * LC_SEGMENT_64 __DATA       runtime globals + program data     rw-
 * LC_SEGMENT_64 __LINKEDIT   (empty) symbol and string tables   r--
 * LC_DYLD_INFO_ONLY          no rebasing or binding needed (the code is position-independent)
 * LC_SYMTAB / LC_DYSYMTAB    empty symbol tables (required by dyld)
 * LC_LOAD_DYLINKER           /usr/lib/dyld
 * LC_MAIN                    entry point offset
 * LC_LOAD_DYLIB              libSystem (every macOS program must link it)
 * LC_BUILD_VERSION           minimum macOS version
 * ```
 *
 * TSRust's code talks to the kernel with raw `syscall` instructions rather
 * than through libSystem, which keeps the file simple. Apple doesn't promise
 * that system-call numbers stay stable, but `write`, `exit` and `mmap` have
 * not changed in decades.
 *
 * The output is an x86-64 binary: it runs natively on Intel Macs and under
 * Rosetta 2 on Apple Silicon.
 */
import { PAGE, type Image } from "./compile.ts";

export const MACHO_BASE = 0x100000000;

export function writeMachO(img: Image): Uint8Array {
  const end = img.bytes.length;
  const linkeditOff = Math.ceil(end / PAGE) * PAGE;
  const linkeditSize = 16;
  const out = new Uint8Array(linkeditOff + linkeditSize);
  out.set(img.bytes);
  const v = new DataView(out.buffer);
  let p = 32; // load commands start after the 32-byte header
  let ncmds = 0;
  const u32 = (x: number) => { v.setUint32(p, x >>> 0, true); p += 4; };
  const u64 = (x: number) => { v.setBigUint64(p, BigInt(x), true); p += 8; };
  const name16 = (s: string) => { for (let i = 0; i < 16; i++) out[p + i] = i < s.length ? s.charCodeAt(i) : 0; p += 16; };
  const str = (s: string, size: number) => { for (let i = 0; i < size; i++) out[p + i] = i < s.length ? s.charCodeAt(i) : 0; p += size; };

  const segment = (name: string, vmaddr: number, vmsize: number, fileoff: number, filesize: number, prot: number, sections: { name: string; addr: number; size: number; offset: number; flags: number }[]) => {
    ncmds++;
    u32(0x19); // LC_SEGMENT_64
    u32(72 + 80 * sections.length);
    name16(name);
    u64(vmaddr); u64(vmsize); u64(fileoff); u64(filesize);
    u32(prot); u32(prot); // maxprot, initprot
    u32(sections.length);
    u32(0); // flags
    for (const s of sections) {
      name16(s.name); name16(name);
      u64(s.addr); u64(s.size);
      u32(s.offset); u32(4); // align 2^4
      u32(0); u32(0); // reloff, nreloc
      u32(s.flags); u32(0); u32(0); u32(0);
    }
  };

  const R = 1, W = 2, X = 4;
  segment("__PAGEZERO", 0, MACHO_BASE, 0, 0, 0, []);
  segment("__TEXT", MACHO_BASE, img.rxEnd, 0, img.rxEnd, R | X, [
    { name: "__text", addr: MACHO_BASE + img.codeStart, size: img.rxEnd - img.codeStart, offset: img.codeStart, flags: 0x80000400 },
  ]);
  const dataSize = Math.ceil((end - img.rxEnd) / PAGE) * PAGE;
  segment("__DATA", MACHO_BASE + img.rxEnd, dataSize, img.rxEnd, end - img.rxEnd, R | W, [
    { name: "__data", addr: MACHO_BASE + img.rxEnd, size: end - img.rxEnd, offset: img.rxEnd, flags: 0 },
  ]);
  segment("__LINKEDIT", MACHO_BASE + linkeditOff, PAGE, linkeditOff, linkeditSize, R, []);

  ncmds++; u32(0x80000022); u32(48); for (let i = 0; i < 10; i++) u32(0); // LC_DYLD_INFO_ONLY: nothing to rebase or bind
  ncmds++; u32(0x2); u32(24); u32(linkeditOff); u32(0); u32(linkeditOff); u32(linkeditSize); // LC_SYMTAB
  ncmds++; u32(0xb); u32(80); for (let i = 0; i < 18; i++) u32(0); // LC_DYSYMTAB
  ncmds++; u32(0xe); u32(32); u32(12); str("/usr/lib/dyld", 20); // LC_LOAD_DYLINKER
  ncmds++; u32(0x80000028); u32(24); u64(img.entry); u64(0); // LC_MAIN: entry offset in __TEXT, default stack
  ncmds++; u32(0xc); u32(56); u32(24); u32(2); u32(0x05276403); u32(0x00010000); str("/usr/lib/libSystem.B.dylib", 32); // LC_LOAD_DYLIB
  ncmds++; u32(0x32); u32(24); u32(1); u32(0x000a0f00); u32(0x000a0f00); u32(0); // LC_BUILD_VERSION: macOS 10.15

  const sizeofcmds = p - 32;
  if (p > img.codeStart) throw new Error("Mach-O load commands overflow the header page");
  const h = new DataView(out.buffer, 0, 32);
  h.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  h.setUint32(4, 0x01000007, true); // CPU_TYPE_X86_64
  h.setUint32(8, 3, true); // CPU_SUBTYPE_X86_64_ALL
  h.setUint32(12, 2, true); // MH_EXECUTE
  h.setUint32(16, ncmds, true);
  h.setUint32(20, sizeofcmds, true);
  h.setUint32(24, 0x1 | 0x4 | 0x80 | 0x200000, true); // NOUNDEFS | DYLDLINK | TWOLEVEL | PIE
  h.setUint32(28, 0, true);
  return out;
}
