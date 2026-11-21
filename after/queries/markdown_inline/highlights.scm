;; extends

; Hide the backslash of a Markdown escape, so hovers show TYPE_SOLDIER rather than
; TYPE\_SOLDIER (VS Code renders it this way; Neovim 0.10's bundled query only
; colours the escape). The offset trims the escaped character off the capture, so
; only the backslash is concealed.
((backslash_escape) @conceal
  (#offset! @conceal 0 0 0 -1)
  (#set! conceal ""))
