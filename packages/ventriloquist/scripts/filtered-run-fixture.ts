import { describe } from 'bun:test';

import {
  hostFor,
  scenarioTest,
  settleScenarios,
  trackHostedProcess,
} from '../src/bun/bun-process.test-support.ts';
import { shellProfile } from '../src/bun/fixtures/bun-pipe-stdin.ts';

/**
 * Run by `filtered-run.test.ts` with a test-name filter, never by the default gate (its name is not a
 * test file's). The second scenario starts a process whose command carries a token only this run
 * knows, then stays busy, so it is still in flight when the filter lets the first test finish.
 */
const token = process.env['FILTERED_RUN_TOKEN'];
if (token === undefined) throw new Error('FILTERED_RUN_TOKEN is required');

describe('selected', () => {
  scenarioTest('finishes at once', () => undefined);
});

// Bun runs a describe callback after the module body, so this scenario starts after the
// `settleScenarios` below has already returned: the case a filtered run used to abandon.
describe('unselected', () => {
  scenarioTest('is still running when the selected test finishes', async () => {
    const hosted = trackHostedProcess(hostFor('pipe', shellProfile(`sleep ${token}`)));
    await hosted.backend.start();
    await Bun.sleep(400);
  });
});

await settleScenarios();
