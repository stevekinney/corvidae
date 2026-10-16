import { describe } from 'bun:test';

import {
  hostFor,
  scenario,
  scenarioResult,
  settleScenarios,
  trackHostedProcess,
} from '../src/bun/bun-process.test-support.ts';
import { shellProfile } from '../src/bun/fixtures/bun-pipe-stdin.ts';

/**
 * Run by `filtered-run.test.ts` with a test-name filter, never by the default gate (its name is not a
 * test file's). The second scenario starts a process whose command carries a token only the run
 * that started it knows, then stays busy; the filter selects only the first test, and the run must
 * still not end until the second scenario has finished and cleaned up.
 */
// The parent's pid is the token: the run that started this one knows it, and nothing else shares it.
const token = `7919.${process.ppid}`;

const selected = scenario('finishes at once', () => undefined);

const unselected = scenario('is still running when the selected test finishes', async () => {
  const hosted = trackHostedProcess(hostFor('pipe', shellProfile(`sleep ${token}`)));
  await hosted.backend.start();
  await Bun.sleep(400);
});

describe('selected', () => {
  scenarioResult(selected.name, selected);
});

describe('unselected', () => {
  scenarioResult(unselected.name, unselected);
});

await settleScenarios();
