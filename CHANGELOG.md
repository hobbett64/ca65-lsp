# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.9.1] - 2026-11-22
### Changed
- Neovim plugin: indenting is simpler. Enter after a label (a line whose code ends in `:`) indents the new line one level, as in VS Code, and other new lines keep the indent of the line above. Lines are no longer moved as you type (labels on `:`, `.endscope` and `.else` to their block), and `=` leaves lines as they are instead of reindenting them.

## [2.9.0] - 2026-11-22
### Added
- Neovim plugin: indenting for ca65 files (`indent/ca65.lua`). Labels, constants and directives sit at the block's level, instructions and data one level in. Enter after a label indents, as in VS Code; typing a label's `:` after code moves it back out, and `.endscope`/`.endproc` line up with their block. Nested `.scope`/`.proc`/`.macro` blocks indent their contents, except a `.scope` wrapping the whole file. `=` reindents with the same rules.

## [2.8.2] - 2026-11-22
### Fixed
- Call hierarchy: preparing it works in files that aren't open in the editor too (they were scanned with the workspace). Clients that prepare each caller again by position to walk further up the hierarchy, like telescope-hierarchy.nvim in Neovim, now go past the first level instead of stopping with no callers.

## [2.8.1] - 2026-11-22
### Fixed
- Call hierarchy: a call to a qualified name (`jsr Gfx::init`) is a call to `Gfx::init` only. The scopes that qualify it (`Gfx`) no longer show up as called too, in outgoing calls, or with the caller in their incoming calls.

## [2.8.0] - 2026-11-22
### Added
- Neovim plugin: `require("ca65").segment()`, `.bytes()` and `.cycles()` give the segment, size and cycle count of the current line, or of the selection in visual mode (`CODE`, `3 B`, `4 cyc`), for your status line, like the VS Code extension's status bar. The README shows how to add them to Neovim's status line or lualine. They ask the language server only once something calls them, with at most one request in flight, so moving the cursor quickly never builds up a backlog.

## [2.7.3] - 2026-11-22
### Fixed
- Neovim plugin: in doc comments, `@preserves` and `@clobbers` (and `@preserve`, `@clobber`) highlight every item in the list, with or without commas (`@preserves a, x, y`, `@clobbers a x`), not just the first, as in VS Code.

## [2.7.2] - 2026-11-21
### Added
- Neovim plugin: Enter right after `/**` also adds the closing ` */` in C files. The `close_doc_comments` option can also be a list of filetypes.

### Changed
- README: the Neovim section lists every setting and option with its default, and says what's available for C files.

