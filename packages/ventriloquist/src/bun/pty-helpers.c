/*
 * Fixed-arity wrappers for the three libc calls the PTY host needs that are variadic in C. Bun's
 * plain FFI calls them with a fixed-arity convention, which on Apple arm64 passes the variadic
 * arguments in registers instead of on the stack: `ioctl` and `fcntl` then return success and do
 * nothing. Compiled at runtime by `cc` from `bun:ffi`; the file includes no header so the build
 * needs no SDK.
 */
extern int ioctl(int, unsigned long, ...);
extern int fcntl(int, int, ...);

/* TIOCSWINSZ with a `struct winsize` of rows, columns and two unused pixel fields. */
int pty_set_window_size(int descriptor, unsigned long request, int columns, int rows) {
  unsigned short size[4] = { (unsigned short)rows, (unsigned short)columns, 0, 0 };
  return ioctl(descriptor, request, size);
}

/* F_GETFL is 3 and F_SETFL is 4 on Linux and macOS alike. */
int pty_get_flags(int descriptor) { return fcntl(descriptor, 3); }
int pty_set_flags(int descriptor, int flags) { return fcntl(descriptor, 4, flags); }

/* F_SETFD is 2 and FD_CLOEXEC is 1 on Linux and macOS alike. */
int pty_set_close_on_exec(int descriptor) { return fcntl(descriptor, 2, 1); }
