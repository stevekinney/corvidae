import type { ProcessProfile } from '../process-types.ts';
import { shellProfile } from './bun-pipe-stdin.ts';

export type OutputMode = 'pipe' | 'pty';

/**
 * What a program writes and how it ends, for the cells both modes share. A PTY turns `\n` into
 * `\r\n` on output unless post-processing is off, so a PTY script starts with `stty -opost` and
 * both modes then produce exactly the same bytes.
 */
export type OutputCase = {
  readonly body: string;
  readonly output: string;
};

const ESC = '\u001b';

/** `printf` one byte of `text` at a time, so the kernel sees each as its own write. */
function printfPerByte(text: string): string {
  return [...new TextEncoder().encode(text)]
    .map((byte) => `printf '\\${byte.toString(8).padStart(3, '0')}'`)
    .join('; ');
}

const UNICODE_TEXT = 'Aα é 日本 \u{1f600} done';

export const OUTPUT_CASES = {
  noNewlineOutput: { body: "printf 'ready> '", output: 'ready> ' },
  progressRewrites: {
    body: "printf '  0%%\\r 50%%\\r100%%\\n'",
    output: '  0%\r 50%\r100%\n',
  },
  alternateScreen: {
    body: "printf '\\033[?1049h\\033[2J\\033[Hfull screen\\033[?1049l'",
    output: `${ESC}[?1049h${ESC}[2J${ESC}[Hfull screen${ESC}[?1049l`,
  },
  unicodeOneByteAtATime: { body: printfPerByte(UNICODE_TEXT), output: UNICODE_TEXT },
  exitBeforeFirstOutput: { body: 'exit 0', output: '' },
} as const satisfies Record<string, OutputCase>;

/** The profile that runs `body` in `mode`. */
export function outputProfile(mode: OutputMode, body: string): ProcessProfile {
  return shellProfile(mode === 'pty' ? `stty -opost; ${body}` : body, [], { TERM: 'xterm' });
}

/** A program that exits with a code. */
export const NONZERO_EXIT = { body: "printf 'before'; exit 7", output: 'before', exitCode: 7 };

/** A program that is ended by a signal it sends itself. */
export const SIGNAL_EXIT = {
  body: "printf 'before'; kill -TERM $$",
  output: 'before',
  signal: 'SIGTERM',
};

/**
 * A leader and a descendant that both ignore TERM. They print their pids so a test can prove both
 * gone. Only KILL ends them.
 */
export const STUBBORN_DESCENDANT =
  'trap \'\' TERM; sleep 7919 & printf \'leader=%s descendant=%s \' "$$" "$!"; wait';

/**
 * A descendant that starts a session of its own, so the owned process group cannot reach it. Perl
 * does the `setsid`, which macOS has no command for, and announces itself only afterwards, so a
 * test that has read `escaped=` knows the escape has happened.
 */
export const ESCAPED_DESCENDANT =
  'printf \'leader=%s \' "$$"; perl -MPOSIX -e \'POSIX::setsid(); $|=1; print "escaped=$$ "; exec @ARGV\' sleep 7919 & wait';

/** A program that writes without end, for output the consumer never parses. */
export const ENDLESS_OUTPUT = 'printf \'leader=%s \' "$$"; exec yes';

/** Read the pids a fixture printed as `name=<pid>`. */
export function pidsIn(text: string): Record<string, number> {
  const pids: Record<string, number> = {};
  for (const [, name, pid] of text.matchAll(/(\w+)=(\d+)/g)) pids[name as string] = Number(pid);
  return pids;
}
