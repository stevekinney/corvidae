#!/bin/sh
# A deterministic pipe program for the terminal example: standard output and standard error carry
# different lines so a viewer can show them apart. A pipe has no line discipline, so every line
# ends in a carriage return as well as a line feed.
i=1
while [ "$i" -le 6 ]; do
  printf 'out %s: building package %s\r\n' "$i" "$i"
  printf '\033[31merr %s: warning in package %s\033[0m\r\n' "$i" "$i" >&2
  i=$((i + 1))
done
printf 'out done: exit 3\r\n'
printf '\033[31merr done: finished with a failure\033[0m\r\n' >&2
exit 3
