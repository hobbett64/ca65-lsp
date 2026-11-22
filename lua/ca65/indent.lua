-- Indenting for ca65 buffers ('indentexpr'), in the classic assembler layout:
--
--   .code                       labels, constants, and directives other than data
--   reset:                      are at the block's level
--           sei                 instructions and data (.byte, .res, .incbin...) are
--           .byte 1, 2          one level in
--   .scope Title
--           enter:              a nested .scope, .proc, .macro... moves both one level
--                   rts         in; .endscope lines up with its .scope
--   .endscope
--
-- A .scope that wraps the whole file (a module) doesn't indent its contents. .if…,
-- .else and .repeat are directives like any other: what's inside them keeps its own
-- level. .struct, .union and .enum members are at the level of the block.
--
-- Comments keep their indent. Enter after a label, or after a .scope or .if… line,
-- indents one level, as in the VS Code extension (language-configuration.json).

local M = {}

local function re(pattern) return vim.regex(pattern) end
local label = re([[\v^\s*(:|[a-zA-Z_@][a-zA-Z0-9_@]*:)]])
local label_only = re([[\v^\s*(:|[a-zA-Z_@][a-zA-Z0-9_@]*:)\s*(;.*)?$]])
local assignment = re([[\v\c^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(:?\=|\.set>)]])
local data = re([[\v\c^\s*\.(byte|byt|word|dbyt|dword|addr|faraddr|res|incbin|lobytes|hibytes|bankbytes|asciiz|literal|tag)>]])
local directive = re([[\v^\s*\.]])
local comment = re([[\v^\s*(;|/\*|\*)]])
-- " * text" and " */" lines of a /* */ comment
local comment_body = re([[\v^\s* \*(\s|/|$)]])
-- Blocks that indent what's inside them
local block_start = re([[\v\c^\s*\.(proc|scope|macro|mac|struct|union|enum)>]])
local block_end = re([[\v\c^\s*\.end(proc|scope|macro|mac|struct|union|enum)>]])
local record_start = re([[\v\c^\s*\.(struct|union|enum)>]])
local module_start = re([[\v\c^\.scope>]])
-- Directives whose next line VS Code indents
local opens_line = re([[\v\c^\s*\.(proc|macro|mac|scope|struct|union|enum|repeat|rep|if[a-z0-9]*|else|elseif)>]])

local function matches(regex, line) return regex:match_str(line) ~= nil end

--- The line of the innermost .scope/.proc/... still open above lnum, or nil.
local function open_block(lnum)
  local depth = 0
  for l = lnum - 1, 1, -1 do
    local text = vim.fn.getline(l)
    if matches(block_end, text) then
      depth = depth + 1
    elseif matches(block_start, text) then
      if depth == 0 then return l end
      depth = depth - 1
    end
  end
end

--- Whether the block opened at lnum is a module: the file's first block, a .scope at
--- column 0, in a file that ends with .endscope. (Not matching up the .endscope
--- itself, so a nested .scope that isn't closed yet doesn't look like the module.)
local function is_module(lnum)
  if not matches(module_start, vim.fn.getline(lnum)) then return false end
  local last = vim.fn.prevnonblank(vim.fn.line("$"))
  if not vim.fn.getline(last):match("^%.[eE][nN][dD][sS][cC][oO][pP][eE]") then return false end
  for l = 1, lnum - 1 do
    if matches(block_start, vim.fn.getline(l)) then return false end
  end
  return true
end

--- The indent of labels and directives at lnum, and whether lnum is in a .struct,
--- .union or .enum.
local function block_level(lnum)
  local opener = open_block(lnum)
  if not opener then return 0, false end
  local level = vim.fn.indent(opener)
  if not is_module(opener) then level = level + vim.fn.shiftwidth() end
  return level, matches(record_start, vim.fn.getline(opener))
end

--- The indent of a new, empty line (Enter, o, O): from the line above.
local function new_line_indent(lnum)
  local prev = vim.fn.prevnonblank(lnum - 1)
  -- After a /* */ comment, line up with the line that opened it
  if prev > 0 and matches(comment_body, vim.fn.getline(prev)) then
    while prev > 1 and not vim.fn.getline(prev):match("/%*") do prev = prev - 1 end
  end
  if prev == 0 then return 0 end
  local above = vim.fn.getline(prev)
  if matches(block_start, above) then return (block_level(lnum)) end
  if matches(label_only, above) or matches(opens_line, above) then
    return vim.fn.indent(prev) + vim.fn.shiftwidth()
  end
  return vim.fn.indent(prev)
end

--- 'indentexpr' for ca65 buffers: the indent of line v:lnum.
function M.get(lnum)
  lnum = lnum or vim.v.lnum
  local line = vim.fn.getline(lnum)
  if line:match("^%s*$") then return new_line_indent(lnum) end
  if matches(comment, line) then return -1 end

  if matches(block_end, line) then
    -- .endscope and the like line up with the block they close
    local opener = open_block(lnum)
    return opener and vim.fn.indent(opener) or 0
  end

  local level, in_record = block_level(lnum)
  if in_record or matches(label, line) or matches(assignment, line) then return level end
  if matches(directive, line) and not matches(data, line) then return level end
  return level + vim.fn.shiftwidth()   -- an instruction, data, or a macro call
end

return M
