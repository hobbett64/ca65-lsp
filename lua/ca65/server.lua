-- Finds the ca65 language server, downloading it from the GitHub release when needed.
--
-- The plugin and the server come from the same repository, so the plugin's version
-- (package.json) is the server version to use. Order of preference:
--   1. server/out/server.js in the plugin's own directory (a built checkout of the repo)
--   2. a server already downloaded for this version, in stdpath("data")/ca65-lsp/<version>
--   3. downloading ca65-lsp-server-<version>.tar.gz from the release, into (2)

local M = {}

local REPO = "hobbett64/ca65-lsp"

-- lua/ca65/server.lua -> the repository root
local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")

local function readable(path)
  return vim.fn.filereadable(path) == 1
end

--- The plugin's version, from package.json.
function M.version()
  if M._version == nil then
    local ok, data = pcall(function()
      return vim.json.decode(table.concat(vim.fn.readfile(plugin_root .. "/package.json"), "\n"))
    end)
    M._version = ok and data.version or false
  end
  return M._version or nil
end

--- Where a downloaded server for this version lives.
function M.install_dir()
  return vim.fn.stdpath("data") .. "/ca65-lsp/" .. (M.version() or "unknown")
end

function M.local_server()
  local path = plugin_root .. "/server/out/server.js"
  return readable(path) and path or nil
end

function M.downloaded_server()
  local path = M.install_dir() .. "/server/out/server.js"
  return readable(path) and path or nil
end

--- Path to server.js, or nil if it hasn't been downloaded yet.
function M.path()
  return M.local_server() or M.downloaded_server()
end

function M.release_url()
  local v = M.version()
  return ("https://github.com/%s/releases/download/v%s/ca65-lsp-server-%s.tar.gz"):format(REPO, v, v)
end

local installing = false
local waiting = {}

local function finish(err)
  installing = false
  local callbacks = waiting
  waiting = {}
  for _, cb in ipairs(callbacks) do
    cb(err)
  end
end

--- Downloads and unpacks the server for this version.
--- opts.sync: block until done (for build scripts). opts.on_done(err): called when finished.
function M.install(opts)
  opts = opts or {}
  if opts.on_done then
    table.insert(waiting, opts.on_done)
  end
  if M.path() then
    return finish(nil)
  end
  if not M.version() then
    return finish("couldn't read the plugin version from " .. plugin_root .. "/package.json")
  end
  if installing then
    return
  end
  installing = true

  local dir = M.install_dir()
  local tmp = dir .. ".download"
  local archive = tmp .. "/server.tar.gz"
  vim.fn.delete(tmp, "rf")
  vim.fn.mkdir(tmp, "p")

  local steps = {
    { "curl", "-fsSL", "-o", archive, M.release_url() },
    { "tar", "-xzf", archive, "-C", tmp, "--strip-components=1" },
  }

  local function done(err)
    if err then
      vim.fn.delete(tmp, "rf")
    else
      vim.fn.delete(archive)
      vim.fn.delete(dir, "rf")
      vim.fn.mkdir(vim.fn.fnamemodify(dir, ":h"), "p")
      if vim.fn.rename(tmp, dir) ~= 0 then
        err = "couldn't move the server into " .. dir
      end
    end
    finish(err)
  end

  local function run(i)
    if i > #steps then
      return done(nil)
    end
    local cmd = steps[i]
    -- Synchronous: no callback (wait() below runs the next step). Not `sync and nil or
    -- cb`: that's always cb, and the steps would then run twice.
    local on_exit = nil
    if not opts.sync then
      on_exit = vim.schedule_wrap(function(res)
        if res.code ~= 0 then
          return done(("`%s` failed: %s"):format(cmd[1], vim.trim(res.stderr or "")))
        end
        run(i + 1)
      end)
    end
    local ok, proc = pcall(vim.system, cmd, { text = true }, on_exit)
    if not ok then
      return done(("couldn't run `%s`: %s"):format(cmd[1], proc))
    end
    if opts.sync then
      local res = proc:wait()
      if res.code ~= 0 then
        return done(("`%s` failed: %s"):format(cmd[1], vim.trim(res.stderr or "")))
      end
      run(i + 1)
    end
  end
  run(1)
end

return M
