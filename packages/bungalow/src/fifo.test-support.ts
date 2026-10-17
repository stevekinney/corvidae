import { dlopen, FFIType, ptr } from 'bun:ffi';

/**
 * Create a FIFO at `path`. Bun has no `mkfifo`, and a test body may not start a process, so this
 * calls libc directly. `mkfifo` is not variadic, so a plain FFI call is correct on every platform.
 */
export function makeFifo(path: string): void {
  const { symbols } = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    mkfifo: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const result = symbols.mkfifo(ptr(Buffer.from(`${path}\0`)), 0o600);
  if (result !== 0) throw new Error(`mkfifo failed with ${result}`);
}
