/**
 * A process that opens the local home at the root its first argument names on the portable lock,
 * prints `HELD` (or `LOCKED <holder>`, or `ERROR <name>`), and holds the home until its stdin ends.
 * It runs on Node or Bun: `node-runtime.test-support.ts` starts it under Node, and
 * `node-runtime.integration.test.ts` under Node beside a Bun holder.
 *
 * With `default` as the second argument it takes the default `flock(2)` lock instead, which only
 * Bun has.
 */
import { openLocalBungalow } from './bungalow.ts';
import { BungalowLockedError } from './errors.ts';
import { acquirePortableLock } from './lock.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('The lock holder needs a root directory argument.');

try {
  const home = await openLocalBungalow({
    name: 'bungalow-node',
    root,
    ...(process.argv[3] === 'default' ? {} : { acquireLock: acquirePortableLock }),
  });
  process.stdout.write('HELD\n');
  process.stdin.resume();
  process.stdin.once('end', () => home.close());
} catch (error) {
  process.stdout.write(
    error instanceof BungalowLockedError
      ? `LOCKED ${error.holderProcessIdentifier}\n`
      : `ERROR ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
}
