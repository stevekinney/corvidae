#!/bin/sh
# A deterministic escaped job for the terminal example's review controls. The forked child starts a
# session of its own, so nothing in the terminal's session reaches it, and it prints its process
# identifier so a reviewer can end it by hand afterwards. Its parent stays in the terminal's
# session, so the host can see the escape but cannot prove the child gone: ending this session
# leaves cleanup `unknown` and the server quarantines the slot. perl, because macOS has no
# `setsid` command; perl ships with macOS and most Linux distributions.
printf 'This program starts a process that leaves the terminal session on purpose.\r\n'
printf 'End the session, read Cleanup incomplete, then restart the server and kill the pid below.\r\n'
exec perl -MPOSIX -e 'if (fork) { wait } else { POSIX::setsid(); $|=1; print "escaped=$$\n"; exec "sleep", "300" }'
