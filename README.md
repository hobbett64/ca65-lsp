# ca65 Assembly for Visual Studio Code

Provides basic LSP-backed language support for **ca65** assembly files.

## Features

This extension provides a full-featured language server to make writing `ca65` assembly a modern and productive experience.

* **ca65-backed & LSP Diagnostics:**
    * Live validation by running `ca65` in the background and mapping errors to editor lines.
    * Built-in LSP checks for `.import`/`.importzp` and `.export`/`.exportzp` zeropage mismatches (with one-click Quick Fixes) and unused symbols.
* **Code Navigation:**
    * **Go to Definition:** Jump directly to the definition of any label, constant, variable, macro, enum, struct, or scope. Works across local, included, and workspace-exported symbols.
    * **Find All References & Safe Rename:** Find all usages across the workspace or rename symbols (`F2`) with `prepareRename` validation and cheap local (`@label`) normalization.
    * **Call Hierarchy:** See incoming and outgoing `jsr`/`jmp` (and `65816` `jsl`/`jml`) calls for procedures and labels.
    * **Outline view:** Nested file outline with segment-based symbol icons, non-`CODE` segment annotations (e.g. `(ZEROPAGE)`, `(RODATA)`, `(BSS)`, `(BANK01)`), `(macro)` labels, and source-order sorting.
* **Code Intelligence:**
    * **Rich Hover Information:** Shows segment badges (`CODE`, `ZEROPAGE`, `RODATA`, etc.) alongside kind labels (`label`, `proc`, `constant`, `variable`, `enum`, `struct`, `union`, `macro`, `define`, `anonymous label`), byte sizes (`[N]`), evaluated constant values, qualified cheap local names (`scope::label@local`), anonymous label indices, multi-base number literal hovers (Hex, Dec, Bin), verbatim `;` and `/** ... */` doc comments, clickable source links, and CPU-aware lowercase instruction hovers (`6502`, `65SC02`, `65C02`, `W65C02`, `65816`) with compact `Affected flags`, badge-styled `Addressing modes`, and a **See details** link.
    * **Context-Aware Autocompletion & Snippets:** Suggests CPU-filtered mnemonics, directives, block snippets (`.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, `.repeat`, `.if*`), `Scope::` members, `.tag` and `.sizeof(` struct/union types, `.segment "..."` segment names, `.include`/`.incbin` paths, and auto-import/include suggestions — while suppressing nuisance popups inside comments, strings, numbers, and declaration names.
    * **Signature Help:** Active parameter hints for `.macro` calls and `.define` function-like macros.
    * **Import Tracing & Anonymous Label Indexing:** Inlay hints for `.import` origins and `(1)`/`(2)` anonymous label indices (`ca65.anonymousLabelIndexHints`).
    * **C-Style Comments & Line Continuations:** Parses `/* ... */` block comments (`ca65.cComments`) and backslash (`\`) line continuations (`ca65.lineContinuations`) across definitions, references, hovers, completions, signature help, and instruction cycle analysis.
* **Editor & Assembly Tools:**
    * **Syntax Highlighting & Semantic Tokens:** TextMate grammar for ca65 syntax paired with LSP semantic tokens for `.proc`, `CODE`/data/ZP/BSS labels, `.macro`, constants, `.enum`, `.struct`, `.scope`, and `.set` variables.
    * **Side-by-Side Hex & Address Listing:** Open `ca65: Show Hex & Address Listing Side-by-Side` (`$(file-binary)` editor title icon, or click the status bar counter) to inspect assembled addresses and emitted bytes aligned line-for-line with viewport-synced scrolling, or view live `ca65` errors when assembly fails.
    * **Status Bar Cycle/Byte Counter & Active Segment:** Displays compact byte sizes and cycle counts (including 8/16-bit `M`/`X` ranges for `65816`) with a unified `Line | Hex | Cycles` tooltip for the current line or selection, plus the active segment at the cursor line with click-to-jump navigation to the directive that set it.
    * **Code Folding & Sticky Scroll:** Fold `.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, and conditional blocks.
    * **Instruction Reference Panel:** Open the full opcode reference for the active target CPU (`ca65.cpu`) via `ca65: Show Instruction Reference`, or click **See details** on any instruction hovercard to jump straight to that opcode.
    
## Known Limitations

* Diagnostics are mainly powered via `ca65`'s `stderr`, so they may be limited in detail, and they do not provide any diagnostics about the linking step.
* The LSP is agnostic to the actual build command your project uses, it assumes that all ca65 files are linked together for the purpose of import/export visibility.
* Macro expansion is entirely opaque to the LSP, so symbols/scopes/syntax that are affected by macro expansion will not be visible to the LSP.
* Symbols with multiple definitions will always resolve to the first definition in the same file.
* Symbol refs will always resolve to the symbol even if a macro is declared with the same name after it's declaration.
* Anonymous structs are currently not handled to spec (the spec adds the members to an anonymous scope, but `ca65` actually adds them to the parent scope).

## Pre-requisites
- You must provide the `ca65` in your system's `PATH` or set setting `ca65.executablePath` to the absolute path of your `ca65` executable.
- Auto-save must be enabled for reliable diagnostics.

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
* **`ca65.cpu`:** Target CPU architecture (`6502`, `65SC02`, `65C02`, `W65C02`, `65816`) driving hovers, completions, cycle/byte estimates, call hierarchy, reference guide, and `ca65 --cpu`.
* **`ca65.includeDirs` & `ca65.binIncludeDirs`:** Search paths for `.include` (defaults to `["**/include"]`) and `.incbin` (defaults to `[]`).
* **`ca65.implicitImports`:** Treats undefined symbols as implicit imports (`--auto-import`).
* **`ca65.cComments` & `ca65.lineContinuations`:** Control `--feature c_comments` and `--feature line_continuations` (both default to `true`, automatically enabled when supported by your `ca65` executable and skipped if unsupported).
* **`ca65.additionalArgs`:** Optional extra CLI flags passed to `ca65` (defaults to `[]`, e.g. `["-D", "DEBUG=1", "-s"]`; output flags `-o`, `-l`, `--listing`, `--create-dep`, `--create-full-dep` are ignored).

Diagnostics and UX toggles (`ca65.enableStderrDiagnostics`, `ca65.enableUnusedSymbolDiagnostics`, inlay hints, status bar indicators, `ca65.smartFolding`, `ca65.autoIncludeExtensions`) can also be configured individually.

Please see the Settings gear icon in the installed extension to easily set this and other settings.

## Running Tests
```
npm test
```

## AI Usage Disclosure

Most of this project was vibe coded with AI assistance. Bug reports, issues, and pull requests are welcome!

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
