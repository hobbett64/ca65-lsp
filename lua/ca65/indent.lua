-- Indenting for ca65 buffers ('indentexpr'), as the VS Code extension does on Enter:
-- after a label (a line whose code ends in ":", like "reset:" or "@loop: ; wait"),
-- the new line is indented one level. Every other new line keeps the indent of the
-- line above. Lines already typed are never moved, so = leaves them as they are.

local M = {}

--- 'indentexpr' for ca65 buffers: the indent of line v:lnum.
function M.get(lnum)
  lnum = lnum or vim.v.lnum
  -- Only a new, empty line gets an indent. -1 keeps a line's own indent: text that
  -- Enter split off, a /* */ comment's " * ", or any line when reindenting with =.
  if vim.fn.getline(lnum):match("%S") then return -1 end

  local prev = vim.fn.prevnonblank(lnum - 1)
  if prev == 0 then return 0 end
  local above = vim.fn.getline(prev)
  local indent = vim.fn.indent(prev)
  -- Comment lines ("; ...", "/* ...", " * Types:") don't count as labels
  if above:match("^%s*[;*]") or above:match("^%s*/%*") then return indent end
  -- The code before any ";" comment ends in ":", so it's a label
  if above:gsub(";.*$", ""):match(":%s*$") then return indent + vim.fn.shiftwidth() end
  return indent
end

return M
