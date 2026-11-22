-- The segment, bytes and cycles of the current line or selection, for the status line:
--   vim.o.statusline = "%f %m%=%{v:lua.require'ca65'.segment()}  %{v:lua.require'ca65'.bytes()}  %{v:lua.require'ca65'.cycles()}  %l:%c "
-- These are the VS Code extension's status bar items. They come from the language
-- server's ca65/analyzeSelection and ca65/getSegmentAtPosition requests.
--
-- Nothing runs until the status line first calls one of them (and each request is
-- only made once something has asked for what it answers). After that, a request is
-- sent when the cursor moves to another line, the selection changes or the text
-- changes. Only one request is in flight at a time: moves made while one is pending
-- are folded into a single request for wherever the cursor is when it returns, so
-- holding j never queues a backlog, and a single move updates at once.

local M = {}

local started = false
---@type table<integer, { seq: integer, key: string?, range: table? }>
local state = {}

local function client_for(buf)
  return vim.lsp.get_clients({ bufnr = buf, name = "ca65" })[1]
end

local function line_end(buf, row)
  return #(vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or "")
end

--- The LSP range to measure in the current window, and a key that changes whenever
--- the answer could: the buffer's text, the line, or the selection.
local function current_range(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local mode = vim.fn.mode()
  if mode == "v" or mode == "V" or mode == "\22" then
    local a, b = vim.fn.getpos("v"), vim.fn.getpos(".")
    local s_row, s_col, e_row, e_col = a[2] - 1, a[3] - 1, b[2] - 1, b[3] - 1
    if s_row > e_row or (s_row == e_row and s_col > e_col) then
      s_row, s_col, e_row, e_col = e_row, e_col, s_row, s_col
    end
    if mode == "v" then
      e_col = math.min(e_col + 1, line_end(buf, e_row))   -- the last character is included
    else
      s_col, e_col = 0, line_end(buf, e_row)              -- linewise (and blockwise): whole lines
    end
    return {
      start = { line = s_row, character = s_col },
      ["end"] = { line = e_row, character = e_col },
    }, ("%d|%s|%d:%d-%d:%d"):format(tick, mode, s_row, s_col, e_row, e_col)
  end
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  return {
    start = { line = row, character = 0 },
    ["end"] = { line = row, character = line_end(buf, row) },
  }, ("%d|L:%d"):format(tick, row)
end

local function span(min, max, unit)
  if min == max then return ("%d %s"):format(min, unit) end
  return ("%d–%d %s"):format(min, max, unit)
end

--- "3 B" and "4 cyc", as VS Code shows them. Lines without instructions (data,
--- directives) show the bytes the assembler listing has for them, and 0 cycles.
local function format_stats(result)
  if type(result) ~= "table" then return {} end
  if (result.instructionCount or 0) > 0 then
    return {
      bytes = span(result.minBytes, result.maxBytes, "B"),
      cycles = span(result.minCycles, result.maxCycles, "cyc"),
    }
  end
  local listed = type(result.lineListing) == "table" and result.lineListing.byteCount or 0
  return { bytes = ("%d B"):format(listed), cycles = "0 cyc" }
end

--- The server requests behind the status line items: bytes() and cycles() share one.
--- Each is only made once one of its items has been asked for, and each has at most
--- one request in flight.
local probes = {
  stats = {
    method = "ca65/analyzeSelection",
    params = function(s) return { range = s.range } end,
    format = format_stats,
  },
  -- The segment the cursor's line is in ("CODE", "RODATA"…), as VS Code's status bar shows
  segment = {
    method = "ca65/getSegmentAtPosition",
    params = function(s) return { line = s.range["end"].line } end,
    format = function(result) return { segment = type(result) == "table" and result.segment or nil } end,
  },
}
local enabled = {}

local function request(buf, name)
  local s = state[buf]
  local client = client_for(buf)
  if not s or not client or not s.range then return end
  local probe, p = probes[name], s[name]
  local seq = s.seq
  local params = probe.params(s)
  params.uri = vim.uri_from_bufnr(buf)
  p.inflight = true
  local ok = client:request(probe.method, params, function(err, result)
    p.inflight = false
    if not vim.api.nvim_buf_is_valid(buf) then return end
    if seq ~= s.seq then return request(buf, name) end   -- moved meanwhile: ask about where we are now
    p.items = err and {} or probe.format(result)
    vim.cmd.redrawstatus()
  end, buf)
  if not ok then p.inflight = false end
end

--- Asks about the current window's line or selection, unless that's what was last asked.
local function update(force)
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].filetype ~= "ca65" or not client_for(buf) then return end
  local range, key = current_range(buf)
  local s = state[buf]
  if not s then
    s = { seq = 0 }
    for name in pairs(probes) do s[name] = { items = {} } end
    state[buf] = s
  end
  if key == s.key and not force then return end
  s.key, s.range, s.seq = key, range, s.seq + 1
  for name in pairs(enabled) do
    if not s[name].inflight then request(buf, name) end
  end
end

local function start()
  local group = vim.api.nvim_create_augroup("ca65_status", { clear = true })
  vim.api.nvim_create_autocmd(
    { "CursorMoved", "CursorMovedI", "TextChanged", "TextChangedI", "ModeChanged", "BufEnter", "WinEnter", "LspAttach" },
    { group = group, callback = function() update(false) end })
  vim.api.nvim_create_autocmd({ "BufWipeout" }, {
    group = group,
    callback = function(args) state[args.buf] = nil end,
  })
end

--- The server rebuilt the listing for these files (data lines' byte counts may change).
function M.listing_updated(uris)
  if not started then return end
  local buf = vim.api.nvim_get_current_buf()
  if not uris or vim.tbl_contains(uris, vim.uri_from_bufnr(buf)) then update(true) end
end

--- One status line item ("bytes" or "cycles" from the "stats" request, "segment" from
--- "segment") for the window being drawn: "" outside ca65 buffers and in windows
--- other than the current one.
function M.get(name, item)
  if not enabled[name] then
    enabled[name] = true
    -- Not while the status line is being drawn
    vim.schedule(function()
      if not started then
        started = true
        start()
      end
      update(true)
    end)
  end
  local win = vim.api.nvim_get_current_win()
  local actual = tonumber(vim.g.actual_curwin)
  if actual and actual ~= win then return "" end
  local s = state[vim.api.nvim_win_get_buf(win)]
  return s and s[name].items[item] or ""
end

return M
