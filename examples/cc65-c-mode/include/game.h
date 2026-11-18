#ifndef GAME_H
#define GAME_H

#include <stdint.h>

/* ---- Implemented in assembly (src/sprites.s, src/math.s) ---------------------------------- */

/* Selects the active background palette (0-3). */
void __fastcall__ set_palette(uint8_t index);

/* Draws the sprite whose tiles start at tile_addr at horizontal position x, with attributes attr. */
void __fastcall__ draw_sprite(uint8_t x, uint16_t tile_addr, uint8_t attr);

/* Returns value limited to the range [low, high]. */
uint8_t __cdecl__ clamp(uint8_t value, uint8_t low, uint8_t high);

/* Returns -value. */
int8_t __fastcall__ negate(int8_t value);

/* Combines two 16-bit halves into a 32-bit value: (high << 16) | low. */
uint32_t __fastcall__ pack32(uint16_t low, uint16_t high);

/* Returns the buttons pressed on controller port (0 or 1).
   Not implemented yet: put the cursor on `read_pad` and use the "Create assembly stub" code action. */
uint8_t __fastcall__ read_pad(uint8_t port);

/* ---- Implemented in C (src/main.c), called from assembly ----------------------------------- */

void __fastcall__ on_hit(uint8_t enemy, uint16_t damage);

/* ---- Variables ----------------------------------------------------------------------------- */

/* Defined in C, used from assembly. */
extern uint8_t frame_count;

/* Defined in assembly in the zero page (src/zp.s). */
extern uint8_t player_x;
#pragma zpsym ("player_x")

#endif
