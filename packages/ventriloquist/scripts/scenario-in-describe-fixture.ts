import { describe } from 'bun:test';

import { scenarioTest, settleScenarios } from '../src/bun/bun-process.test-support.ts';

/** Run by `filtered-run.integration.test.ts`: a scenario defined inside a describe callback, which must be refused. */
describe('a group', () => {
  scenarioTest('defined too late', () => undefined);
});

await settleScenarios();
