-- .s, .asm and .inc are ca65, as in the VS Code extension. Patterns with a priority,
-- because Neovim's own rules for these extensions (asm and others) win over a plain
-- extension rule. Uppercase .S (preprocessed GNU assembly) is left alone.
vim.filetype.add({
  pattern = {
    [".*%.s"] = { "ca65", { priority = 10 } },
    [".*%.asm"] = { "ca65", { priority = 10 } },
    [".*%.inc"] = { "ca65", { priority = 10 } },
  },
})
