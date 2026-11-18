# cc65 C mode demo

A small NES project mixing C and ca65 assembly, for trying the extension's C support.
Open this folder on its own (**File → Open Folder…**) with the extension installed. Requirements:

- cc65 (`cc65`, `ca65`, `cl65`) and `clangd` in your `PATH`
- `make` to build `demo.nes` (optional)

`.vscode/settings.json` turns cc65 C mode on (`ca65.enableCSupport`, off by default), sets the target
to `nes`, and disables the separate clangd extension for this folder (if installed) so C files aren't
served twice.

## Things to try

**Hovers and assembly stubs**

- Hover `draw_sprite(...)` in `src/main.c`: clangd's card with the documentation from
  `include/game.h`. Hover `_draw_sprite` in `src/sprites.s`: the asm card (registers, clobbers)
  followed by its C prototype (`void __fastcall__ draw_sprite(...)`).
- Hover `on_hit` (implemented in C), `clamp` (`__cdecl__`), `negate`, `pack32` and `player_x` (a
  zero-page variable defined in `src/zp.s`) from either side.
- In `src/sprites.s`, right-click `_draw_sprite` → **Go to Declaration** opens its prototype in
  `include/game.h`; **Go to Definition** (F12) stays on the `.proc`.
- In `include/game.h`, put the cursor on `read_pad` and open the code actions (light bulb or
  **Ctrl+.**): **Create assembly stub for `read_pad`** asks for an asm file and writes an
  `.export`/`.proc` stub whose comments say where each argument arrives and what to return.

**Linking C and assembly**

- **F12** on `draw_sprite(...)` in `src/main.c` jumps to the asm implementation; **F12** on
  `_frame_count` in `src/sprites.s` jumps to the C definition.
- **Find All References** / **Rename** (F2) on `frame_count`, `draw_sprite` or `player_x` cover
  C, headers, assembly, and inline assembly.

**Inline assembly** (`src/main.c`, bottom of `main`)

- ca65 highlighting, instruction hovers, completion, and F12 inside `__asm__("...")`.
- Change `and #%%00000011` to `and #300`: ca65 reports a range error right on the string.

**Generated assembly**

- Click **Show Assembly** in the status bar (or the editor title icon) on `src/main.c` to see
  cc65's output beside it with addresses and bytes. Move the cursor in the C file to highlight the
  code generated for that line.

**Diagnostics**

- C diagnostics come from cc65 itself (errors and warnings as you type), including errors in
  `include/game.h` when a C file includes it.

## Build

```sh
make        # -> demo.nes
```

`nes-demo.cfg` is cc65's `nes.cfg` with a larger zero page, so `player_x` (in `src/zp.s`) fits.
