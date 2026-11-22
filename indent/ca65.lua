-- Indenting for ca65 files, as in VS Code: Enter after a label or a block directive
-- indents, .end…/.else go back a level (see lua/ca65/indent.lua). Turn it off with
-- `filetype indent off`, or `vim.b.did_indent = 1` before this runs.
if vim.b.did_indent then return end
vim.b.did_indent = 1

vim.bo.indentexpr = "v:lua.require'ca65.indent'.get()"
-- New lines (Enter, o, O), and ".end" or ".else" typed at the start of a line
vim.bo.indentkeys = "o,O,=~.end,=~.else"

vim.b.undo_indent = "setlocal indentexpr< indentkeys<"
