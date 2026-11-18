# ca65 Assembly for Visual Studio Code

Provides basic LSP-backed language support for **ca65** assembly files.

## Features

This extension provides a full-featured language server to make writing `ca65` assembly a modern and productive experience.

* **ca65-backed & LSP Diagnostics:**
    * Live validation by running `ca65` in the background and mapping errors to editor lines.
    * Built-in LSP checks for `.import`/`.importzp` and `.export`/`.exportzp` zeropage mismatches (with one-click Quick Fixes), unused symbols, and unknown `.segment` names when a linker config is configured.
    * Quick Fixes for `ca65` branch `Range error` diagnostics (invert conditional branch + trampoline `jmp`, or `bra` -> `jmp`/`brl`).
* **Code Navigation:**
    * **Go to Definition:** Jump directly to the definition of any label, constant, variable, macro, enum, struct, scope, or `.segment` / built-in segment directive (`.bss`, `.code`, `.data`, `.rodata`, `.zeropage`) in your configured `ca65.linkerConfig` `.cfg` file. Works across local, included, and workspace-exported symbols.
    * **Find All References & Safe Rename:** Find all usages across the workspace or rename symbols (`F2`) with `prepareRename` validation and cheap local (`@label`) normalization.
    * **Call Hierarchy:** See incoming and outgoing `jsr`/`jmp` (and `65816` `jsl`/`jml`) calls for procedures and labels.
    * **Outline view:** Nested file outline with instruction/segment-aware symbol icons, non-`CODE` segment annotations (e.g. `(ZEROPAGE)`, `(RODATA)`, `(BSS)`, `(BANK01)`), `(macro)` labels, and source-order sorting.
