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
    * **Outline view:** Nested file outline with segment-based symbol icons, `(macro)` / `(zp)` annotations, and source-order sorting.
* **Code Intelligence:**
    * **Rich Hover Information:** Shows segment / kind badges (`CODE`, `ZEROPAGE`, `CONST`, `ENUM`, `VAR`, `MACRO`, `DEFINE`), evaluated constant values, verbatim `;` doc comments, clickable source links, cheap/anonymous label previews, and CPU-aware instruction (`6502`, `65SC02`, `65C02`, `W65C02`, `65816`) & directive references.
    * **Context-Aware Autocompletion & Snippets:** Suggests CPU-filtered mnemonics, directives, block snippets (`.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, `.repeat`, `.if*`), `Scope::` members, `.include`/`.incbin` paths, and auto-import/include suggestions — while suppressing nuisance popups inside comments, strings, numbers, and declaration names.
    * **Signature Help:** Active parameter hints for `.macro` calls and `.define` function-like macros.
    * **Import Tracing & Anonymous Label Indexing:** Inlay hints for `.import` origins and opt-in `L1`/`L2` anonymous label indices (`ca65.anonymousLabelIndexHints`).
* **Editor & Assembly Tools:**
    * **Syntax Highlighting & Semantic Tokens:** TextMate grammar for ca65 syntax (highlighting label declarations, control-flow opcodes, string escapes, and constants) paired with LSP semantic tokens for `.proc`, `.macro`, constants, `.enum`, `.struct`, `.scope`, and `.set` variables.
    * **Side-by-Side Hex & Address Listing:** Open `ca65: Show Hex & Address Listing Side-by-Side` (`$(file-binary)` editor title icon) to inspect assembled addresses and emitted bytes aligned line-for-line with your source.
    * **Status Bar Cycle & Byte Counter:** Shows estimated byte sizes and cycle counts (or 8/16-bit `M`/`X` ranges for `65816`) for the current line or selection.
    * **Code Folding & Sticky Scroll:** Fold `.proc`, `.macro`, `.scope`, `.struct`, `.union`, `.enum`, and conditional blocks.
    * **Instruction Reference Page:** Open the full opcode reference for the active `ca65.cpu` target via `ca65: Show Instruction Reference`.
    
## Known Limitations

* Diagnostics are mainly powered via `ca65`'s `stderr`, so they may be limited in detail, and they do not provide any diagnostics about the linking step.
* The LSP is agnostic to the actual build command your project uses, it assumes that all ca65 files are linked together for the purpose of import/export visibility.
* Macro expansion is entirely opaque to the LSP, so symbols/scopes/syntax that are affected by macro expansion will not be visible to the LSP.
* Symbols with multiple definitions will always resolve to the first definition in the same file.
* Symbol refs will always resolve to the symbol even if a macro is declared with the same name after it's declaration.
* Auto-completion in the operand will only suggest symbols -- it will not suggest `struct`s in a `.tag` or `.sizeof` command
* Anonymous structs are currently not handled to spec (the spec adds the members to an anonymous scope, but `ca65` actually adds them to the parent scope).
* Symbol definitions on continuation lines (i.e. lines after a line ending in `\`) are ignored. Only symbol references are parsed, which is good enough for the common use case of using line continuations for long expressions.

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

For users of the standalone LSP with other IDEs, please use the `ca65.additionalExtensions` setting to declare additional extensions to scan for.

## Other settings

Select your target processor via `ca65.cpu` (`6502` default, `65SC02`, `65C02`, `W65C02`, or `65816`) to align diagnostics, hover docs, autocomplete, status-bar timing/byte estimates, and the instruction reference panel.

Paths for `.include` and `.incbin` (i.e. what you would pass into `-I` and `--bin-include-dir` during the assembly step) may be specified by `ca65.includeDirs` and `ca65.binIncludeDirs` settings, and custom compiler flags (such as `-D DEBUG=1` or `-t nes`) can be passed via `ca65.additionalArgs`.

Please see the Settings gear icon in the installed extension to easily set this and other settings.

## Running Tests
```
npm test
```

## Building a standalone LSP executable for other editors
You can build a standalone LSP executable via the following shell commands. The executable will be placed in `dist/bin/ca65-lsp-<platform>` 
```
npm run package-lsp:linux   # Linux
npm run package-lsp:win     # Windows
npm run package-lsp:macos   # MacOS
npm run package-lsp         # All Three
```
## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
