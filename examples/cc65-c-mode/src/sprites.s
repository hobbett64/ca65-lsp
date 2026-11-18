; Sprite helpers implemented in assembly and called from C.
; Hover any `_name` declared in include/game.h to see its C prototype.

.importzp sp, tmp1
.import incsp3
.import _frame_count            ; defined in C (src/main.c)
.import _on_hit                 ; implemented in C (src/main.c)
.import pusha

.export _set_palette, _draw_sprite

.segment "BSS"
palette_index:  .res 1
last_attr:      .res 1

.segment "CODE"

;; Selects the active palette.
;; @param A palette index (0-3)
.proc _set_palette
    and #$03
    sta palette_index
    rts
.endproc

;; Draws one sprite.
;; @input x at (sp),y=2, tile_addr at (sp),y=0..1, attr in A
;; @clobbers A, Y, tmp1
.proc _draw_sprite
    sta last_attr               ; attr: last argument, in A
    ldy #0
    lda (sp),y                  ; tile_addr low byte
    sta tmp1
    ldy #2
    lda (sp),y                  ; x
    clc
    adc _frame_count            ; C variable, hover it

    ; Calling C from assembly: push the arguments left to right, the last one goes in A/X.
    lda #1                      ; enemy
    jsr pusha
    lda #<500                   ; damage (last argument: A/X)
    ldx #>500
    jsr _on_hit

    jmp incsp3                  ; pop x + tile_addr (3 bytes) and return
.endproc
