-- ca65 for Neovim: buffer settings for ca65 files and the ca65 language server.
--
-- Works without setup(): ftplugin/ca65.lua calls attach() for every ca65 buffer using
-- the defaults below. setup() only changes the options.

local M = {}

local defaults = {
  -- Server settings: the same as VS Code's "ca65.*" settings, without the prefix, e.g.
  -- { linkerConfig = "nrom.cfg", cpu = "65C02", cc65 = { target = "nes" } }.
  -- Can also be a function(root_dir) returning that table, for per-project settings.
  settings = {},
  -- Files or folders that mark a project's root; the nearest one above a file wins.
  -- Without one, the file's own folder is the root.
  root_markers = { ".git", "Makefile" },
  -- LSP capabilities. nil: those of blink.cmp or nvim-cmp if installed, else the defaults.
  capabilities = nil,
  server = {
    -- Command to run the server. nil: run the bundled or downloaded server with node.
    cmd = nil,
    node = "node",
  },
  -- Enter right after "/**" also adds the closing " */" line below, in ca65 and C files
  -- (true), in the filetypes listed (e.g. { "ca65" }), or nowhere (false).
  close_doc_comments = true,
  -- gx on a hover link to a file and line (file://…#L12) opens it in Neovim rather
  -- than handing it to the system's opener.
  open_file_links = true,
}

M.config = vim.deepcopy(defaults)

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  -- Restart running servers so they pick up the new settings
  for _, client in ipairs(vim.lsp.get_clients({ name = "ca65" })) do
    local bufs = vim.tbl_keys(client.attached_buffers or {})
    client:stop()
    vim.defer_fn(function()
      for _, buf in ipairs(bufs) do
        if vim.api.nvim_buf_is_valid(buf) then M.start(buf) end
      end
    end, 100)
  end
end

local function capabilities()
  if M.config.capabilities then return M.config.capabilities end
  local ok, blink = pcall(require, "blink.cmp")
  if ok and blink.get_lsp_capabilities then return blink.get_lsp_capabilities() end
  local ok2, cmp_lsp = pcall(require, "cmp_nvim_lsp")
  if ok2 then return cmp_lsp.default_capabilities() end
  return nil
end

--- The server command, or nil while the server is being downloaded (start() runs
--- again for every ca65 buffer once it's ready).
local function server_cmd()
  if M.config.server.cmd then return M.config.server.cmd end
  local server = require("ca65.server")
  local path = server.path()
  if path then return { M.config.server.node, path, "--stdio" } end

  vim.notify("ca65: downloading the language server " .. (server.version() or "") .. "…")
  server.install({
    on_done = function(err)
      if err then
        vim.notify("ca65: couldn't download the language server: " .. err
          .. "\nSee :checkhealth ca65", vim.log.levels.ERROR)
        return
      end
      vim.notify("ca65: language server ready")
      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].filetype == "ca65" then M.start(buf) end
      end
    end,
  })
  return nil
end

--- Starts the language server for a buffer (or attaches it to a running one).
function M.start(buf)
  local cmd = server_cmd()
  if not cmd then return end
  local name = vim.api.nvim_buf_get_name(buf)
  local root = vim.fs.root(buf, M.config.root_markers) or vim.fs.dirname(name)
  local settings = M.config.settings
  if type(settings) == "function" then settings = settings(root) or {} end
  vim.lsp.start({
    name = "ca65",
    cmd = cmd,
    root_dir = root,
    capabilities = capabilities(),
    settings = { ca65 = settings },
    handlers = {
      -- The assembler listing was rebuilt: data lines' byte counts may have changed
      ["ca65/listingUpdated"] = function(_, params)
        require("ca65.status").listing_updated(params and params.uris)
      end,
    },
  }, { bufnr = buf })
end

-- For the status line, about the current line or the selection in visual mode, e.g.
--   vim.o.statusline = "%f %m%=%{v:lua.require'ca65'.segment()}  %{v:lua.require'ca65'.bytes()}  %{v:lua.require'ca65'.cycles()}  %l:%c "
-- Each is empty outside ca65 buffers, and nothing is asked until one is first called.

--- The segment it's in: "CODE", "RODATA"…
function M.segment() return require("ca65.status").get("segment", "segment") end

--- Its size: "3 B", or "2–3 B" when it depends on the operand's size.
function M.bytes() return require("ca65.status").get("stats", "bytes") end

--- Its cycle count: "4 cyc", or "4–5 cyc" with page crossings or branches.
function M.cycles() return require("ca65.status").get("stats", "cycles") end

--- Whether Enter after "/**" adds the closing " */" in this filetype.
function M.closes_doc_comments(filetype)
  local opt = M.config.close_doc_comments
  if opt == true then opt = { "ca65", "c" } end
  return type(opt) == "table" and vim.tbl_contains(opt, filetype)
end

--- Enter right after "/**" adds the closing " */" line below. Needs 'comments' to
--- continue /* */ comments with " * " (ca65 buffers get that from attach(); C has it
--- from Neovim's own C settings).
function M.close_doc_comments(buf)
  vim.api.nvim_create_autocmd("TextChangedI", {
    buffer = buf,
    group = vim.api.nvim_create_augroup("ca65_doc_comments_" .. buf, { clear = true }),
    callback = function()
      local row = vim.api.nvim_win_get_cursor(0)[1]
      if row < 2 then return end
      local lines = vim.api.nvim_buf_get_lines(buf, row - 2, row + 1, false)
      local above, current, below = lines[1], lines[2], lines[3] or ""
      -- Just pressed Enter after "/**": the new line is the " * " that 'comments' added
      if above:match("^%s*/%*%*%s*$") and current:match("^%s*%*%s*$") and not below:match("^%s*%*") then
        local indent = above:match("^(%s*)")
        vim.api.nvim_buf_set_lines(buf, row, row, false, { indent .. " */" })
      end
    end,
  })
end

-- " * " lines inside /* */ comments; Enter after "/**" adds the closing " */"
local function setup_doc_comments(buf)
  vim.bo[buf].comments = "s1:/*,mb:*,ex:*/"
  vim.opt_local.formatoptions:append("ro")
  if M.closes_doc_comments("ca65") then M.close_doc_comments(buf) end
end

--- Buffer settings for a ca65 buffer, then the language server. Called by ftplugin/ca65.lua.
function M.attach(buf)
  buf = (buf == nil or buf == 0) and vim.api.nvim_get_current_buf() or buf
  vim.bo[buf].commentstring = "; %s"
  -- @ is part of a word, so *, w and ciw treat cheap locals (@done) as one word
  vim.opt_local.iskeyword:append("@-@")
  -- % jumps between block directives (matchit)
  vim.b[buf].match_ignorecase = 1
  vim.b[buf].match_words = table.concat({
    [[\.scope\>:\.endscope\>]],
    [[\.proc\>:\.endproc\>]],
    [[\.if\%(n\?def\|n\?blank\|const\|n\?ref\|p02\|p816\|pc02\|psc02\)\?\>:\.else\%(if\)\?\>:\.endif\>]],
    [[\.mac\%(ro\)\?\>:\.endmac\%(ro\)\?\>]],
    [[\.rep\%(eat\)\?\>:\.endrep\%(eat\)\?\>]],
    [[\.struct\>:\.endstruct\>]],
    [[\.union\>:\.endunion\>]],
    [[\.enum\>:\.endenum\>]],
  }, ",")
  setup_doc_comments(buf)
  if M.config.open_file_links then require("ca65.links").enable() end
  M.start(buf)
end

return M
