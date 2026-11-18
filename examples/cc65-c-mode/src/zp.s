; Zero-page variables shared with C (declared with #pragma zpsym in include/game.h).

.exportzp _player_x

.segment "ZEROPAGE"
_player_x:  .res 1
