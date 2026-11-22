-- Indenting for ca65 buffers ('indentexpr'), as the VS Code extension does
-- (language-configuration.json):
--   - Enter after a label (a line whose code ends in ":", like "reset:" or
--     "@loop: ; wait") or a block directive (.proc, .scope, .macro, .if…, .else,
--     .repeat, .struct, .union, .enum) indents the new line one level
--   - typing .end… or .else at the start of a line moves it back one level
--   - every other new line keeps the indent of the line above; nothing else moves
-- " * " lines of a /* */ comment don't count: the line after the comment follows the
-- line with its "/*".

local M = {}

local opens_block = vim.regex([[\v\c^\s*\.(proc|macro|mac|scope|struct|union|enum|repeat|rep|if[a-z0-9]*|else|elseif)>]])
-- Only ".end"/".else" is checked: 'indentkeys' reindents as soon as those are typed,
-- before the rest of ".endscope" or ".endif"
local closes_block = vim.regex([[\v\c^\s*\.(end|else)]])

--- The line above lnum that the indent follows: the previous non-blank line, or for
--- a /* */ comment's " * " or " */" lines, the line with its "/*". 0 if none.
local function line_above(lnum)
  local prev = vim.fn.prevnonblank(lnum - 1)
  if prev > 0 and vim.fn.getline(prev):match("^%s* %*") then
    while prev > 1 and not vim.fn.getline(prev):match("/%*") do prev = prev - 1 end
  end
  return prev
end

--- The indent for a line after prev: one level more after a label or block directive.
local function indent_after(prev)
  local text = vim.fn.getline(prev)
  local indent = vim.fn.indent(prev)
  -- Comment lines ("; ...", "/* ...") don't count, even ending in ":"
  if text:match("^%s*;") or text:match("^%s*/%*") then return indent end
  local is_label = text:gsub(";.*$", ""):match(":%s*$")
  if is_label or opens_block:match_str(text) then return indent + vim.fn.shiftwidth() end
  return indent
end

--- 'indentexpr' for ca65 buffers: the indent of line v:lnum.
function M.get(lnum)
  lnum = lnum or vim.v.lnum
  local line = vim.fn.getline(lnum)
  local prev = line_above(lnum)

  -- .end… and .else go back one level from where the line above would put them
  if closes_block:match_str(line) then
    return prev == 0 and 0 or math.max(indent_after(prev) - vim.fn.shiftwidth(), 0)
  end
  -- Any other line that has text keeps its indent: text Enter split off, a comment's
  -- " * ", or a line being reindented with =
  if line:match("%S") then return -1 end
  return prev == 0 and 0 or indent_after(prev)
end

return M
