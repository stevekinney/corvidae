/**
 * COR-2009 — `bureau.agents.references`: what names an agent by its identifier, which a page lists
 * before the identifier changes ("1 schedule (Weekly refund audit), 1 workflow (Order refund) and
 * 1 hook (Refund audit) name tool-runner"). A workflow file that cannot be read still names its
 * agents in its text.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEncryptionKey } from '@lostgradient/cryptography';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../../agent-catalog.ts';
import { findAgentReferences } from '../../agent-references.ts';
import { createMemoryAssetStorage } from '../../assets/storage';
import { createBureau } from '../../create-bureau.ts';
import { workflowFileDirectory } from '../../sources/workflow-file-directory.ts';
import type { Bureau } from '../../types.ts';
import type { WorkflowListing } from '../../workflow-file-catalog.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import { callAs } from './agent-definitions-fixtures.test-support.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const quiet = (name: string) =>
  createAgent({ name, generate: async () => ({ content: name, toolCalls: [] }) });

/** The sample world's Order refund: the comma at the end of line 11 is missing, so it cannot load. */
const ORDER_REFUND = `{
  "name": "order-refund",
  "description": "Looks up an order, waits for a person to approve, then issues the refund.",
  "trigger": { "kind": "signal", "signal": "refund-requested" },
  "steps": [
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner",
        "message": "Look up the order and propose a refund." } },
    { "kind": "await-signal", "signal": "approval", "review": true },
    { "kind": "activity", "handler": "agent",
      "input": { "agent": "tool-runner"
        "message": "Issue the approved refund." } }
  ]
}
`;

/** A workflow that loads, whose one step calls Assistant. */
const TRIAGE_INBOX = JSON.stringify({
  name: 'triage-inbox',
  title: 'Triage inbox',
  trigger: { kind: 'manual' },
  steps: [
    {
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Sort the inbox.' },
    },
  ],
});

async function start(): Promise<Bureau<AgentDefinitions>> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-agent-references-'));
  directories.push(directory);
  await writeFile(join(directory, 'order-refund.json'), ORDER_REFUND);
  await writeFile(join(directory, 'triage-inbox.json'), TRIAGE_INBOX);
  const bureau = await createBureau<AgentDefinitions>({
    id: 'agent-references',
    agents: { 'tool-runner': quiet('tool-runner'), assistant: quiet('assistant') },
    storage: new MemoryStorage(),
    durable: true,
    workflowSource: workflowFileDirectory(directory),
    hooks: {},
    assets: { storage: createMemoryAssetStorage() },
    answerEncryption: { current: await generateEncryptionKey() },
  });
  bureaus.push(bureau);
  return bureau;
}

describe('bureau.agents.references', () => {
  it('lists the schedules, workflows and hooks that name the agent, a file that cannot load included', async () => {
    const bureau = await start();
    const schedule = await bureau.schedules.create({
      agentName: 'tool-runner',
      input: 'Audit last week’s refunds.',
      spec: '0 11 * * 1',
      timeZone: 'America/Chicago',
      description: 'Weekly refund audit',
    });
    await bureau.schedules.create({ agentName: 'assistant', input: 'Summarize.', spec: '1h' });
    const hook = await bureau.hooks?.create({
      name: 'Refund audit',
      action: { type: 'notify' },
      events: ['run.settled'],
      scope: { kind: 'agent', id: 'tool-runner' },
    });
    await bureau.hooks?.create({
      name: 'Assistant runs',
      action: { type: 'notify' },
      events: ['run.settled'],
      scope: { kind: 'agent', id: 'assistant' },
    });
    expect(bureau.workflows?.list().find(({ id }) => id === 'order-refund')?.state).toBe('invalid');
    const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

    const answer = await callAs(handler, 'bureau.agents.references', { agentName: 'tool-runner' });

    expect(answer.error).toBeUndefined();
    expect(answer.result).toEqual({
      agentName: 'tool-runner',
      schedules: [{ id: schedule?.id, name: 'Weekly refund audit' }],
      workflows: [{ id: 'order-refund', title: null }],
      hooks: [{ id: hook?.id, name: 'Refund audit' }],
    });

    const assistant = await callAs(handler, 'bureau.agents.references', {
      agentName: 'assistant',
    });
    expect(assistant.result).toMatchObject({
      schedules: [{ name: null }],
      workflows: [{ id: 'triage-inbox', title: 'Triage inbox' }],
      hooks: [{ name: 'Assistant runs' }],
    });
  });

  it('answers NotFound for an agent the catalog does not hold', async () => {
    const bureau = await start();
    const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

    const answer = await callAs(handler, 'bureau.agents.references', { agentName: 'nobody' });

    expect(answer.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'agent' });
  });
});

describe('findAgentReferences', () => {
  const listing = (overrides: Partial<WorkflowListing>): WorkflowListing => ({
    id: 'w',
    state: 'ready',
    owner: 'anonymous:local',
    title: null,
    description: null,
    agent: null,
    paused: false,
    inputSchema: null,
    outputSchema: null,
    triggerKind: 'signal',
    trigger: null,
    steps: [],
    ...overrides,
  });

  it('reads a ready file’s agent steps, and an invalid file’s text, by exact identifier', async () => {
    const texts: Record<string, string> = {
      broken: '{ "steps": [ { "input": { "agent": "tool-runner-2" } }, { "agent" : "tool-runner" ',
      other: '{ "agent": "tool-runner-2" ',
    };
    const found = await findAgentReferences('tool-runner', {
      schedules: async () => [],
      workflows: () => [
        listing({
          id: 'ready',
          title: 'Ready',
          steps: [
            { kind: 'sleep', duration: '1m' },
            { kind: 'activity', handler: 'agent', input: { agent: 'tool-runner' } },
          ],
        }),
        listing({
          id: 'plugin-step',
          steps: [{ kind: 'activity', handler: 'other', input: { agent: 'tool-runner' } }],
        }),
        listing({ id: 'broken', state: 'invalid', steps: null }),
        listing({ id: 'other', state: 'invalid', steps: null }),
      ],
      workflowText: async (id) => (Object.hasOwn(texts, id) ? texts[id] : undefined),
    });

    expect(found.workflows).toEqual([
      { id: 'ready', title: 'Ready' },
      { id: 'broken', title: null },
    ]);
    expect(found.schedules).toEqual([]);
    expect(found.hooks).toEqual([]);
  });
});
