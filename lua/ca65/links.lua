-- Hovers link to definitions as file:///path/file.s#L12. Neovim's gx hands every link
-- to the system opener (xdg-open, open…), which can't follow the line number. This
-- wraps vim.ui.open so those links open in Neovim at that line; every other link
-- still goes to the system opener.

local M = {}

local enabled = false

function M.enable()
  if enabled then return end
  enabled = true
  local system_open = vim.ui.open
  vim.ui.open = function(uri, opt)
    local file, line = uri:match("^(file://[^#]*)#L(%d+)$")
    if not file then
      return system_open(uri, opt)
    end
    -- gx from inside a hover window: close it so the file opens in the window below
    if vim.api.nvim_win_get_config(0).relative ~= "" then
      vim.api.nvim_win_close(0, false)
    end
    vim.cmd.edit(vim.fn.fnameescape(vim.uri_to_fname(file)))
    local last = vim.api.nvim_buf_line_count(0)
    vim.api.nvim_win_set_cursor(0, { math.min(tonumber(line), last), 0 })
    return nil, nil
  end
end

return M