## [2.7.1] - 2026-11-21
### Fixed
- Neovim plugin: downloading the language server when the plugin is installed or updated (lazy.nvim's build step) reported success but left no server behind, so it was only downloaded when the first ca65 file was opened.

### Changed
- README reorganized: the language server's features first, then sections for the VS Code extension, the Neovim plugin and other editors.

## [2.7.0] - 2026-11-21
### Added
- Neovim plugin: this repository can be installed as a Neovim plugin (0.11 or newer), e.g. `{ "hobbett64/ca65-lsp", version = "*" }` with lazy.nvim. It downloads the language server of the same version from the GitHub release, starts it for `.s`, `.asm` and `.inc` files, and adds ca65 syntax highlighting, `/** */` doc comment continuation, `%` between block directives, the `:Ref6502` instruction reference, and `:checkhealth ca65`. See the README.
- Each release includes the standalone language server for other editors (`ca65-lsp-server-<version>.tar.gz` and `.zip`), built by a release workflow along with the `.vsix`.

### Changed
- The repository is now `hobbett64/ca65-lsp` (formerly `ca65-vscode-extension-64`; old links redirect). The VS Code extension itself is unchanged.

## [2.6.4] - 2026-11-21
### Changed
- Instruction hovers show the full reference entry: each affected flag with its effect, and a table of every addressing mode with its opcode, bytes and cycles. This replaces the summary line and the "See details" link; the reference panel is still available as **ca65: Show Instruction Reference**.
- The addressing mode table's columns are padded so they line up in editors that show hover Markdown as text (e.g. Neovim). VS Code draws the table as before.

### Added
- README: how to build and run the language server on its own for other editors, with settings and a Neovim example.

## [2.6.3] - 2026-11-21
### Changed
- Cheap local names in hovers and completion docs keep the `@` outside the bold (`` Scope::routine@**local** ``). Hovers no longer contain an invisible U+2060 word joiner, which other editors (e.g. Neovim) displayed as `<2060>`.

## [2.6.2] - 2026-11-21
### Fixed
- A lone `.` (e.g. a period ending a sentence in a comment) counted as a word, so with the cursor on one every other period in the file was highlighted, and double-click selected it as a word. A leading `.` is now only part of a word when a letter follows it, as in `.byte`.

## [2.6.1] - 2026-11-20
### Changed
- `/** ... */` doc comment tags render like VS Code's TypeScript hovers: the tag's targets (the name of `@param`/`@input`/`@output`, the symbols of `@see`/`@modifies`/`@uses`, the registers of `@clobbers`/`@preserves`) show as code, linked when they resolve to a symbol, followed by an em dash and the description (e.g. *@param* `count` — loop count). Tags without targets show the dash before their text (*@return* — carry set on error); text spanning several lines starts on its own line instead.
- Doc tags (`@param`, `@see`, …) are only highlighted in `/** ... */` blocks at the start of a line (after the `*` gutter or right after `/**`), matching where hovers render them. `{symbol}` links are still highlighted in every comment.
- Cheap locals show hovercards again: labels show their segment, parent-qualified name and size (e.g. `` `CODE` Gfx::drawSprite@exit ``); cheap locals defined by assignment show a `const` (or `var` for `.set`) badge and the expression they stand for (e.g. ``const Gfx::drawSprite@tile = `r0` ``).

### Fixed
- HTML tags in `/** ... */` doc comments (e.g. Javadoc's `<p>`) hid the rest of the paragraph in hovers. Common Javadoc HTML is now converted to Markdown (`<p>` paragraphs, `<br>` line breaks, `<b>`/`<strong>`, `<i>`/`<em>`, `<code>`, `<ul>`/`<ol>`/`<li>` lists) and any other tag is shown as written; code spans, fenced code and `<https://...>` links are unchanged.
- Cheap locals defined by assignment (`@x = expr`, `@x := expr`, `@x .set expr`) were added to the enclosing scope as `Scope::@x`, so two routines defining the same `@x` resolved to one of them. They are now scoped between normal labels like `@x:` labels, with go to definition, references, rename, highlights and completion.

## [2.6.0] - 2026-11-20
### Added
- `ca65.hoverDocs`: `any` (default) shows `/** ... */` blocks or `;` comments as hover documentation; `docBlocks` shows only `/** ... */` blocks.

### Changed
- Anonymous label index hints now sit just left of the colon, without parentheses: `1:` on declarations, `1:-` / `2:++` on references.
- Hover doc comments: a `/** ... */` block above a definition is rendered as Markdown (delimiters and `*` gutter stripped, each `@tag` in its own paragraph, `{symbol}` / `{@link symbol}` / tag targets as inline links instead of a *See:* line). Without one, the `;` comments above are shown verbatim (including the `;` markers) followed by a divider and the definition line's trailing `;` comment. Applies to hovers, completion details, and macro signature help.

## [2.5.0] - 2026-11-18
### Added
- Hovers of imports provided by the cc65 runtime library (`pusha`, `popax`, `incsp2`, `sp`, `tmp1`, ...) are tagged `cc65 runtime`.
- **cc65 C mode (work in progress)**: C support for mixed C/assembly cc65 projects. Behavior and settings may still change.
  - Runs `clangd` for the workspace's C files (off by default; enable with `ca65.enableCSupport`) with a generated cc65-dialect compile database (cc65 headers, 16-bit `int`/pointers, unsigned `char`, `__fastcall__`/`__asm__`/`__AX__` shims).
  - Links C symbols with global assembly symbols (`foo` ↔ `_foo`) for Go to Definition, Find All References, and Rename in both directions, plus Go to Declaration from assembly to the C declaration. Hovers in C files are clangd's own; in assembly, symbols implemented in assembly show the asm hovercard followed by their C declaration (prototype including `__fastcall__`/`__cdecl__`), and symbols implemented in C show clangd's hovercard.
  - **Create assembly stub** code action for C prototypes that nothing implements yet, documenting where cc65 passes each argument, what to return, and how many bytes to pop (verified against cc65's generated code).
  - **Inline assembly** (`__asm__("...")`/`asm("...")`): ca65 highlighting, hovers, completion, Go to Definition, Find All References, and Rename inside the string. Inline uses take part in cross-language references and renames, and `%v` arguments stay visible to clangd.
  - **cc65 diagnostics** for C files instead of clangd's: open C files are compiled with cc65 as you type, header errors are reported on the headers, and the output is assembled with ca65 to report inline asm errors on the `__asm__` string.
  - **Generated assembly view** (`ca65: Show Generated Assembly (cc65) Side-by-Side`, or **Show Assembly** in the status bar of C files): read-only cc65 output for the current C file beside it, with address/bytes columns, C ↔ assembly line highlighting (including file-scope variables, and for `#include` lines the imports and code their header produces), and live refresh.
  - Settings: `ca65.cc65.executablePath`, `ca65.cc65.target` (default `c64`, like cc65), `ca65.cc65.additionalArgs`, `ca65.enableCSupport`, `ca65.clangd.path`, `ca65.clangd.arguments`, `ca65.clangd.compileFlags`, `ca65.clangd.cc65IncludeDir`; command `ca65: Restart clangd (cc65 C mode)`.
  - `examples/cc65-c-mode` in the repository: a small NES project to try it.

### Changed
- `ca65.cpu` defaults to the new `auto`, which uses the CPU implied by `ca65.cc65.target` (`6502` for the default `c64`, so existing setups are unchanged). An explicit CPU now also applies to cc65 C mode (`--cpu`).
- The hex listing and the generated assembly view use a dedicated `ca65 Listing` syntax: dimmed addresses and `rr`/`xx` placeholders, highlighted bytes, and ca65 highlighting for the code (tabs are now titled `<file> (listing)` / `<file> (assembly)`).
- The extension now also activates in workspaces containing `.s`/`.asm` files (not only when a ca65 file is opened), so cc65 C mode is available when a C file is opened first.

## [2.4.0] - 2026-11-17
### Added
- Support for symbol identification in C-style doc comments, which enable hover support, go-to-definition, symbol renaming, etc in the comment itself when wrapped in {} or after an annotation (e.g. @see, @input, @clobber). Also provides a "See <symbol>" line in the hover card that provides hyperlinks to all of the referenced symbols.

## [2.3.0] - 2026-11-16
### Added
- Shared `ca65 -l` listing cache (`listingCache`) reusing background validation results across diagnostics, the side-by-side hex listing, and the status bar byte/cycle analyzer.
- Optional **ld65 linker configuration (`.cfg`) integration** via `ca65.linkerConfig` (default `""`):
  - Enriches `.segment "..."` autocomplete (showing `.cfg` segments first with `type`, `load`/`run`, and memory bounds) and hovercards.
  - Supports Go to Definition (`F12`) from `.segment "NAME"` and built-in segment directives (`.bss`, `.code`, `.data`, `.rodata`, `.zeropage`) directly to the `.cfg` segment definition.
  - Resolves `type = zp` / `rw` / `bss` / `ro` segments for `.import`/`.importzp` checks, semantic token classification, and `unknown-linker-segment` warnings, with automatic revalidation on `.cfg` edits.
- **Branch-out-of-range Quick Fix:** Offers one-click fixes on `ca65` `Range error` diagnostics to invert conditional branches (`beq`/`bne`/`bcc`/`bcs`/`bmi`/`bpl`/`bvc`/`bvs`, 65C02 `bbr0`–`bbr7`/`bbs0`–`bbs7`) with a `:+` trampoline `jmp`, or replace `bra` with `jmp` (`brl` on `65816`).
- Added **`ca65.enableInstructionHover`** and **`ca65.enableDirectiveHover`** settings (`default: true`) to toggle opcode and directive hovercards independently.
- Added JSDoc-style `@` annotation completions (`@param`, `@returns`, `@clobbers`, `@preserves`, `@modifies`, `@uses`, `@note`, `@warning`, etc.) in block comments alongside `#jsdoc-tags` and `Scope::` namespace-prefix TextMate grammar highlighting.

### Changed
- **Instruction Hovercard & Reference Panel:**
  - Replaced the Markdown preview with a dedicated, theme-aware `WebviewPanel` (`ca65 Reference`) so clicking **See details** jumps directly to and highlights the target opcode, reuses the open panel across clicks, and supports in-page `#anchor` and `↑ Top` navigation.
  - Streamlined instruction hovercards to show compact `Affected flags` and badge-styled `Addressing modes` with a **See details** link (while keeping detailed flag/mode tables in completion item resolution).
  - Normalized instruction titles, addressing modes (`Zero page`, `Direct page`, `Absolute long`, `Stack relative`, etc.), table headers, and prose to consistent sentence case, and made `CLD`/`SED` descriptions platform-neutral.
- **Listing & Status Bar Polish:**
  - Unified the status bar counter (`$(file-binary) <bytes> $(clock) <cycles>`) and `Line | Hex | Cycles` tooltip (showing `n/a` for non-instruction lines and disabling click-to-open when assembly fails).
  - Updated `ca65.showHexListing` to open in the same side split with viewport-synced scrolling, cleaner formatting without `;` prefixes, and live `ca65` stderr errors instead of stale hex when assembly fails.
- **Hovercard, Completion, & Syntax Polish:**
  - Standardized symbol sizes to `(1 byte)` / `(N bytes)` across labels and struct fields, omitted `'label'` badges and `Defined in ...` footers, suppressed cheap local/anonymous hovercards, and restored verbatim ```` ```ca65 ```` doc comments.
  - Updated label completions to display actual segment names (`ZEROPAGE`, `BANK01`, etc.) and `'cheap local'`, auto-quoted `.segment`, `.include`, `.incbin`, `.asciiz`, and `.literal` completions (`"$0"` + auto-suggest for segment/path directives), added opener-matched autocomplete dedent for block closers (`.endproc`, `.endmacro`/`.endmac`, `.endscope`, `.endstruct`, `.endunion`, `.endenum`, `.endrepeat`/`.endrep`, `.endif`, `.else`, `.elseif`), and set `"editor.suggest.snippetsPreventQuickSuggestions": false` for `[ca65]` so autocomplete remains active inside `.if`/`.ifdef`/`.repeat` snippet headers.
  - Promoted instruction-followed and stacked labels to `SymbolKind.CodeLabel` (`function` semantic tokens & outline icons across custom segments), using segments / `.cfg` to distinguish mutable vs. `readonly` data and classify macro/empty labels, and changed the generic TextMate label fallback from `entity.name.function.ca65` to `entity.name.label.ca65`.

## [2.2.0] - 2026-11-16
### Added
- Full support for C-style block comments (`/* ... */` / `--feature c_comments`) and backslash line continuations (`\` / `--feature line_continuations`) across document scanning, hovers, completions, signature help, comment masking, and instruction cycle analysis.
- Added **`ca65.fileExtensions`** (prepopulated with `[".s", ".asm", ".inc"]`), **`ca65.cComments`** (`default: true`, auto-skipping if unsupported by your `ca65` executable), and **`ca65.enableStderrDiagnostics`** (`default: true`), with settings reordered into executable, extensions, assembler options, and UX toggles.
- JSDoc-style `/** ... */` auto-closing, `Enter` expansion and `* ` continuation, `unIndentedLinePattern` alignment rules, and verbatim `ca65` doc-comment rendering across hovers, completions, and signature help (preserving monospace alignment and comment structure).
- Surfaced un-located `ca65:` CLI error lines (such as invalid flags in `ca65.additionalArgs`) as deduplicated error notifications instead of dropping them silently.

### Changed
- Defaulted `ca65.lineContinuations` and `ca65.anonymousLabelIndexHints` to `true` (with automatic fallback if your `ca65` executable lacks `--feature line_continuations`), and normalized `ca65.additionalArgs` to explicitly default to `[]` while ignoring `-o`, `-l`, `--listing`, `--create-dep`, and `--create-full-dep`.
- Deprecated `ca65.enableCa65StdErrDiagnostics` (in favor of `ca65.enableStderrDiagnostics`) and `ca65.additionalExtensions` (in favor of `ca65.fileExtensions`) with full backwards-compatible runtime fallback.
- Replaced the `glob` dependency tree with a built-in recursive file/directory matcher, bundled extension client/server entry points with `esbuild`, removed unused `package-lsp` scripts, and consolidated the `ca65.dump*` debug commands into `ca65.dumpDebugInfo`.

### Fixed
- Parsed optional `.segment "NAME": address_size` modifiers (`zeropage`/`zp`/`direct`, `absolute`/`abs`/`near`, `far`, `long`/`dword`) cleanly so custom zero-page and far segments work across segment names/completions, semantic tokens, `.importzp` diagnostics/Quick Fixes, outline icons, and instruction size/cycle estimation.
- Stopped `.include` directives from overwriting the active segment with synthetic `segment from ...` labels, skipped transparent directives (`.repeat`, `.assert`, `.if`/`.else`/`.endif`, etc.) when inferring post-label kind, and recognized null/newline-terminated `.byte`/`.byt` string lists as string labels.
- Fixed cross-file `.import`/`.importzp` diagnostic revalidation when an exporter's segment or `.exportzp` changes, `-I` include-directory stderr URI resolution, range-filtered/fallback inlay hints, `cComments`/`lineContinuations` gating in scanner/comment utilities, live `ca65.fileExtensions` watcher/index updates, and typing-time multi-root `ca65` CLI throttling on shared `.inc` edits.

## [2.1.0] - 2026-11-16
### Added
- **Active Segment Status Bar Indicator** (`ca65.enableStatusBarSegment`): Shows the active segment for the cursor line (tracking `.segment`, `.code`, `.zeropage`, `.rodata`, `.bss`, `.data`, and `.pushseg`/`.popseg`) with click-to-jump navigation to the directive that set it.
- **Byte-Size Evaluation in Hover Cards:** Evaluates and displays `[size]` byte counts for data labels, `.res`, `.byte`/`.word`/`.dword`/`.addr`/`.faraddr`/`.asciiz`/`.literal`, `.incbin`, `.struct`/`.union`, `.proc`, `.tag` fields, and cheap local (`@label`) labels, including `.sizeof(...)` and `.strlen(...)` expression evaluation.
- **Number Literal Hover:** Hovering hexadecimal (`$...`), binary (`%...`), or decimal number literals displays normalized Hex, Dec, and Bin equivalents.
- **Context-Aware Completions:**
  - Added `.tag` and `.sizeof(` completions filtering to `.struct` and `.union` definitions (including `Scope::` qualification and auto-include suggestions).
  - Added `.segment "..."` completions suggesting segment names declared in the current file, open workspace files, and standard ca65 segments (`CODE`, `ZEROPAGE`, `RODATA`, `BSS`, `DATA`).
  - Added hover-style preview documentation resolution for cheap local (`@label`) completion items.
- **Segment-Aware Semantic Tokens:** Classifies `CODE` labels as functions, `.res`/zero-page/`BSS`/`DATA` labels as variables, and `RODATA`/data/string definitions with the `readonly` modifier.

### Changed
- **Hover Card Polish & Lowercase Mnemonics:**
  - Reverted segment pills to actual uppercase segment names (e.g., `` `CODE` ``, `` `ZEROPAGE` ``, `` `RODATA` ``) paired with unstyled normal-weight kind badges (`label`, `proc`, `constant`, `variable`, `enum`, `struct`, `union`, `macro`, `define`).
  - Cheap local (`@label`) hovers now show their segment badge, `label` badge, byte size, and full parent-qualified name with bolded `@name` (e.g., `` `CODE` label myscope::mylabel@mylocallabel ``).
  - Anonymous label hovers now display their segment badge, `anonymous label` kind, and 1-based index (e.g., `` `CODE` anonymous label **1** ``).
  - Standardized 6502/65C02/65816 assembly mnemonics to lowercase across hover cards, status bar cycle tooltips, completions, and the Instruction Reference view.
- **Outline Segment Labels:** Replaced `(zp)` outline annotations with non-`CODE` actual segment names (e.g., `(ZEROPAGE)`, `(DIRECTPAGE)`, `(RODATA)`, `(BSS)`, `(BANK01)`) while keeping `CODE` symbols uncluttered.
- Consolidated cursor-based status bar updaters in `client/src/extension.ts`.

## [2.0.0] - 2026-11-15
### Added
- Target CPU selection via `ca65.cpu` (`6502`, `65SC02`, `65C02`, `W65C02`, and `65816`) updating `ca65` diagnostics, hover cards, autocompletion, status-bar byte/cycle estimates (including min–max `M`/`X` ranges for `65816`), `jsl`/`jml` call hierarchy, and the `ca65: Show Instruction Reference` panel.
- Side-by-side read-only `ca65 -l` hex & address listing view (`ca65.showHexListing`).
- Status bar byte-size and cycle-count estimator for the active line or selection (`ca65.enableStatusBarCycleCount`).
- LSP Semantic Tokens for explicit ca65 constructs (`.proc`, `.macro`, `.define`, `=` constants, `.enum`/members, `.struct`/`.union`, `.scope`, `.set` variables).
- Code Actions & Quick Fixes for unresolved symbols (auto-`.import`/`.importzp`, `.include`, or cross-file `.export` + `.import`), unused symbol removal/export, `.import`/`.importzp` mismatches, and decimal/hex/binary number base conversions.
- Diagnostics for `.import`/`.importzp` and `.export`/`.exportzp` mismatches across zero-page and direct-page segments (`ZEROPAGE`, `ZP`, `DIRECTPAGE`, `DP`).
- Signature help for `.macro` calls and parameterized `.define` macros, plus `Scope::` and `.include`/`.incbin` path completions.
- Support for `ca65.additionalArgs` (forwarded to `ca65` diagnostics and listing generation).
- `prepareRename` validation and `@`-prefix preservation for cheap local label renames.
- In-repo unit and E2E test suite (`npm test` via `test/run_all.js`).

### Changed
- **Performance & LSP Architecture Refactor:**
  - Rewrote hot scanning and lookup paths for large workspaces, including single-pass scanning (`documentScanner`), cached symbol/export/include-graph/path/executable resolutions, and shared unopened-document caching (`documentCache`).
  - Overhauled live `ca65` validation (`assembleTranslationUnit`) with `AbortController` cancellation, shared compilation for diagnostics and listings, and lightweight on-demand shadow directories created only when open files have unsaved changes.
  - Added bounded concurrency and refresh-flush barriers (`ensureDocumentRefreshed`) across workspace indexing and LSP providers, plus shared helpers unifying `ZEROPAGE` / `ZP` / `DIRECTPAGE` / `DP` segment handling across diagnostics, Quick Fixes, analyzer, outline symbols, and symbol resolution.
- Scoped completions to the active translation unit plus workspace exports while suppressing completions in comments, strings, numbers, and declaration names.
- Revamped hover cards with left-aligned segment/kind badges (`CONST`, `ENUM`, `VAR`, `MACRO`, `DEFINE`), evaluated constant values, verbatim `;` comment blocks, and clickable source links.
- Updated TextMate grammar to highlight regular labels as declarations, focus mnemonic scopes on control-flow instructions, and support string escapes.
- Simplified Outline details to `(macro)` and `(zp)` with segment-based label icons and source-order sorting.
- Moved block snippets (`.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, `.repeat`, `.if*`) into context-aware LSP completion so snippets only trigger in command position and sort ahead of directives.
- Removed unused dependencies, fixed `.vscodeignore` packaging rules so compiled `client/out` and `server/out` files are included cleanly in `.vsix` builds, and updated repository metadata to `hobbett64/ca65-vscode-extension-64`.

### Fixed
- Fixed `.incbin` document link resolution using `ca65.binIncludeDirs`, label kind detection for `.res`/`.byte`/data/string definitions, and cheap local (`@label`) resolution and highlighting across parent scopes.
- Fixed live `stderr` diagnostic path mapping when validating unsaved files in shadow directories.

## [1.5.8] - 2025-09-14
- Fix symbols with the same name but different scopes counting towards each other's reference counts for symbol not used diagnostics.

## [1.5.7] - 2025-09-14
- Fix auto-includes not showing if auto-import symbol is found first.
- Show URI in symbol table dump.

## [1.5.6] - 2025-09-13
- Fix `--feature line_continuations` in ca65 diagnostics

## [1.5.5] - 2025-09-12
- Add setting to enable `--feature line_continuations` for the ca65 diagnostics.
- Scan symbol references in continuation lines.

## [1.5.4] - 2025-09-12
- Fix auto-complete not working on last line
- Fix labels not being scanned on last line

## [1.5.3] - 2025-09-11
- Fix .global statements not counting towards symbol usage

## [1.5.2] - 2025-09-11
- Fix implicit import symbol resolution

## [1.5.1] - 2025-09-10
- Add setting for implicit imports

## [1.5.0] - 2025-09-10
- Sped up auto-complete by ~10x
- Fix auto-import/include uris not resolving to the shortest path

## [1.4.13] - 2025-09-10
- Cleaned up symbol table references (removed hex letters, char literals, comment contents)
- Add setting to toggle folding ranges

## [1.4.12] - 2025-09-09
- Fix issue where includes were not correctly resolved on initial scan, which lead to broken "Find all references"
- Add debug commands to dump the current symbol table, includes graph, and exports map.

## [1.4.11] - 2025-09-06
- Minor speedup

## [1.4.9] - 2025-09-06
- Speed up auto-completion
- Abort in-progress diagnostics when file changes

## [1.4.8] - 2025-09-06
- Fix detection of `file.associations`
- Add additional setting to declare extensions for use with other IDEs 

## [1.4.5] - 2025-09-05
- Fix end ranges of scopes closed at EOF

## [1.4.4] - 2025-09-05
- Add performance logger and debug dump command

## [1.4.3] - 2025-09-05
- Use workspace-relative paths for import hints

## [1.4.0] - 2025-09-05
- Suppress autocompletion while typing an anonymous label reference

## [1.3.0] - 2025-09-04
- Add symbol unused diagnostics
- Support wildcard include paths
- Fix textmates syntax for # and @
- Remove empty line allowance between symbol def and doc comment for hover card

## [1.2.1] - 2025-09-02
- Update changelog

## [1.2.0] - 2025-09-02
- Added settings for toggling inlay hints for anonymous labels and "import from" hints.
- Fixed settings not being dynamically reloaded when changed.

## [1.1.0] - 2025-09-01
- Removed hard-coding of .s and .inc files in favor of dynamically using ca65-associated extensions. .s, .inc, and .asm will still be the defaults.
- Added setting to specify include and incbin dirs for link resolution and diagnostics.
- Added doc comment snippet ('doc') and auto-continuation.

## [1.0.0] - 2025-08-31

### Added
- Removed prelease versioning to prepare for VS Marketplace publishing.

## [1.0.0-beta.1] - 2025-08-31

### Added
- Initial beta release of the ca65 Language Server.
- Textmates syntax highlighting.
- Diagnostics (Errors, Warnings, Hints) powered by `ca65`.
- *Go to Definition* for labels, macros, and scopes.
- *Find All References* (workspace-wide).
- *Rename symbol across workspace*
- Hover Information for symbols, directives, and mnemonics.
- Autocompletion for all visible symbols in current translation unit.
- Autocompletion with auto-import/include for symbols defined/exported across the workspace.
- Call Hierarchy provider based on `jsr`/`jmp`
- Code Folding and sticky scroll for labels.
- Inlay hints for nameless labels.
- 6502 instruction reference page accessible from command palette (`shift-ctrl-p`)
