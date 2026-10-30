/**
 * Every workflow type `createRunEngine` registers says in one line what it is for (COR-1812), so
 * the page that lists the Bureau's internal workflows has a sentence for each. The test registers
 * the real definitions, not stand-ins, and reads the descriptions back from the engine.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { createGoalWorkflow } from './goal-workflow';
import { createHarness } from './goal-workflow-fixtures';
import { RUN_ENGINE_WORKFLOW_TYPES } from './run-engine-workflow-types';
import { createRunWorkflow } from './run-workflow';

describe('the workflow types a Bureau’s run engine registers', () => {
  it('each declare a one-line description', async () => {
    const storage = new MemoryStorage();
    const harness = createHarness();
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: createRunWorkflow(
        createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false })),
      ),
      goalWorkflow: createGoalWorkflow(harness.world.ports, harness.workflowOptions),
      recover: false,
      backgroundTasks: 'manual',
    });
    try {
      for (const type of RUN_ENGINE_WORKFLOW_TYPES) {
        const description = engine.getWorkflowDefinition(type)?.description;
        expect(description, `${type} has a description`).toBeDefined();
        expect(description?.trim().length, `${type}'s description is not blank`).toBeGreaterThan(0);
        expect(description, `${type}'s description is one line`).not.toContain('\n');
        expect(description?.length, `${type}'s description is a sentence`).toBeLessThanOrEqual(160);
      }
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
