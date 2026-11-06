/**
 * The sample world's built-in agents and tools (`showcase-agents.ts`) on a Bureau of their own:
 * they are registered unprefixed (built in, not a plugin's), the scripted ones answer from their
 * scripts, and Tool runner tells the refund story with the Asks levels the sample world gives its
 * tools.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { workflowFileDirectory } from '@lostgradient/bureau/sources';
import { MemoryStorage } from '@lostgradient/storage';
import { resolveCapabilityTier } from 'armorer';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createShowcaseIssueRefundTool,
  createShowcaseLookupOrderTool,
  createShowcaseTriageRefundsTool,
  orderNamedIn,
  SHOWCASE_AGENT_IDENTIFIERS,
  SHOWCASE_ASSISTANT_REPLY,
  SHOWCASE_HUMAN_INPUT,
  SHOWCASE_ORDERS,
  SHOWCASE_TOOL_APPROVAL,
  SHOWCASE_TOOL_RUNNER_PLAN,
  SHOWCASE_WORKFLOW_AUTHOR_REPLY,
  SHOWCASE_WORKFLOW_AUTHOR_TOOLS,
  showcaseBuiltInAgents,
  showcaseCatalogTools,
  showcaseHumanInputGenerate,
  showcaseToolRunnerGenerate,
  toolRunnerLookupReply,
  type ShowcasePacing,
  type ShowcaseToolRunnerMoment,
} from './showcase-agents.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Starts a task of `agent` on `message` and answers its result. */
async function run(bureau: Bureau<AgentDefinitions>, agent: string, message: string) {
  const task = await bureau.tasks.start(agent, message);
  return task.result();
}

async function start(pacing?: ShowcasePacing): Promise<Bureau<AgentDefinitions>> {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-agents-workflows-'));
  directories.push(directory);
  const builtIns = showcaseBuiltInAgents(pacing);
  const bureau = await createBureau<AgentDefinitions>({
    agents: { ...builtIns.agents },
    ...(builtIns.withBureauTools === undefined
      ? {}
      : { agentsWithBureauTools: builtIns.withBureauTools }),
    storage: new MemoryStorage(),
    durable: true,
    // The workflow tools exist only with a workflow directory, as the host always has one.
    workflowSource: workflowFileDirectory(directory),
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

  test('Workflow author holds Create workflow and Discover agents, Bureau’s own tools', async () => {
    const bureau = await start();
    const author = bureau.agents.find('workflow-author');
    expect(
      author === undefined
        ? []
        : [...(author as unknown as { toolNames: readonly string[] }).toolNames].toSorted(),
    ).toEqual(Object.keys(SHOWCASE_WORKFLOW_AUTHOR_TOOLS).toSorted());
    expect(SHOWCASE_WORKFLOW_AUTHOR_TOOLS).toEqual({
      'bureau:workflows-create': 'on-changes',
      'bureau:discover-agents': 'never',
    });
  });

  test('name each tool for a person, and call Issue refund Dangerous (S64)', () => {
    expect(createShowcaseLookupOrderTool().metadata).toMatchObject({
      readOnly: true,
      title: 'Lookup order',
    });
    expect(createShowcaseIssueRefundTool().metadata).toMatchObject({
      dangerous: true,
      title: 'Issue refund',
    });
    expect(createShowcaseTriageRefundsTool().metadata).toMatchObject({
      mutates: true,
      title: 'Triage refunds',
    });
  });

  test('are offered to the catalog by name, so a screen reads Issue refund as dangerous from it', () => {
    const tools = showcaseCatalogTools();
    expect(Object.keys(tools)).toEqual(['lookup-order', 'issue-refund', 'triage-refunds']);
    expect(
      Object.values(tools).map((tool) => [
        tool.name,
        resolveCapabilityTier(tool.metadata, tool.tags),
      ]),
    ).toEqual([
      ['lookup-order', 'read-only'],
      ['issue-refund', 'dangerous'],
      ['triage-refunds', 'mutating'],
    ]);
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

  test('Tool runner says the order’s note as it asks, the answer it remembers, and is paced before each answer', async () => {
    const moments: ShowcaseToolRunnerMoment[] = [];
    const bureau = await start({ toolRunner: (moment) => void moments.push(moment) });
    const result = await run(
      bureau,
      'tool-runner',
      'Please refund order 4471, it arrived damaged.',
    );
    expect(result.steps.at(-1)?.content).toBe(SHOWCASE_ORDERS['4471']?.note);
    expect(moments.map(({ step, orderId }) => [step, orderId])).toEqual([
      ['lookup', '4471'],
      ['refund-ask', '4471'],
    ]);
  });

  test('Request human input says why it asks, then asks Staging or Production with a sentence for each', async () => {
    const generate = showcaseHumanInputGenerate();
    const conversation = { getMessages: () => [{ role: 'user', content: 'Ship the release.' }] };
    const response = await generate({ conversation } as unknown as Parameters<typeof generate>[0]);
    expect(response.content).toBe('Before I ship it I need one answer.');
    expect(response.toolCalls).toEqual([
      {
        id: 'showcase-requestHumanInput-1',
        name: 'requestHumanInput',
        arguments: {
          signalName: 'environment',
          prompt: 'Which environment should the release go to?',
          answerSchema: SHOWCASE_HUMAN_INPUT.answerSchema,
        },
      },
    ]);
    // The tool takes the schema as it is: Staging and Production with their own descriptions, or
    // the person's own words.
    expect(SHOWCASE_HUMAN_INPUT.answerSchema).toMatchObject({
      'x-allowOther': true,
      'x-labels': { staging: 'Staging', production: 'Production' },
      'x-descriptions': {
        staging: 'Deploys to the staging site',
        production: 'Deploys to the live site',
      },
    });
  });

  test('Tool runner ends a refund’s run with no reply once the refund is decided', async () => {
    const generate = showcaseToolRunnerGenerate();
    const conversation = {
      getMessages: () => [
        { role: 'user', content: 'Please refund order 4472, $18.50.' },
        {
          role: 'assistant',
          toolResult: { callId: 'showcase-lookup-order-1', outcome: 'success' },
        },
        {
          role: 'assistant',
          toolResult: { callId: 'showcase-issue-refund-1', outcome: 'success' },
        },
      ],
    };
    const response = await generate({ conversation } as unknown as Parameters<typeof generate>[0]);
    expect(response).toEqual({ content: '', toolCalls: [] });
  });

  test('Tool runner answers a message that names no order with its plan, once its pace lets it', async () => {
    const answering = Promise.withResolvers<void>();
    const bureau = await start({
      toolRunner: async (moment) => {
        if (moment.step === 'answer') await answering.promise;
      },
    });
    const task = await bureau.tasks.start('tool-runner', 'Rename the billing tables');
    answering.resolve();
    const result = await task.result();
    expect(callsOf(result)).toEqual([]);
    expect(result.content).toBe(SHOWCASE_TOOL_RUNNER_PLAN);
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
