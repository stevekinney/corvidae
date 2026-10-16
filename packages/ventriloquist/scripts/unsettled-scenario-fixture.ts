import { describe } from 'bun:test';

import { scenarioResult, settleScenarios } from '../src/bun/bun-process.test-support.ts';

/** Run by `filtered-run.test.ts`: a test whose scenario has not settled when the test begins must fail loudly. */
const unsettled = {
  name: 'never finishes',
  outcome: new Promise<never>(() => undefined),
  settled: () => false,
};

describe('a group', () => {
  scenarioResult(unsettled.name, unsettled);
});

await settleScenarios();
