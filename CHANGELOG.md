# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
