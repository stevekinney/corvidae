import { describe, expect, test } from 'bun:test';
import { constants, readSync } from 'node:fs';

import { TIOCSWINSZ, createPtyDevice, loadPtyDevice, type LibcBindings } from './pty-device.ts';

/** Bindings that all succeed, recording what was asked; `failing` replaces single calls. */
function bindings(failing: Partial<LibcBindings> = {}) {
  const calls: string[] = [];
  const base: LibcBindings = {
    posix_openpt: (flags) => {
      calls.push(`posix_openpt:${flags}`);
      return 9;
    },
    grantpt: () => 0,
    unlockpt: () => 0,
    ptsname: () => '/dev/pts/9',
    setWindowSize: (descriptor, request, columns, rows) => {
      calls.push(`size:${descriptor}:${request}:${columns}x${rows}`);
      return 0;
    },
    getFlags: () => 2,
    setFlags: (_descriptor, flags) => {
      calls.push(`flags:${flags}`);
      return 0;
    },
    setCloseOnExec: () => 0,
  };
  const closed: number[] = [];
  const device = createPtyDevice({ ...base, ...failing }, 123, {
    open: (path, flags) => {
      calls.push(`open:${path}:${flags}`);
      return 10;
    },
    close: (descriptor) => {
      closed.push(descriptor);
    },
  });
  return { device, calls, closed };
}

describe('a pseudo-terminal device', () => {
  test('opens a master that is non-blocking, close-on-exec and not a controlling terminal', () => {
    const { device, calls, closed } = bindings();
    expect(device.open()).toEqual({ masterFd: 9, slavePath: '/dev/pts/9' });
    expect(calls).toEqual([
      `posix_openpt:${constants.O_RDWR | constants.O_NOCTTY}`,
      `flags:${2 | constants.O_NONBLOCK}`,
    ]);
    expect(closed).toEqual([]);
  });

  test.each([
    ['posix_openpt', { posix_openpt: () => -1 }, false],
    ['grantpt', { grantpt: () => 1 }, true],
    ['unlockpt', { unlockpt: () => 1 }, true],
    ['ptsname', { ptsname: () => null }, true],
    ['FD_CLOEXEC', { setCloseOnExec: () => -1 }, true],
    ['fcntl(F_GETFL)', { getFlags: () => -1 }, true],
    ['fcntl(F_SETFL)', { setFlags: () => -1 }, true],
  ] as const)('a failing %s throws and leaves nothing open', (_name, failing, hadDescriptor) => {
    const { device, closed } = bindings(failing);
    expect(() => device.open()).toThrow();
    expect(closed).toEqual(hadDescriptor ? [9] : []);
  });

  test('opens a slave without taking it as the controlling terminal', () => {
    const { device, calls } = bindings();
    expect(device.openSlave('/dev/pts/9')).toBe(10);
    expect(calls).toEqual([`open:/dev/pts/9:${constants.O_RDWR | constants.O_NOCTTY}`]);
  });

  test('sets the window size with the platform request, and throws when the kernel refuses', () => {
    const { device, calls } = bindings();
    device.setWindowSize({ masterFd: 9, slavePath: 'x' }, 90, 33);
    expect(calls).toEqual(['size:9:123:90x33']);
    const refusing = bindings({ setWindowSize: () => -1 });
    expect(() => refusing.device.setWindowSize({ masterFd: 9, slavePath: 'x' }, 1, 1)).toThrow(
      'TIOCSWINSZ failed',
    );
  });

  test('closing a descriptor that is already closed is not an error', () => {
    const throwing = createPtyDevice({} as LibcBindings, 1, {
      open: () => 0,
      close: () => {
        throw new Error('EBADF');
      },
    });
    expect(() => throwing.close(1)).not.toThrow();
  });

  test('names a window-size request for every supported platform', () => {
    expect(TIOCSWINSZ.linux).toBe(0x5414);
    expect(TIOCSWINSZ.darwin).toBe(0x80087467);
  });
});

describe('the device on this host', () => {
  test('is loaded once and opens a real terminal whose master does not block', () => {
    const device = loadPtyDevice();
    expect(loadPtyDevice()).toBe(device);
    const pair = device.open();
    const slave = device.openSlave(pair.slavePath);
    try {
      expect(pair.slavePath).toMatch(/^\/dev\/(pts\/\d+|ttys\d+)$/);
      device.setWindowSize(pair, 120, 40);
      const buffer = new Uint8Array(16);
      // A master with nothing to read says so at once instead of waiting: that is O_NONBLOCK.
      expect(() => readSync(pair.masterFd, buffer, 0, buffer.length, null)).toThrow(
        expect.objectContaining({ code: 'EAGAIN' }),
      );
    } finally {
      device.close(slave);
      device.close(pair.masterFd);
    }
  });
});
