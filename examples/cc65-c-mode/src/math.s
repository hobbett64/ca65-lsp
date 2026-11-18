; Math helpers with different calling conventions and return types.

.importzp sp, sreg
.import incsp3, popax

.export _clamp, _negate, _pack32

.segment "CODE"

;; Clamps a value to [low, high]. Declared __cdecl__, so all three arguments are on the stack.
.proc _clamp
    ldy #2
    lda (sp),y                  ; value
    ldy #1
    cmp (sp),y                  ; low
    bcs @not_low
    lda (sp),y
    jmp @done
@not_low:
    ldy #0
    cmp (sp),y                  ; high
    bcc @done
    beq @done
    lda (sp),y
@done:
    ldx #0                      ; unsigned char result: X = 0
    jmp incsp3
.endproc

;; Negates a signed byte.
.proc _negate
    eor #$FF
    clc
    adc #1
    ldx #0                      ; signed char result: X = sign extension
    cmp #$80
    bcc :+
    dex
:   rts
.endproc

;; Packs two words into a long: (high << 16) | low.
.proc _pack32
    sta sreg                    ; high (last argument) in A/X -> bytes 2..3 of the result
    stx sreg+1
    jmp popax                   ; low from the C stack -> A/X (bytes 0..1); popax returns for us
.endproc
