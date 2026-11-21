if vim.g.loaded_ca65 then return end
vim.g.loaded_ca65 = true

-- Enter after "/**" adds the closing " */" in C files too (or whichever filetypes the
-- close_doc_comments option lists; ca65 buffers get it from ftplugin/ca65.lua)
vim.api.nvim_create_autocmd("FileType", {
  group = vim.api.nvim_create_augroup("ca65_doc_comments", { clear = true }),
  callback = function(args)
    if args.match == "ca65" then return end
    local ca65 = require("ca65")
    if ca65.closes_doc_comments(args.match) then ca65.close_doc_comments(args.buf) end
  end,
})

-- :Ref6502 browses every instruction; :Ref6502 lda shows one
vim.api.nvim_create_user_command("Ref6502", function(cmd)
  local ref = require("ca65.reference")
  if cmd.args ~= "" then ref.show(cmd.args) else ref.pick() end
end, { nargs = "?", desc = "6502 instruction reference (ca65 language server)" })

-- Downloads the language server for this plugin version (normally automatic)
vim.api.nvim_create_user_command("Ca65InstallServer", function()
  local server = require("ca65.server")
  vim.notify("ca65: downloading the language server " .. (server.version() or "") .. "…")
  server.install({
    on_done = function(err)
      if err then
        vim.notify("ca65: couldn't download the language server: " .. err, vim.log.levels.ERROR)
      else
        vim.notify("ca65: language server ready: " .. server.path())
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].filetype == "ca65" then require("ca65").start(buf) end
        end
      end
    end,
  })
end, { desc = "Download the ca65 language server" })
