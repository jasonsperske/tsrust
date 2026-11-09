/**
 * # ELF: executables for Linux
 *
 * An ELF executable is a 64-byte file header, a table of *program headers*
 * describing which parts of the file to map into memory, and the bytes
 * themselves. The kernel's loader only looks at program headers ("segments");
 * the section headers that linkers and debuggers use are optional, so we
 * write none.
 *
 * ```text
 * offset 0x00  ELF header           "\x7fELF", 64-bit, little-endian, x86-64, entry point
 * offset 0x40  program header 0     PT_LOAD  R+X  maps [0, rxEnd)        (headers, code, runtime code)
 * offset 0x78  program header 1     PT_LOAD  R+W  maps [rxEnd, end)      (runtime globals, program data)
 * offset 0xb0  program header 2     PT_GNU_STACK  (non-executable stack)
 * ...          zero padding to 0x1000, then the image
 * ```
 *
 * Because the image is laid out page by page, file offsets equal addresses,
 * and each segment is a straight copy.
 *
 * The file is a *position-independent executable* (`ET_DYN`): the kernel
 * loads it at a random address (ASLR). That works without any relocation
 * processing because every address in TSRust's code is `rip`-relative.
 */
import type { Image } from "./compile.ts";

/** Addresses are relative: the kernel picks the real base at load time. */
export const ELF_BASE = 0;

export function writeElf(img: Image): Uint8Array {
  const out = new Uint8Array(img.bytes);
  const v = new DataView(out.buffer);
  const u8 = (o: number, x: number) => v.setUint8(o, x);
  const u16 = (o: number, x: number) => v.setUint16(o, x, true);
  const u32 = (o: number, x: number) => v.setUint32(o, x, true);
  const u64 = (o: number, x: number) => v.setBigUint64(o, BigInt(x), true);

  // e_ident
  out.set([0x7f, 0x45, 0x4c, 0x46], 0); // "\x7fELF"
  u8(4, 2); // ELFCLASS64
  u8(5, 1); // little-endian
  u8(6, 1); // EV_CURRENT
  u8(7, 0); // System V ABI
  u16(16, 3); // e_type: ET_DYN (position-independent executable)
  u16(18, 62); // e_machine: EM_X86_64
  u32(20, 1); // e_version
  u64(24, ELF_BASE + img.entry); // e_entry
  u64(32, 64); // e_phoff: program headers right after this header
  u64(40, 0); // e_shoff: no section headers
  u32(48, 0); // e_flags
  u16(52, 64); // e_ehsize
  u16(54, 56); // e_phentsize
  u16(56, 3); // e_phnum
  u16(58, 64); // e_shentsize
  u16(60, 0); // e_shnum
  u16(62, 0); // e_shstrndx

  const ph = (i: number, type: number, flags: number, offset: number, size: number) => {
    const o = 64 + 56 * i;
    u32(o, type);
    u32(o + 4, flags);
    u64(o + 8, offset); // p_offset
    u64(o + 16, ELF_BASE + offset); // p_vaddr
    u64(o + 24, ELF_BASE + offset); // p_paddr
    u64(o + 32, size); // p_filesz
    u64(o + 40, size); // p_memsz
    u64(o + 48, type === 1 ? 0x1000 : 16); // p_align
  };
  const PF_X = 1, PF_W = 2, PF_R = 4;
  ph(0, 1 /* PT_LOAD */, PF_R | PF_X, 0, img.rxEnd);
  ph(1, 1 /* PT_LOAD */, PF_R | PF_W, img.rxEnd, img.bytes.length - img.rxEnd);
  ph(2, 0x6474e551 /* PT_GNU_STACK */, PF_R | PF_W, 0, 0);
  return out;
}
