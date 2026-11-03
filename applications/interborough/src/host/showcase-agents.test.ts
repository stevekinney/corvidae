/**
 * The sample world's built-in agents and tools (`showcase-agents.ts`) on a Bureau of their own:
 * they are registered unprefixed (built in, not a plugin's), the scripted ones answer from their
 * scripts, and Tool runner tells the refund story with the Asks levels the sample world gives its
 * tools.
 */
import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  orderNamedIn,
  SHOWCASE_AGENT_IDENTIFIERS,
  SHOWCASE_ASSISTANT_REPLY,
  SHOWCASE_TOOL_APPROVAL,
  SHOWCASE_WORKFLOW_AUTHOR_REPLY,
  showcaseBuiltInAgents,
  toolRunnerLookupReply,
} from './showcase-agents.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** Starts a task of `agent` on `message` and answers its result. */
async function run(bureau: Bureau<AgentDefinitions>, agent: string, message: string) {
  const task = await bureau.tasks.start(agent, message);
  return task.result();
}

async function start(): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { ...showcaseBuiltInAgents().agents },
    storage: new MemoryStorage(),
    durable: true,
  });
  bureaus.push(bureau);
  return bureau;
}

/** Every tool call a run made, with its outcome, in order. */
function callsOf(result: Awaited<ReturnType<typeof run>>): (readonly [string, string])[] {
  return result.steps.flatMap((step) =>
    step.results.map((outcome) => [outcome.toolName, outcome.outcome] as const),
  );
}

describe('the showcase built-in agents', () => {
  test('are the six built-ins, unprefixed, so no plugin owns them', async () => {
    const bureau = await start();
    const ids = bureau.agents.list().map(({ id }) => id);
    expect(ids.toSorted()).toEqual([...SHOWCASE_AGENT_IDENTIFIERS].toSorted());
    expect(ids.some((id) => id.includes(':'))).toBe(false);
    expect(Object.keys(showcaseBuiltInAgents().agents)).not.toContain('release-helper');
  });

  test('Assistant, Echo and Workflow author answer from their scripts', async () => {
    const bureau = await start();
    const assistant = await run(bureau, 'assistant', 'Say hello');
    expect(assistant.content).toBe(SHOWCASE_ASSISTANT_REPLY);
    const echo = await run(bureau, 'echo', 'Say this back');
    expect(echo.content).toBe('Say this back');
    const author = await run(bureau, 'workflow-author', 'Help me build');
    expect(author.content).toBe(SHOWCASE_WORKFLOW_AUTHOR_REPLY);
  });

  test('Tool runner looks the order up, then waits on a person to approve its whole total', async () => {
    const bureau = await start();
    const result = await run(
      bureau,
      'tool-runner',
      'Please refund order 4471, it arrived damaged.',
    );
    expect(callsOf(result)).toEqual([
      ['lookup-order', 'success'],
      ['issue-refund', 'action_required'],
    ]);
    const pending = result.steps.at(-1)?.results[0];
    expect(pending?.pendingApproval).toBeDefined();
  });

  test('Tool runner only looks an order up when that is all it is asked', async () => {
    const bureau = await start();
    const result = await run(bureau, 'tool-runner', 'Look up order 4468');
    expect(callsOf(result)).toEqual([['lookup-order', 'success']]);
    expect(result.content).toBe(toolRunnerLookupReply('4468'));
  });

  test('asks Never for Lookup order, Always for Issue refund and On changes for Triage refunds', () => {
    expect(SHOWCASE_TOOL_APPROVAL).toEqual({
      'lookup-order': 'never',
      'issue-refund': 'always',
      'triage-refunds': 'on-changes',
    });
  });
});

describe('orderNamedIn', () => {
  test('finds the order number a message names', () => {
    expect(orderNamedIn('Please refund order 4471, it arrived damaged.')).toBe('4471');
    expect(orderNamedIn('Look up order #4468')).toBe('4468');
    expect(orderNamedIn('Say hello')).toBeUndefined();
  });
});
