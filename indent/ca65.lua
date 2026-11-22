-- Indenting for ca65 files: Enter after a label indents one level (see
-- lua/ca65/indent.lua). Turn it off with `filetype indent off`, or
-- `vim.b.did_indent = 1` before this runs.
if vim.b.did_indent then return end
vim.b.did_indent = 1

vim.bo.indentexpr = "v:lua.require'ca65.indent'.get()"
-- Only new lines (Enter, o, O) are indented; nothing reindents as you type
vim.bo.indentkeys = "o,O"

vim.b.undo_indent = "setlocal indentexpr< indentkeys<"
