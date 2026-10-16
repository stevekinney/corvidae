#!/bin/sh
# A deterministic full-screen program for the terminal example: it takes over the alternate screen,
# draws a frame, counts the keys it is given, and leaves on `q`, restoring the screen and the
# terminal settings. It is plain POSIX sh so it behaves the same on macOS and Linux.
saved=$(stty -g 2>/dev/null)
restore() {
  printf '\033[?25h\033[?1049l'
  [ -n "$saved" ] && stty "$saved" 2>/dev/null
}
trap restore EXIT
trap 'exit 0' INT TERM HUP
stty -echo -icanon min 1 time 0 2>/dev/null
printf '\033[?1049h\033[?25l\033[2J'

keys=0
draw() {
  printf '\033[2J\033[1;1H\033[1;36mFull-screen program\033[0m'
  printf '\033[3;1HThis program is using the alternate screen.'
  printf '\033[4;1HThe scrollback above it is untouched and comes back when you leave.'
  printf '\033[6;1HKeys received: \033[1m%s\033[0m' "$keys"
  printf '\033[8;1HPress \033[1mq\033[0m to leave.'
}
draw
while :; do
  key=$(dd bs=1 count=1 2>/dev/null)
  [ "$key" = q ] && break
  keys=$((keys + 1))
  draw
done
