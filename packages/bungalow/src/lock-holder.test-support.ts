/**
 * The child process the lock tests start. It opens the Bungalow at the root named by its first
 * argument, announces `READY <deploymentId>` on stdout, and then holds the lock until it is killed.
 */
import { homeEnvironment, TEST_NAME } from './fixtures.test-support.ts';
import { openBungalow } from './index.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('The lock holder needs a root directory argument.');

const handle = openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
process.stdout.write(`READY ${handle.deploymentId}\n`);
setInterval(() => {}, 60_000);
