import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { join } from 'node:path';

/** A child process running `lock-holder.test-support.ts`, driven one command line at a time. */
export type LockChild = {
  readonly processIdentifier: number;
  /** Send one command and resolve with the child's one-line answer. */
  ask(command: string): Promise<string>;
  /** SIGKILL the child, so it cannot close anything, and wait for it to be gone. */
  kill(): Promise<void>;
};

/** Reads newline-terminated lines from a stream, keeping what arrives past the first line. */
class LineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = '';

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async next(): Promise<string> {
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return line;
      }
      const { done, value } = await this.#reader.read();
      if (value !== undefined) this.#buffer += this.#decoder.decode(value, { stream: true });
      if (done && !this.#buffer.includes('\n')) {
        throw new Error(`The child exited before it answered: ${JSON.stringify(this.#buffer)}`);
      }
    }
  }
}

export async function startLockChild(root: string): Promise<LockChild> {
  const child = spawnWithHangGuard(
    [process.execPath, join(import.meta.dir, 'lock-holder.test-support.ts'), root],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  const lines = new LineReader(child.stdout);
  const ready = await lines.next();
  if (ready !== 'READY') throw new Error(`Unexpected lock child output: ${ready}`);
  return {
    processIdentifier: child.pid,
    async ask(command) {
      child.stdin.write(`${command}\n`);
      await child.stdin.flush();
      return lines.next();
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}
