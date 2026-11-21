-- 6502 instruction reference: :Ref6502 browses every instruction, :Ref6502 lda
-- shows one.
--
-- This is Neovim's version of the VS Code extension's reference panel. The panel's
-- data comes from the language server's ca65/getReferenceData request, so this module
-- asks the server for the same data and formats each entry like the extension's
-- instruction hover (generateMnemonicHoverMarkdown in server/src/hoverProvider.ts).

local M = {}

-- JSON objects arrive as Lua tables with no order, so give modes and flags a fixed one
local MODE_ORDER = {
  "Implied", "Accumulator", "Immediate", "Zero page", "Zero page, X", "Zero page, Y",
  "Absolute", "Absolute, X", "Absolute, Y", "Indirect", "(Indirect, X)", "(Indirect), Y",
  "Relative",
}
local FLAG_ORDER = { "N", "V", "M", "X", "B", "D", "I", "Z", "C", "E" } -- status register order

local function ordered_keys(tbl, order)
  local keys, seen = {}, {}
  for _, k in ipairs(order) do
    if tbl[k] ~= nil then table.insert(keys, k); seen[k] = true end
  end
  local rest = {}
  for k in pairs(tbl) do if not seen[k] then table.insert(rest, k) end end
  table.sort(rest)
  return vim.list_extend(keys, rest)
end

-- Same rules as formatModeBytes / formatModeCycles in the extension
local function mode_bytes(info)
  if info.byteVariableM then return ("%d–%d (M)"):format(info.bytes, info.bytes + 1) end
  if info.byteVariableX then return ("%d–%d (X)"):format(info.bytes, info.bytes + 1) end
  return tostring(info.bytes)
end

local function mode_cycles(info)
  if info.perByteCycles then return info.cycles .. "/byte" end
  local notes = {}
  if info.branchPenalty then table.insert(notes, "+1 branch") end
  if info.pagePenalty then table.insert(notes, "+1 page") end
  if info.pageOrIndex16Penalty then table.insert(notes, "+1 page/16-bit X") end
  if info.emulationOnlyPagePenalty then table.insert(notes, "+1 page if E=1") end
  if info.cycleVariableM then table.insert(notes, ("+%d if 16-bit M"):format(info.cycleVariableM)) end
  if info.cycleVariableX then table.insert(notes, ("+%d if 16-bit X"):format(info.cycleVariableX)) end
  if info.dpNonZeroPenalty then table.insert(notes, "+1 if DL≠0") end
  if info.nativeModeCyclePenalty then table.insert(notes, ("+%d if E=0"):format(info.nativeModeCyclePenalty)) end
  return #notes > 0 and ("%d (%s)"):format(info.cycles, table.concat(notes, ", ")) or tostring(info.cycles)
end

--- Markdown lines for one mnemonic's full entry.
function M.markdown(name, data, cpu)
  local lines = {}
  local cpu_tag = (cpu and cpu ~= "6502") and (" (" .. cpu .. ")") or ""
  table.insert(lines, ("`%s` — **%s**%s"):format(name:lower(), data.fullName or "", cpu_tag))
  table.insert(lines, "")
  if data.description and data.description ~= "" then
    vim.list_extend(lines, vim.split(data.description, "\n")); table.insert(lines, "")
  end
  if data.warning then table.insert(lines, "⚠️ **Warning**: " .. data.warning); table.insert(lines, "") end
  if data.note then table.insert(lines, "*Note: " .. data.note .. "*"); table.insert(lines, "") end

  local flags = data.flagChanges or {}
  if next(flags) then
    table.insert(lines, "**Flags affected:**")
    for _, f in ipairs(ordered_keys(flags, FLAG_ORDER)) do
      table.insert(lines, ("- `%s`: %s"):format(f, flags[f]))
    end
    table.insert(lines, "")
  end

  local modes = data.modes or {}
  if next(modes) then
    -- Neovim doesn't draw Markdown tables, so pad the columns to line up as text.
    -- No backticks in cells: Neovim hides them, which would break the alignment.
    local rows = { { "Mode", "Opcode", "Bytes", "Cycles" } }
    for _, mode in ipairs(ordered_keys(modes, MODE_ORDER)) do
      local info = modes[mode]
      table.insert(rows, { mode, info.opcode, mode_bytes(info), mode_cycles(info) })
    end
    local widths = { 0, 0, 0, 0 }
    for _, row in ipairs(rows) do
      for i, cell in ipairs(row) do widths[i] = math.max(widths[i], vim.fn.strdisplaywidth(cell)) end
    end
    local function format_row(row)
      local cells = {}
      for i, cell in ipairs(row) do
        cells[i] = cell .. string.rep(" ", widths[i] - vim.fn.strdisplaywidth(cell))
      end
      return "| " .. table.concat(cells, " | ") .. " |"
    end
    table.insert(lines, format_row(rows[1]))
    local rule = {}
    for i, w in ipairs(widths) do rule[i] = string.rep("-", w) end
    table.insert(lines, "|-" .. table.concat(rule, "-|-") .. "-|")
    for i = 2, #rows do table.insert(lines, format_row(rows[i])) end
  end
  return lines
