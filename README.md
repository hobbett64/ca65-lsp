# ca65-lsp

A language server for **ca65** assembly (the assembler of the [cc65](https://cc65.github.io/) suite), with a **VS Code extension** and a **Neovim plugin**. It runs `ca65` in the background for diagnostics and understands your whole workspace: definitions, references, hovers, completion and more.

- [Language server features](#language-server-features), available in every editor
- [VS Code extension](#vs-code-extension): the server plus syntax highlighting, a hex listing, status bar counters, an instruction reference panel and cc65 C mode
- [Neovim plugin](#neovim-plugin): the server plus syntax highlighting, ca65 editing settings and an instruction reference
- [Other editors](#other-editors): the standalone server

## Language server features

* **ca65-backed & LSP Diagnostics:**
    * Live validation by running `ca65` in the background and mapping errors to editor lines.
    * Built-in LSP checks for `.import`/`.importzp` and `.export`/`.exportzp` zeropage mismatches (with one-click Quick Fixes), unused symbols, and unknown `.segment` names when a linker config is configured.
    * Quick Fixes for `ca65` branch `Range error` diagnostics (invert conditional branch + trampoline `jmp`, or `bra` -> `jmp`/`brl`).
* **Code Navigation:**
    * **Go to Definition:** Jump directly to the definition of any label, constant, variable, macro, enum, struct, scope, or `.segment` / built-in segment directive (`.bss`, `.code`, `.data`, `.rodata`, `.zeropage`) in your configured `ca65.linkerConfig` `.cfg` file. Works across local, included, and workspace-exported symbols.
    * **Find All References & Safe Rename:** Find all usages across the workspace or rename symbols (`F2`) with `prepareRename` validation and cheap local (`@label`) normalization.
    * **Call Hierarchy:** See incoming and outgoing `jsr`/`jmp` (and `65816` `jsl`/`jml`) calls for procedures and labels.
    * **Document symbols:** Nested symbols for outline views, with instruction/segment-aware symbol icons, non-`CODE` segment annotations (e.g. `(ZEROPAGE)`, `(RODATA)`, `(BSS)`, `(BANK01)`), `(macro)` labels, and source-order sorting.
* **Code Intelligence:**
    * **Rich Hover Information:** Shows segment badges (`CODE`, `ZEROPAGE`, `RODATA`, etc.) alongside kind badges (`proc`, `constant`, `variable`, `enum`, `struct`, `union`, `macro`, `define`), `(N bytes)` sizes, evaluated constant values, multi-base number literal hovers (Hex, Dec, Bin), doc comments (`/** ... */` blocks rendered as Markdown with `@tag` paragraphs and clickable `{symbol}` links, or else the `;` comments above the definition and its trailing `;` comment, verbatim including the `;` markers and split by a divider; set `ca65.hoverDocs` to `docBlocks` to show only `/** ... */` blocks), a `cc65 runtime` tag on imports of cc65 runtime symbols (`pusha`, `incsp2`, `sp`, `tmp1`, ...), linker segment/memory details on `.segment "..."`, and toggleable CPU-aware lowercase instruction and directive hovers (`ca65.enableInstructionHover`, `ca65.enableDirectiveHover`, `6502`–`65816`); instruction hovers show the full reference entry, with each affected flag and a table of every addressing mode's opcode, bytes and cycles.
    * **Context-Aware Autocompletion & Snippets:** Suggests CPU-filtered mnemonics, directives, block snippets (`.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, `.repeat`, `.if*`) with automatic block-closer/branch dedent, auto-quoted `.segment`/`.include`/`.incbin`/`.asciiz`/`.literal` completions, `Scope::` members, `.tag`/`.sizeof(` types, `.segment "..."` names (prioritizing `ca65.linkerConfig`), `.include`/`.incbin` paths, `@` doc-comment tags, and auto-import/include suggestions.
    * **Signature Help:** Active parameter hints for `.macro` calls and `.define` function-like macros.
    * **Import Tracing & Anonymous Label Indexing:** Inlay hints for `.import` origins and anonymous label indices: `1:` before each declaration, `1:-` before each reference (`ca65.anonymousLabelIndexHints`).
    * **C-Style Comments & Line Continuations:** Parses `/* ... */` block comments (`ca65.cComments`) and backslash (`\`) line continuations (`ca65.lineContinuations`) across definitions, references, hovers, completions, signature help, and instruction cycle analysis.
* **Semantic Tokens:** Distinguishes instruction-followed code labels (`function`), data/ZP/BSS/RAM labels (`variable` + `readonly` on read-only segments), `.proc`, `.macro`, constants, `.enum`, `.struct`, `.scope`, and `.set` variables.
* **Code Folding:** Fold `.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, and conditional blocks.
* **Instruction reference data:** The full opcode reference for each CPU, through the custom request `ca65/getReferenceData` (params `{ uri?, cpu? }`, result `{ cpu, mnemonics }`). The VS Code panel and the Neovim `:Ref6502` command are built on it.

### Requirements

- `ca65` in your `PATH`, or set `ca65.executablePath` to the absolute path of your `ca65` executable.
- Node.js 18 or newer to run the server outside VS Code (VS Code brings its own).

### Known Limitations

* Diagnostics are mainly powered via `ca65`'s `stderr`, so they may be limited in detail, and they do not provide any diagnostics about the linking step.
* The LSP is agnostic to the actual build command your project uses, it assumes that all ca65 files are linked together for the purpose of import/export visibility.
* Macro expansion is entirely opaque to the LSP, so symbols/scopes/syntax that are affected by macro expansion will not be visible to the LSP.
* Symbols with multiple definitions will always resolve to the first definition in the same file.
* Symbol refs will always resolve to the symbol even if a macro is declared with the same name after it's declaration.
* Anonymous structs are currently not handled to spec (the spec adds the members to an anonymous scope, but `ca65` actually adds them to the parent scope).

### Settings

The settings are the same in every editor. In VS Code they're `ca65.*` settings (see the Settings UI). Elsewhere, the server reads them through the standard `workspace/configuration` request, in a `ca65` section: drop the `ca65.` prefix and nest them, e.g. `ca65.linkerConfig` becomes:

```json
{ "ca65": { "linkerConfig": "nrom256.cfg", "cpu": "6502", "includeDirs": [] } }
```

Unset settings use the same defaults everywhere.

* **`ca65.executablePath` & `ca65.fileExtensions`:** Path to `ca65` (resolved from `PATH` if unset) and workspace-watched/indexed extensions (prepopulated with `[".s", ".asm", ".inc"]`).
* **`ca65.cpu`:** Target CPU architecture: `auto` (default; the CPU implied by `ca65.cc65.target`, e.g. `6502` for `c64`/`nes`, `65C02` for `cx16`, `65SC02` for `lynx`) or an explicit `6502`, `65SC02`, `65C02`, `W65C02`, `65816` that overrides it everywhere (including cc65 C mode), driving hovers, completions, cycle/byte estimates, call hierarchy, reference guide, and `ca65 --cpu`.
* **`ca65.includeDirs` & `ca65.binIncludeDirs`:** Search paths for `.include` (defaults to `["**/include"]`) and `.incbin` (defaults to `[]`).
* **`ca65.implicitImports`:** Treats undefined symbols as implicit imports (`--auto-import`).
* **`ca65.cComments` & `ca65.lineContinuations`:** Control `--feature c_comments` and `--feature line_continuations` (both default to `true`, automatically enabled when supported by your `ca65` executable and skipped if unsupported).
* **`ca65.linkerConfig`:** Optional path to an ld65 linker configuration (`.cfg`) file (default `""`) enabling `.segment` completions, hover details, go-to-definition, `type = zp`/`rw`/`ro` segment resolution, and unknown-segment warnings.
* **`ca65.additionalArgs`:** Optional extra CLI flags passed to `ca65` (defaults to `[]`, e.g. `["-D", "DEBUG=1", "-s"]`; output flags `-o`, `-l`, `--listing`, `--create-dep`, `--create-full-dep` are ignored).

Diagnostics and UX toggles (`ca65.enableStderrDiagnostics`, `ca65.enableUnusedSymbolDiagnostics`, `ca65.enableInstructionHover`, `ca65.enableDirectiveHover`, inlay hints, `ca65.smartFolding`, `ca65.autoIncludeExtensions`) can also be configured individually.

## VS Code extension

### Installation

You can install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=hobbett.ca65-vscode-extension).

Alternatively, in VS Code, open the **Extensions** view (`Ctrl+Shift+X`), search for `ca65 Assembly`, and click **Install**. Each [release](https://github.com/hobbett64/ca65-lsp/releases) also has the `.vsix`, for **Extensions: Install from VSIX…**

### Features

Everything in [Language server features](#language-server-features), plus:

* **Syntax Highlighting:** TextMate grammar (with `/** ... */` doc tags and `Scope::` prefixes), under the server's semantic tokens.
* **Outline & Sticky Scroll:** the server's document symbols and folding ranges in VS Code's Outline view and Sticky Scroll.
* **Side-by-Side Hex & Address Listing:** Open `ca65: Show Hex & Address Listing Side-by-Side` (`$(file-binary)` editor title icon, or click the status bar counter) to inspect assembled addresses and emitted bytes aligned line-for-line with viewport-synced scrolling, or view live `ca65` errors when assembly fails.
* **Status Bar Cycle/Byte Counter & Active Segment:** Displays compact byte sizes and cycle counts (including 8/16-bit `M`/`X` ranges for `65816`) with a unified `Line | Hex | Cycles` tooltip for the current line or selection, plus the active segment at the cursor line with click-to-jump navigation to the directive that set it.
* **Instruction Reference Panel:** Open the full opcode reference for the active target CPU (`ca65.cpu`) via `ca65: Show Instruction Reference`.
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

### Requirements

- Auto-save must be enabled for reliable diagnostics.
- For cc65 C mode (work in progress): `clangd` in your `PATH` (or `ca65.clangd.path`) and a cc65 installation (`cc65` for C diagnostics, the generated assembly view and its C headers; `ca65` to check inline assembly).

### File detection

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

### VS Code settings

Besides the [language server settings](#settings):

* **`ca65.cc65.additionalArgs`:** (cc65 C mode, work in progress) Extra cc65 arguments (e.g. `["-Oirs"]`) used for C diagnostics and the generated assembly view, to match your build.
* **`ca65.cc65.executablePath` & `ca65.cc65.target`:** (cc65 C mode, work in progress) The cc65 C compiler (resolved from `PATH` if unset), used for C diagnostics, the generated assembly view and to locate cc65's headers, and the target system (`cc65 -t`, default `c64` like cc65 itself), which selects the target's predefined macros (e.g. `__NES__`), CPU, and string character set; its macros are also passed to clangd.
* **`ca65.enableCSupport`:** Turns on cc65 C mode (work in progress; off by default; needs `clangd`, and cc65 for C diagnostics and the generated assembly view). Related: `ca65.clangd.path`, `ca65.clangd.arguments` (extra clangd CLI args), `ca65.clangd.compileFlags` (extra C flags such as `"-D__C64__"`), `ca65.clangd.cc65IncludeDir` (defaults to auto-detection via `CC65_INC`, `CC65_HOME`, or the cc65 install). Use `ca65: Restart clangd (cc65 C mode)` after changing your toolchain.
* **`ca65.enableStatusBarCycleCount` & `ca65.enableStatusBarSegment`:** Show the status bar cycle/byte counter and the active segment.

Please see the Settings gear icon in the installed extension to easily set this and other settings.

### Known Limitations

* cc65 C mode needs `clangd`'s background index to find C symbols from assembly; right after startup, cross-language results may be incomplete until indexing finishes.
* cc65 C mode doesn't coordinate with other C extensions: with it enabled, disable other C language support (clangd, C/C++) for that workspace, or C files get duplicate hovers, completions, and diagnostics.
* Inline assembly features (other than highlighting) require cc65 C mode to be running. Each inline asm string is treated as one line of assembly, so a template split across literals on several lines is parsed line by line. Inline asm gets TextMate highlighting only (no semantic token colors), and the cycle/byte status bar does not cover it. A `%g` (C label) argument shows as an undeclared identifier in clangd.

## Neovim plugin

Requires Neovim 0.11 or newer and Node.js 18 or newer. With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "hobbett64/ca65-lsp",
  version = "*",   -- the latest release
  opts = {
    -- Only what you want to change; see Options below for everything, e.g.
    -- settings = { cpu = "65C02", linkerConfig = "nrom256.cfg" },
  },
}
```

On install, the plugin downloads the language server from the GitHub release of the same version, so the plugin and the server always match. If that fails (e.g. no network), it tries again when you open a ca65 file, or run `:Ca65InstallServer`. `:checkhealth ca65` checks Node.js, `ca65` and the server.

To see the segment, bytes and cycles of the current line in your status line, add `require("ca65").segment()`, `.bytes()` and `.cycles()` to it (see [Bytes, cycles and segment](#bytes-cycles-and-segment)).

What it sets up:

- `.s`, `.asm` and `.inc` files open as `ca65`, with syntax highlighting (a port of the extension's grammar) under the server's semantic tokens.
- The language server, with every standard LSP feature (see [Language server features](#language-server-features)).
- `;` comments for `gc`, `@cheap_locals` as one word, and `%` between `.proc`/`.endproc`, `.if`/`.else`/`.endif` and the other block directives.
- Enter after a label (`reset:`, `@loop: ; wait`) indents the new line one level, as in VS Code; other new lines keep the indent of the line above. Nothing you've typed is moved, and `=` leaves lines as they are. To move a line out, use `Ctrl-d` in insert mode or `<<`. The width is `'shiftwidth'`; for spaces, set `'expandtab'` (or use an `.editorconfig`).
- `/** */` doc comments: Enter continues them with ` * `, Enter right after `/**` adds the closing ` */`, and typing `/` after a ` * ` closes one. The closing ` */` also works in C files (Neovim's C support already continues ` * `).
- `:Ref6502` browses the instruction reference (in Telescope when installed); `:Ref6502 lda` shows one instruction.
- `gx` on a hover's link to a definition (`file://…#L12`) opens it in Neovim at that line.
- The segment, bytes and cycles of the current line or selection, for your status line (see below).

### Bytes, cycles and segment

Like the VS Code extension's status bar, the plugin can show, for the current line or the selection in visual mode:

- `segment()`: the segment it's in (`CODE`, `RODATA`, `ZEROPAGE`…), from the `.segment` directive above it, or ca65's default `CODE`;
- `bytes()`: its size: `3 B`, or a range such as `2–3 B` when it depends on the operand's size. Data lines (`.byte`, `.word`…) show their size from the assembler listing.
- `cycles()`: its cycle count: `4 cyc`, or a range such as `4–5 cyc` with page crossings or branches.

Neovim's status line is yours, so the plugin doesn't change it; add `require("ca65").segment()`, `.bytes()` and `.cycles()` where you want them. Neovim's classic layout with all three on the right:

```lua
vim.o.statusline = "%<%f %h%w%m%r%=%{v:lua.require'ca65'.segment()}   %{v:lua.require'ca65'.bytes()}  %{v:lua.require'ca65'.cycles()}   %-14.(%l,%c%V%) %P"
```

With lualine: `sections = { lualine_x = { function() return require("ca65").segment() end, function() return require("ca65").bytes() end, function() return require("ca65").cycles() end } }`.

They are empty outside ca65 files and in windows other than the current one. Nothing is asked until one is first called; `bytes()` and `cycles()` share one request. After that, the plugin asks the server when the cursor moves to another line, the selection changes or the text changes, with one request at a time: moves made while one is pending become a single request for wherever the cursor ends up.

### Options

Everything you can pass to `setup()` (or lazy.nvim's `opts`), with the defaults. Leave out anything you don't change.

```lua
require("ca65").setup({
  -- Language server settings: the same as the VS Code extension's ca65.* settings.
  -- Can also be a function(root_dir) returning this table, for per-project settings:
  --   settings = function(root) return { linkerConfig = "nrom256.cfg" } end,
  settings = {
    executablePath = "",                      -- path to ca65; "" finds it on your PATH
    cpu = "auto",                             -- "6502", "65SC02", "65C02", "W65C02", "65816",
                                              -- or "auto": the CPU of cc65.target
    cc65 = { target = "c64" },                -- picks the CPU when cpu = "auto" (e.g. "nes": 6502, "cx16": 65C02)
    includeDirs = { "**/include" },           -- where .include looks (project-relative paths or globs)
    binIncludeDirs = {},                      -- where .incbin looks
    linkerConfig = "",                        -- ld65 .cfg file (project-relative or absolute), for
                                              -- .segment completion, hovers, go to definition and checks
    implicitImports = false,                  -- undefined symbols are imports (ca65 --auto-import)
    cComments = true,                         -- /* */ comments (ca65 --feature c_comments)
    lineContinuations = true,                 -- \ line continuations (ca65 --feature line_continuations)
    additionalArgs = {},                      -- extra ca65 arguments, e.g. { "-D", "DEBUG=1" }
    fileExtensions = { ".s", ".asm", ".inc" },-- files the server indexes
    autoIncludeExtensions = { ".inc" },       -- files that completion offers to .include
    enableStderrDiagnostics = true,           -- errors from running ca65
    enableUnusedSymbolDiagnostics = true,     -- "symbol is never used" hints
    enableInstructionHover = true,            -- hovers on instructions (lda, jsr…)
    enableDirectiveHover = true,              -- hovers on directives (.proc, .byte…)
    hoverDocs = "any",                        -- documentation in hovers: "any" (/** */ blocks, else
                                              -- the ; comments) or "docBlocks" (only /** */ blocks)
    anonymousLabelIndexHints = true,          -- inlay hints numbering anonymous labels (1:, 1:-)
    importFromHints = true,                   -- inlay hints showing which file an import comes from
    smartFolding = true,                      -- fold .proc, .scope, .if… blocks
  },

  -- Plugin options
  root_markers = { ".git", "Makefile" },      -- the nearest one above a file is its project root
  capabilities = nil,                         -- LSP capabilities; nil: blink.cmp's or nvim-cmp's, if installed
  server = {
    cmd = nil,                                -- run your own server, e.g. { "node", "/path/server.js", "--stdio" }
    node = "node",                            -- Node.js executable for the bundled or downloaded server
  },
  close_doc_comments = true,                  -- Enter after /** adds */: true (ca65 and C files),
                                              -- a list of filetypes (e.g. { "ca65" }), or false
  open_file_links = true,                     -- gx on file://…#L12 links opens them in Neovim
})
```

Settings changed with `setup()` while Neovim is running restart the server with them.

### C files

The VS Code extension's cc65 C mode (C ↔ assembly navigation, cc65 diagnostics, the generated assembly view, inline assembly) is part of the VS Code extension, so it isn't available in Neovim. For C files, use a C language server such as clangd; the plugin only adds the closing ` */` after `/**`.

Without lazy.nvim, add the repository to your `runtimepath` with any plugin manager; `setup()` is optional. To develop the server, point the plugin at a clone and run `npm ci && npm run bundle` there: a built `server/out/server.js` in the plugin's directory is used instead of the download.

## Other editors

The language server is a standalone Node.js program that speaks the Language Server Protocol over stdio, so any editor with LSP support (Helix, Emacs, Sublime Text…) can use it. Configure its settings as described in [Settings](#settings).

Download `ca65-lsp-server-<version>.tar.gz` (or `.zip`) from the [releases](https://github.com/hobbett64/ca65-lsp/releases) and start the server with:

```
node /path/to/ca65-lsp-server-<version>/server/out/server.js --stdio
```

Keep `server/out/` and `server/data/` side by side: the server loads its instruction and directive data from `server/data/`. `ca65` must be on your `PATH` (or set `ca65.executablePath`) for diagnostics, as in VS Code.

To build it from source instead (Node.js 18 or newer):

```
git clone https://github.com/hobbett64/ca65-lsp
cd ca65-lsp
npm ci
npm run bundle
```

This produces `server/out/server.js`. Run `npm run bundle` again after pulling updates.

## Running Tests
```
npm test
```

## AI Usage Disclosure

Most of this project was vibe coded with AI assistance. Bug reports, issues, and pull requests are welcome!

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
