import { shellProfile } from './bun-pipe-stdin.ts';

/**
 * PTY fixtures that depend on the terminal's line discipline. Output goes through the kernel, which
 * turns each `\n` a program writes into `\r\n`.
 */
export const PTY_FIXTURES = {
  /** A prompt, then one line of input. The kernel, not the host, echoes what is typed. */
  promptAndInput: {
    profile: shellProfile(
      'printf "name? "; IFS= read -r value; printf "hello %s\\n" "$value"; exit 0',
    ),
    ready: 'name? ',
    input: 'Ada\n',
    output: 'name? Ada\r\nhello Ada\r\n',
  },
  /** The same, with the kernel's echo turned off: nothing typed can appear in the output. */
  silentInput: {
    profile: shellProfile(
      'stty -echo; printf "secret? "; IFS= read -r value; printf "got %s" "$value"; exit 0',
    ),
    ready: 'secret? ',
    input: 'hunter2\n',
    output: 'secret? got hunter2',
  },
  /** Reports the terminal size at launch, waits for a line, then reports it again. */
  resize: {
    profile: shellProfile('stty size; printf "ready\\n"; IFS= read -r _line; stty size; exit 0'),
    ready: 'ready\r\n',
    input: '\n',
  },
  /** Reports whether it was handed a terminal. */
  terminalProbe: {
    profile: shellProfile('if [ -t 1 ]; then printf tty; else printf notty; fi'),
    output: 'tty',
  },
} as const;
