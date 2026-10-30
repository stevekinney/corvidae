/**
 * COR-1937 — `bureau.contexts.window` for a context of a file agent: the instructions, the tool
 * schemas, and the window of the file's own `model` come from the agent file, which is how an
 * application such as Interborough defines its agents.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForTaskState } from './test';
import { startTaskFrom } from './test/task-start-request.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const answering: GenerateFunction = async () => ({
  content: 'done',
  toolCalls: [],
  usage: { prompt: 20, completion: 3, total: 23 },
});

describe('contexts.window for a file agent', () => {
  it('reads instructions, tools and the model’s window from the agent file', async () => {
    const harness = await startFileBureau({ overrides: { models: { generate: () => answering } } });
    harnesses.push(harness);
    await harness.put(
      'picker.md',
      agentFileText(
        { model: KNOWN_MODEL, tools: '[lookup-order]' },
        'You answer order questions.\n',
      ),
    );
    await harness.bureau.agents.refresh();
    const run = await startTaskFrom(harness.bureau, {
      input: 'where is my order',
      agentName: 'picker',
      principal: 'alice',
    });
    await waitForTaskState(harness.bureau, run.id);

    const report = await harness.bureau.contexts.window(run.contextId);

    const tokens = Object.fromEntries(
      (report?.categories ?? []).map((category) => [category.name, category.tokens]),
    );
    expect(tokens['system']).toBeGreaterThan(0);
    expect(tokens['tools']).toBeGreaterThan(0);
    expect(report?.usedReported).toBe(20);
    expect(report?.maxTokens).toBeGreaterThan(0);
    expect(report?.usedEstimated).toBe(
      (report?.categories ?? []).reduce((total, category) => total + category.tokens, 0),
    );
  });
});
