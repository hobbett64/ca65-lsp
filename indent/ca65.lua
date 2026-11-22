-- Indenting for ca65 files: labels and directives at the block's level, instructions
-- and data one level in (see lua/ca65/indent.lua). Turn it off with
-- `filetype indent off`, or `vim.b.did_indent = 1` before this runs.
if vim.b.did_indent then return end
vim.b.did_indent = 1

vim.bo.indentexpr = "v:lua.require'ca65.indent'.get()"
-- Reindent on Enter, o, O and Ctrl-F; on ":" (a label typed after code moves out to
-- the labels' level); and on ".end"/".else" at the start of a line, and again on the
-- whole ".endscope" or ".endproc" (they line up with the block they close)
vim.bo.indentkeys = "!^F,o,O,<:>,=~.end,=~.else,"
  .. "=~.endscope,=~.endproc,=~.endmacro,=~.endmac,=~.endstruct,=~.endunion,=~.endenum"

vim.b.undo_indent = "setlocal indentexpr< indentkeys<"
