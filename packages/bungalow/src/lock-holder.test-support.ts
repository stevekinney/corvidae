/**
 * The child process the lock tests start. It reads one command per line from stdin:
 *
 * - `open` tries to open the Bungalow at the root named by its first argument and answers
 *   `HELD <deploymentId>`, `LOCKED <holder>`, or `ERROR <error name>`.
 * - `close` closes the handle it holds, if any, and answers `CLOSED`.
 *
 * It announces `READY` once it is listening, and it holds whatever lock it took until it is told
 * to close, killed, or its stdin ends.
 */
import { homeEnvironment, TEST_NAME } from './fixtures.test-support.ts';
import { BungalowLockedError, openBungalow, type Bungalow } from './index.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('The lock holder needs a root directory argument.');

let handle: Bungalow | undefined;

function answer(text: string): void {
  process.stdout.write(`${text}\n`);
}

answer('READY');
for await (const command of console) {
  if (command === 'open') {
    try {
      handle = openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
      answer(`HELD ${handle.deploymentId}`);
    } catch (error) {
      answer(
        error instanceof BungalowLockedError
          ? `LOCKED ${error.holderProcessIdentifier}`
          : `ERROR ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  } else if (command === 'close') {
    handle?.close();
    handle = undefined;
    answer('CLOSED');
  }
}
