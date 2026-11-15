# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
