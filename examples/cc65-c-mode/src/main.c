#include "game.h"

uint8_t frame_count;
uint16_t total_damage;

/* Called from assembly (see `jsr _on_hit` in src/sprites.s). */
void __fastcall__ on_hit(uint8_t enemy, uint16_t damage)
{
    total_damage += damage + enemy;
}

void main(void)
{
    uint8_t x = 10;

    set_palette(3);
    draw_sprite(x, 0x2000, clamp(x, 4, 200));
    player_x = negate(-5);
    total_damage = (uint16_t)(pack32(300, 7) >> 16);

    for (;;) {
        ++frame_count;

        /* Inline assembly behaves like ca65 code: hover, F12, completion, rename. */
        __asm__("lda %v", frame_count);
        __asm__("and #%%00000011");
        __asm__("sta _player_x");
    }
}
