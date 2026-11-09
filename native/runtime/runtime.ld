/* Lay the runtime out as one flat, position-independent blob:
 *   [ .text + .rodata ][ pad to page ][ .data + .bss ]
 * The native backend maps the first part read+execute and the second read+write. */
ENTRY(rt_init)
SECTIONS {
  . = 0;
  .text : { *(.text.rt_init) *(.text .text.*) *(.rodata .rodata.*) *(.got .got.*) }
  . = ALIGN(4096);
  .data : { *(.data .data.*) *(.bss .bss.*) *(COMMON) }
  /DISCARD/ : { *(.comment) *(.note .note.*) *(.eh_frame*) *(.dynsym) *(.dynstr) *(.hash) *(.gnu.hash) *(.dynamic) *(.interp) }
}
