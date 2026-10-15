/* A fixed-arity wrapper: ioctl is variadic, and Apple arm64 passes variadic arguments on the stack,
   which Bun's plain FFI call (a fixed-arity call) does not do. Compiled at runtime by bun:ffi's cc. */
extern int ioctl(int, unsigned long, ...);

int set_winsize(int fd, unsigned long request, int columns, int rows) {
  unsigned short size[4] = { (unsigned short)rows, (unsigned short)columns, 0, 0 };
  return ioctl(fd, request, size);
}

extern int fcntl(int, int, ...);

/* F_GETFL and F_SETFL are 3 and 4 on Linux and macOS alike. */
int get_flags(int fd) { return fcntl(fd, 3); }
int set_flags(int fd, int flags) { return fcntl(fd, 4, flags); }

/* F_SETFD is 2 and FD_CLOEXEC is 1 on Linux and macOS alike. */
int set_cloexec(int fd) { return fcntl(fd, 2, 1); }
