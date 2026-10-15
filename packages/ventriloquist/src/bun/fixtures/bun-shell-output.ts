import { $ } from 'bun';

/** What the fixed pipeline below writes: Bun Shell runs `printf`, then `tr` upcases it. */
export const SHELL_OUTPUT_TEXT = 'ADA LOVELACE\nGRACE HOPPER\n';

/**
 * Run a fixed Bun Shell pipeline. This is the host's side of the contract: the shell runs here, in
 * the fixture, and the package only ever receives what it wrote.
 */
function runShellPipeline() {
  return $`printf 'Ada Lovelace\nGrace Hopper\n' | tr a-z A-Z`.quiet();
}

/** The Bun Shell result as an already-created `ReadableStream<Uint8Array>`. */
export async function createShellOutputStream(): Promise<ReadableStream<Uint8Array>> {
  const result = await runShellPipeline();
  return result.blob().stream();
}

/** The Bun Shell result as an async byte iterable, in chunks of `chunkBytes` so a code point can be cut. */
export async function* createShellOutputIterable(chunkBytes: number): AsyncGenerator<Uint8Array> {
  const result = await runShellPipeline();
  const bytes = result.bytes();
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    yield bytes.slice(offset, offset + chunkBytes);
  }
}
