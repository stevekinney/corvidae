#!/bin/sh
# A program that stops reading its input, for the terminal example's review controls. Raw mode with
# echo off keeps the terminal's line discipline from discarding what the program does not read, so
# a long paste fills the terminal's input queue and the host has to hold the rest. After the stall
# the program reads again and discards everything, which is the capacity the terminal waits for.
# Output is written with explicit carriage returns because raw mode turns output processing off.
stty raw -echo
printf 'This program is not reading its input.\r\n'
printf 'Use Copy a long line in the review controls, paste it here, and read Backpressure: input paused.\r\n'
printf 'It reads again in 10 seconds.\r\n'
sleep 10
printf 'Reading again.\r\n'
exec cat >/dev/null
