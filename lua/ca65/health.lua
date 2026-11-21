-- :checkhealth ca65
local M = {}

function M.check()
  local health = vim.health
  local config = require("ca65").config
  local server = require("ca65.server")

  health.start("Neovim")
  if vim.fn.has("nvim-0.11") == 1 then
    health.ok("Neovim " .. tostring(vim.version()))
  else
    health.error("Neovim 0.11 or newer is required")
  end

  health.start("Language server")
  if config.server.cmd then
    health.ok("Using a custom command: " .. table.concat(config.server.cmd, " "))
  else
    local node = config.server.node
    if vim.fn.executable(node) == 1 then
      local out = vim.system({ node, "--version" }, { text = true }):wait()
      local major = tonumber((out.stdout or ""):match("^v(%d+)"))
      if major and major >= 18 then
        health.ok("Node.js " .. vim.trim(out.stdout))
      else
        health.error("Node.js 18 or newer is required (found " .. vim.trim(out.stdout or "?") .. ")")
      end
    else
      health.error("`" .. node .. "` not found: install Node.js 18 or newer, or set server.node")
    end
    local version = server.version()
    if server.local_server() then
      health.ok("Using the server built in the plugin's directory: " .. server.local_server())
    elseif server.downloaded_server() then
      health.ok("Server " .. version .. ": " .. server.downloaded_server())
    else
      health.warn("Server " .. tostring(version) .. " isn't downloaded yet",
        { "It downloads when you open a ca65 file, or run :Ca65InstallServer",
          "From: " .. server.release_url() })
    end
    for _, tool in ipairs({ "curl", "tar" }) do
      if vim.fn.executable(tool) ~= 1 then
        health.warn("`" .. tool .. "` not found: needed to download the server")
      end
    end
  end

  health.start("ca65")
  local settings = type(config.settings) == "table" and config.settings or {}
  local ca65 = settings.executablePath or "ca65"
  if vim.fn.executable(ca65) == 1 then
    health.ok("ca65: " .. vim.fn.exepath(ca65))
  else
    health.warn("`" .. ca65 .. "` not found: no assembler diagnostics",
      { "Install cc65, or set settings.executablePath" })
  end

  local clients = vim.lsp.get_clients({ name = "ca65" })
  if #clients > 0 then
    health.ok(("%d ca65 server(s) running"):format(#clients))
  else
    health.info("No ca65 server running (open a ca65 file to start one)")
  end
end

return M
