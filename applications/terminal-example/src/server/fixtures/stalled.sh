#!/bin/sh
# A program that stops reading its input, for the terminal example's review controls. Raw mode with
# echo off keeps the terminal's line discipline from discarding what the program does not read, so
# a long paste fills the terminal's input queue and the host has to hold the rest. After the stall
# the program reads again and discards everything, which is the capacity the terminal waits for.
# The stall is the first argument, in seconds: short for the automated check, long for a human
# reviewing with a screen reader. Output is written with explicit carriage returns because raw mode turns output processing off.
stty raw -echo
printf 'This program is not reading its input.\r\n'
printf 'Use Copy a long line in the review controls, paste it here, and read Backpressure: input paused.\r\n'
printf 'It reads again in %s seconds.\r\n' "$1"
sleep "$1"
printf 'Reading again.\r\n'
exec cat >/dev/null
