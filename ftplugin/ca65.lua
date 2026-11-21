if vim.b.did_ftplugin then return end
vim.b.did_ftplugin = 1

require("ca65").attach(0)

vim.b.undo_ftplugin = "setlocal comments< commentstring< iskeyword< formatoptions<"
  .. " | unlet! b:match_words b:match_ignorecase"