* **Code Intelligence:**
    * **Rich Hover Information:** Shows segment badges (`CODE`, `ZEROPAGE`, `RODATA`, etc.) alongside kind badges (`proc`, `constant`, `variable`, `enum`, `struct`, `union`, `macro`, `define`), `(N bytes)` sizes, evaluated constant values, multi-base number literal hovers (Hex, Dec, Bin), verbatim `;` and `/** ... */` doc comments, a `cc65 runtime` tag on imports of cc65 runtime symbols (`pusha`, `incsp2`, `sp`, `tmp1`, ...), linker segment/memory details on `.segment "..."`, and toggleable CPU-aware lowercase instruction and directive hovers (`ca65.enableInstructionHover`, `ca65.enableDirectiveHover`, `6502`–`65816`) with a **See details** link into the Reference panel.
    * **Context-Aware Autocompletion & Snippets:** Suggests CPU-filtered mnemonics, directives, block snippets (`.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, `.repeat`, `.if*`) with automatic block-closer/branch dedent, auto-quoted `.segment`/`.include`/`.incbin`/`.asciiz`/`.literal` completions, `Scope::` members, `.tag`/`.sizeof(` types, `.segment "..."` names (prioritizing `ca65.linkerConfig`), `.include`/`.incbin` paths, `@` doc-comment tags, and auto-import/include suggestions.
    * **Signature Help:** Active parameter hints for `.macro` calls and `.define` function-like macros.
    * **Import Tracing & Anonymous Label Indexing:** Inlay hints for `.import` origins and `(1)`/`(2)` anonymous label indices (`ca65.anonymousLabelIndexHints`).
    * **C-Style Comments & Line Continuations:** Parses `/* ... */` block comments (`ca65.cComments`) and backslash (`\`) line continuations (`ca65.lineContinuations`) across definitions, references, hovers, completions, signature help, and instruction cycle analysis.
* **Editor & Assembly Tools:**
    * **Syntax Highlighting & Semantic Tokens:** TextMate grammar (with `/** ... */` doc tags and `Scope::` prefixes) paired with LSP semantic tokens distinguishing instruction-followed code labels (`function`), data/ZP/BSS/RAM labels (`variable` + `readonly` on read-only segments), `.proc`, `.macro`, constants, `.enum`, `.struct`, `.scope`, and `.set` variables.
    * **Side-by-Side Hex & Address Listing:** Open `ca65: Show Hex & Address Listing Side-by-Side` (`$(file-binary)` editor title icon, or click the status bar counter) to inspect assembled addresses and emitted bytes aligned line-for-line with viewport-synced scrolling, or view live `ca65` errors when assembly fails.
    * **Status Bar Cycle/Byte Counter & Active Segment:** Displays compact byte sizes and cycle counts (including 8/16-bit `M`/`X` ranges for `65816`) with a unified `Line | Hex | Cycles` tooltip for the current line or selection, plus the active segment at the cursor line with click-to-jump navigation to the directive that set it.
    * **Code Folding & Sticky Scroll:** Fold `.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, and conditional blocks.
    * **Instruction Reference Panel:** Open the full opcode reference for the active target CPU (`ca65.cpu`) via `ca65: Show Instruction Reference`, or click **See details** on any instruction hovercard to jump straight to that opcode.
* **cc65 C mode (work in progress) — C ↔ assembly support for cc65 projects:**
    * *This feature is still in development: behavior and settings may change between releases. Feedback and bug reports are welcome.*
    * **Off by default:** turn on `ca65.enableCSupport` ("Enable C Support") in the workspaces where you want it. If you use another C extension (clangd, C/C++), disable it for those workspaces, or C files will get results from both.
    * Runs `clangd` for the workspace's C files, preconfigured for the cc65 dialect (cc65 headers, 16-bit `int`/pointers, unsigned `char`, `__fastcall__`, `__asm__`, `__AX__`, etc.), using a compile database generated in the extension's storage (your workspace's own `compile_commands.json` is used instead if present).
    * Links C symbols to global assembly symbols using the cc65 naming convention (`foo` in C ↔ `_foo` in assembly):
        * **Go to Definition** on a C prototype jumps to the `.proc _foo`/`_foo:` implementation; on an asm `.import _bar` implemented in C it jumps to the C definition. **Go to Declaration** in assembly jumps to the C declaration (the prototype or `extern` in the header), like Go to Declaration in C.
        * **Hover** in C files is clangd's own (signature and the header's documentation). In assembly, a symbol implemented in assembly shows its asm hovercard followed by its C declaration (the prototype or `extern` line), and one implemented in C shows clangd's hovercard.
        * **Find All References** and **Rename** (`F2`) cover both languages from either side. Renaming from assembly requires the new name to keep the `_` prefix.
    * Only C symbols with external linkage are linked; locals and `static` symbols are left alone.
    * **Calling convention in hovers:** C prototypes shown in assembly hovers include `__fastcall__`/`__cdecl__` (cc65's default is shown when the declaration has neither; `--all-cdecl` in `ca65.cc65.additionalArgs` switches it).
    * **Create assembly stub:** on a C prototype that nothing implements yet, the code action **Create assembly stub for `name`** appends an `.export`/`.proc` stub with comments saying where cc65 passes each argument, what to return, and how many bytes to pop, to an asm file you pick (or a new one).
    * See [`examples/cc65-c-mode`](examples/cc65-c-mode) for a small NES project to try all of this.
    * **Generated assembly view:** `ca65: Show Generated Assembly (cc65) Side-by-Side` (`$(file-code)` editor title icon or **Show Assembly** in the status bar on C files) opens a read-only view of the assembly cc65 generates for the current file (including unsaved changes) beside it, with each C line's source shown as a comment and the address and bytes of every instruction in hex listing columns (`addr  bytes | code`). Moving the cursor in the C file highlights the assembly generated for that line (for an `#include` line, the imports of the symbols the header declares and any code it defines), and clicking in the assembly highlights the C line it came from. The view refreshes as you edit.
    * **Diagnostics come from cc65 itself** instead of clangd: open C files are compiled in the background (including unsaved changes) with `ca65.cc65.target`, errors in included headers are shown on the headers, and cc65's output is assembled with ca65 to also catch inline asm operand errors (e.g. range errors) on the exact `__asm__` string. clangd's diagnostics are only shown if cc65 is not found.
    * **Inline assembly** (`__asm__("...")` / `asm("...")`) in C files behaves like ca65 code: ca65 syntax highlighting (with cc65 `%b`/`%w`/`%v`/`%o`/`%g` placeholders), instruction and symbol hovers, completion, Go to Definition, Find All References, and Rename. Inline uses are part of references and renames started from C or assembly, and `%v` arguments are seen by clangd as normal C references.
    
## Known Limitations

* Diagnostics are mainly powered via `ca65`'s `stderr`, so they may be limited in detail, and they do not provide any diagnostics about the linking step.
* The LSP is agnostic to the actual build command your project uses, it assumes that all ca65 files are linked together for the purpose of import/export visibility.
* Macro expansion is entirely opaque to the LSP, so symbols/scopes/syntax that are affected by macro expansion will not be visible to the LSP.
* Symbols with multiple definitions will always resolve to the first definition in the same file.
* Symbol refs will always resolve to the symbol even if a macro is declared with the same name after it's declaration.
* cc65 C mode needs `clangd`'s background index to find C symbols from assembly; right after startup, cross-language results may be incomplete until indexing finishes.
* cc65 C mode doesn't coordinate with other C extensions: with it enabled, disable other C language support (clangd, C/C++) for that workspace, or C files get duplicate hovers, completions, and diagnostics.
* Inline assembly features (other than highlighting) require cc65 C mode to be running. Each inline asm string is treated as one line of assembly, so a template split across literals on several lines is parsed line by line. Inline asm gets TextMate highlighting only (no semantic token colors), and the cycle/byte status bar does not cover it. A `%g` (C label) argument shows as an undeclared identifier in clangd.
* Anonymous structs are currently not handled to spec (the spec adds the members to an anonymous scope, but `ca65` actually adds them to the parent scope).

## Pre-requisites
- You must provide the `ca65` in your system's `PATH` or set setting `ca65.executablePath` to the absolute path of your `ca65` executable.
- Auto-save must be enabled for reliable diagnostics.
- For cc65 C mode (work in progress): `clangd` in your `PATH` (or `ca65.clangd.path`) and a cc65 installation (`cc65` for C diagnostics, the generated assembly view and its C headers; `ca65` to check inline assembly).

## Installation

You can install this extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=hobbett.ca65-vscode-extension).

Alternatively, in VS Code, open the **Extensions** view (`Ctrl+Shift+X`), search for `ca65 Assembly`, and click **Install**.

## File detection

By default, `.s`, `.asm`, and `.inc` files are detected as `ca65` language.

If you wish to add more extensions to be included, simply add them to `files.associations` in settings.

e.g.
```
"files.associations": {
    "*.incs": "ca65",
    "*.a65": "ca65",
    "*.mycoolextension": "ca65"
}
```

Use `ca65.fileExtensions` (defaulting to `[".s", ".asm", ".inc"]`) to configure which file extensions the language server watches and indexes.

## Other settings

Configure structured assembler and editor settings via the VS Code Settings UI:

* **`ca65.executablePath` & `ca65.fileExtensions`:** Path to `ca65` (resolved from `PATH` if unset) and workspace-watched/indexed extensions (prepopulated with `[".s", ".asm", ".inc"]`).
* **`ca65.cpu`:** Target CPU architecture: `auto` (default; the CPU implied by `ca65.cc65.target`, e.g. `6502` for `c64`/`nes`, `65C02` for `cx16`, `65SC02` for `lynx`) or an explicit `6502`, `65SC02`, `65C02`, `W65C02`, `65816` that overrides it everywhere (including cc65 C mode), driving hovers, completions, cycle/byte estimates, call hierarchy, reference guide, and `ca65 --cpu`.
* **`ca65.includeDirs` & `ca65.binIncludeDirs`:** Search paths for `.include` (defaults to `["**/include"]`) and `.incbin` (defaults to `[]`).
* **`ca65.implicitImports`:** Treats undefined symbols as implicit imports (`--auto-import`).
* **`ca65.cComments` & `ca65.lineContinuations`:** Control `--feature c_comments` and `--feature line_continuations` (both default to `true`, automatically enabled when supported by your `ca65` executable and skipped if unsupported).
* **`ca65.linkerConfig`:** Optional path to an ld65 linker configuration (`.cfg`) file (default `""`) enabling `.segment` completions, hover details, go-to-definition, `type = zp`/`rw`/`ro` segment resolution, and unknown-segment warnings.
* **`ca65.cc65.additionalArgs`:** (cc65 C mode, work in progress) Extra cc65 arguments (e.g. `["-Oirs"]`) used for C diagnostics and the generated assembly view, to match your build.
* **`ca65.cc65.executablePath` & `ca65.cc65.target`:** (cc65 C mode, work in progress) The cc65 C compiler (resolved from `PATH` if unset), used for C diagnostics, the generated assembly view and to locate cc65's headers, and the target system (`cc65 -t`, default `c64` like cc65 itself), which selects the target's predefined macros (e.g. `__NES__`), CPU, and string character set; its macros are also passed to clangd.
* **`ca65.enableCSupport`:** Turns on cc65 C mode (work in progress; off by default; needs `clangd`, and cc65 for C diagnostics and the generated assembly view). Related: `ca65.clangd.path`, `ca65.clangd.arguments` (extra clangd CLI args), `ca65.clangd.compileFlags` (extra C flags such as `"-D__C64__"`), `ca65.clangd.cc65IncludeDir` (defaults to auto-detection via `CC65_INC`, `CC65_HOME`, or the cc65 install). Use `ca65: Restart clangd (cc65 C mode)` after changing your toolchain.
* **`ca65.additionalArgs`:** Optional extra CLI flags passed to `ca65` (defaults to `[]`, e.g. `["-D", "DEBUG=1", "-s"]`; output flags `-o`, `-l`, `--listing`, `--create-dep`, `--create-full-dep` are ignored).

Diagnostics and UX toggles (`ca65.enableStderrDiagnostics`, `ca65.enableUnusedSymbolDiagnostics`, `ca65.enableInstructionHover`, `ca65.enableDirectiveHover`, inlay hints, status bar indicators, `ca65.smartFolding`, `ca65.autoIncludeExtensions`) can also be configured individually.

Please see the Settings gear icon in the installed extension to easily set this and other settings.

## Running Tests
```
npm test
```

## AI Usage Disclosure

Most of this project was vibe coded with AI assistance. Bug reports, issues, and pull requests are welcome!

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
