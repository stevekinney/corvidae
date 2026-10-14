import type { ProcessProfile } from '../process-types.ts';

/**
 * Where the fixtures find `sh`, `printf`, `stty`, `perl`, `sleep` and `yes` on both supported
 * platforms. It is fixed, so the host's own search path never reaches a fixture.
 */
const FIXTURE_PATH = '/usr/bin:/bin';

/** A profile that runs `script` with `sh -c` and an environment holding nothing but PATH. */
export function shellProfile(
  script: string,
  scriptArguments: readonly string[] = [],
  environment: Record<string, string> = {},
): ProcessProfile {
  return {
    executable: 'sh',
    argumentList: ['-c', script, 'sh', ...scriptArguments],
    workingDirectory: '/',
    environment: { PATH: FIXTURE_PATH, ...environment },
  };
}

/**
 * Pipe fixtures that read standard input. Each prints a sentinel on standard output once it is
 * ready for input, so a test waits for that event instead of sleeping.
 */
export const PIPE_STDIN_FIXTURES = {
  /** A prompt with no newline, one line of input, and a diagnostic on the other channel. */
  promptAndInput: {
    profile: shellProfile(
      'printf "name? "; IFS= read -r value; printf "hello %s" "$value"; printf "bye" >&2; exit 0',
    ),
    ready: 'name? ',
    input: 'Ada\n',
    stdout: 'name? hello Ada',
    stderr: 'bye',
  },
  /** Reads until end of input, so it finishes only when the host closes standard input. */
  untilEndOfInput: {
    profile: shellProfile('printf "ready."; cat; printf "|end"; exit 0'),
    ready: 'ready.',
    input: 'one\ntwo\n',
    stdout: 'ready.one\ntwo\n|end',
  },
  /** Closes its standard input at once, so the next write meets a broken pipe. */
  closesInput: {
    profile: shellProfile('exec 0<&-; printf "closed."; sleep 7919'),
    ready: 'closed.',
  },
  /** Reports whether it was handed a terminal. */
  terminalProbe: {
    profile: shellProfile('if [ -t 1 ]; then printf tty; else printf notty; fi'),
  },
} as const;
