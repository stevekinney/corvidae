/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spawn a command on a pseudo-terminal this process owns: libc opens the pair, Bun spawns the
 * child on the slave, and the host keeps the master descriptor to read when it chooses.
 *
 * The start gate of `src/bun/pty-start-gate.ts` is kept, extended by one step: after the release
 * byte the shell opens the slave by path. A session leader that opens a terminal without O_NOCTTY
 * takes it as its controlling terminal (Linux and macOS both do; Bun's `detached` makes the child a
 * session leader but does not set one up for a descriptor it was merely handed).
 */
import { abandonGate, releaseGate } from '../../src/bun/pty-start-gate.ts';
import {
  closeQuietly,
  openPty,
  openSlaveNoCtty,
  setNonBlocking,
  setWindowSize,
  type PtyPair,
} from './pty-ffi.ts';

const GATE = 'IFS= read -r _ <&3 || exit 1\nexec 3<&-\n: <>"$1" || exit 1\nshift\nexec "$@"';

export type OwnedPty = {
  child: ReturnType<typeof Bun.spawn>;
  pair: PtyPair;
};

export function spawnOnPty(
  command: string[],
  options: {
    columns?: number;
    rows?: number;
    env?: Record<string, string>;
    nonBlocking?: boolean;
    abandon?: boolean;
  } = {},
): OwnedPty {
  const pair = openPty();
  const slave = openSlaveNoCtty(pair.slavePath);
  try {
    const rc = setWindowSize(pair, options.columns ?? 80, options.rows ?? 24);
    if (rc !== 0) throw new Error(`TIOCSWINSZ failed (${rc})`);
    if (options.nonBlocking !== false) setNonBlocking(pair.masterFd);
    const child = Bun.spawn(['/bin/sh', '-c', GATE, 'sh', pair.slavePath, ...command], {
      stdio: [slave, slave, slave, 'pipe'],
      detached: true,
      env: options.env ?? {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        TERM: 'xterm-256color',
      },
    });
    if (!(options.abandon === true ? abandonGate(child as never) : releaseGate(child as never))) {
      throw new Error('no release channel');
    }
    return { child, pair };
  } finally {
    // The child holds its own copies; keeping this one would stop the master from ever seeing the
    // slave close, so end of output would never be reported.
    closeQuietly(slave);
  }
}

/** Close the master. Call after the reader has stopped, so no thread is reading the descriptor. */
export function closeMaster(pair: PtyPair): void {
  closeQuietly(pair.masterFd);
}
