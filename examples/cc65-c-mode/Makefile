# Builds an NES ROM with cc65. Requires cc65 (cl65) in PATH.
SOURCES := src/main.c src/sprites.s src/math.s src/zp.s

demo.nes: $(SOURCES) include/game.h nes-demo.cfg
	cl65 -t nes -C nes-demo.cfg -O -I include -o $@ $(SOURCES)

clean:
	rm -f demo.nes src/*.o

.PHONY: clean