end

local function client_for(bufnr)
  return vim.lsp.get_clients({ bufnr = bufnr, name = "ca65" })[1] or vim.lsp.get_clients({ name = "ca65" })[1]
end

--- Fetches the reference data (for the buffer's CPU) and calls on_data(mnemonics, cpu).
function M.fetch(bufnr, on_data)
  local client = client_for(bufnr)
  if not client then
    vim.notify("ca65: the language server isn't running", vim.log.levels.WARN)
    return
  end
  client:request("ca65/getReferenceData", { uri = vim.uri_from_bufnr(bufnr) }, function(err, result)
    if err or not result then
      vim.notify("ca65: couldn't get the instruction reference: " .. vim.inspect(err), vim.log.levels.ERROR)
      return
    end
    on_data(result.mnemonics or {}, result.cpu)
  end, bufnr)
end

--- Shows one mnemonic's full entry in a floating window (press it again to enter it).
function M.show(mnemonic, bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if not mnemonic or mnemonic == "" then return end
  M.fetch(bufnr, function(mnemonics, cpu)
    local key = mnemonic:upper()
    local data = mnemonics[key]
    if not data then
      vim.notify(("ca65: `%s` isn't an instruction%s"):format(mnemonic, cpu and (" for the " .. cpu) or ""), vim.log.levels.INFO)
      return
    end
    vim.lsp.util.open_floating_preview(M.markdown(key, data, cpu), "markdown", {
      border = "rounded", focus_id = "ca65_reference", max_width = 90,
    })
  end)
end

--- Lists every instruction with vim.ui.select (when Telescope isn't installed).
local function select(names, mnemonics, cpu, bufnr)
  vim.ui.select(names, {
    prompt = "Instructions" .. (cpu and (" (" .. cpu .. ")") or ""),
    format_item = function(name) return ("%-5s %s"):format(name:lower(), mnemonics[name].fullName or "") end,
  }, function(choice)
    if choice then M.show(choice, bufnr) end
  end)
end

--- Browses every instruction: in Telescope, with the full entry as the preview, if
--- it's installed; otherwise with vim.ui.select.
function M.pick(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  M.fetch(bufnr, function(mnemonics, cpu)
    local names = vim.tbl_keys(mnemonics)
    table.sort(names)
    if not pcall(require, "telescope") then
      return select(names, mnemonics, cpu, bufnr)
    end
    local pickers = require("telescope.pickers")
    local finders = require("telescope.finders")
    local previewers = require("telescope.previewers")
    local conf = require("telescope.config").values
    local actions = require("telescope.actions")
    local state = require("telescope.actions.state")

    -- flex: preview beside the list when wide, below it when narrow (never hidden)
    -- (flip at 120 columns: the side-by-side layout hides its preview below that)
    pickers.new({ layout_strategy = "flex", layout_config = { flip_columns = 120 } }, {
      prompt_title = "Instructions" .. (cpu and (" (" .. cpu .. ")") or ""),
      finder = finders.new_table({
        results = names,
        entry_maker = function(name)
          local text = ("%-5s %s"):format(name:lower(), mnemonics[name].fullName or "")
          return { value = name, display = text, ordinal = text }
        end,
      }),
      sorter = conf.generic_sorter({}),
      previewer = previewers.new_buffer_previewer({
        title = "Reference",
        define_preview = function(self, entry)
          vim.api.nvim_buf_set_lines(self.state.bufnr, 0, -1, false,
            M.markdown(entry.value, mnemonics[entry.value], cpu))
          vim.bo[self.state.bufnr].filetype = "markdown"
          vim.wo[self.state.winid].conceallevel = 2
          vim.wo[self.state.winid].wrap = true
        end,
      }),
      attach_mappings = function(prompt_bufnr)
        actions.select_default:replace(function()
          local entry = state.get_selected_entry()
          actions.close(prompt_bufnr)
          if entry then M.show(entry.value, bufnr) end
        end)
        return true
      end,
    }):find()
  end)
end

return M
