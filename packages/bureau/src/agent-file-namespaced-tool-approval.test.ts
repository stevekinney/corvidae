/**
 * COR-1879 — a file agent's approvals name a tool by its identity, not by the bare name two
 * namespaces can share: a chat grant for `a:search` does not let `b:search` run, and the
 * `toolApproval` value of the key the file declared applies to the tool under that key, even when
 * the host registered a namespaced tool under a bare key.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AnyTool, createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentFileDirectory } from './sources/agent-file-directory';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import type { Bureau } from './types';

const executed: string[] = [];

function searchIn(namespace: string): AnyTool {
  return createTool({
    name: 'search',
    namespace,
    version: '1.0.0',
    description: `Search ${namespace}`,
    input: z.object({ query: z.string() }),
    metadata: { mutates: true },
    execute: async ({ query }) => {
      executed.push(`${namespace}:${query}`);
      return { found: query };
    },
  });
}

const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  executed.length = 0;
});

/** The provider name the model calls on its first step of a run; read when the step runs. */
const plan: { call: string; query: string } = { call: 'a__search', query: 'q1' };

async function start(
  tools: Record<string, AnyTool>,
  frontmatter: Record<string, string>,
): Promise<FileBureauHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-namespaced-approval-'));
  roots.push(directory);
  const asked = new Set<string>();
  const harness = await startFileBureau({
    directory,
    scripts: {
      [KNOWN_MODEL.split('/')[1] as string]: () => {
        const key = `${plan.call}:${plan.query}`;
        if (asked.has(key)) return 'Done.';
        asked.add(key);
        return {
          content: '',
          toolCalls: [{ name: plan.call, arguments: { query: plan.query } }],
        };
      },
    },
    overrides: {
      agentApprovalSecret: 'namespaced-secret',
      agentSource: agentFileDirectory(directory, { tools }),
    },
  });
  harnesses.push(harness);
  await harness.put('helper.md', agentFileText({ model: KNOWN_MODEL, ...frontmatter }));
  await harness.bureau.agents.refresh();
  return harness;
}

function pendingOf(bureau: Bureau, runId: string) {
  return bureau.reviews.list().filter((review) => review.runId === runId);
}

async function ask(
  bureau: Bureau,
  call: string,
  query: string,
  contextId?: string,
): Promise<{ id: string; contextId: string }> {
  plan.call = call;
  plan.query = query;
  const task = await bureau.tasks.start('helper', 'Go.', {
    principal: ALICE,
    ...(contextId === undefined ? {} : { contextId }),
  });
  await task.result();
  return { id: task.id, contextId: task.contextId };
}

describe('a file agent with two namespaces that share a tool name (COR-1879)', () => {
  it('reports the approval as a:search, and remembering it does not authorize b:search', async () => {
    const { bureau } = await start(
      { 'a:search': searchIn('a'), 'b:search': searchIn('b') },
      { tools: '["a:search", "b:search"]' },
    );
    const first = await ask(bureau, 'a__search', 'q1');
    const [review] = pendingOf(bureau, first.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    expect(review.approval.toolName).toBe('a:search');
    const resolved = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: BOB,
      remember: true,
    });
    expect(resolved.remembered).toBe(true);

    const other = await ask(bureau, 'b__search', 'q2', first.contextId);
    const same = await ask(bureau, 'a__search', 'q3', first.contextId);

    expect(pendingOf(bureau, other.id)).toHaveLength(1);
    expect(pendingOf(bureau, same.id)).toHaveLength(0);
    expect(executed).toEqual(['a:q1', 'a:q3']);
  });
});

describe('a namespaced tool the host registered under a bare key (COR-1879)', () => {
  it('applies the toolApproval value of the key the file declared', async () => {
    const { bureau } = await start(
      { lookup: searchIn('a') },
      { tools: '[lookup]', toolApproval: '{ lookup: blocked }' },
    );

    const run = await ask(bureau, 'a__lookup', 'q1');

    expect(pendingOf(bureau, run.id)).toHaveLength(0);
    expect(executed).toEqual([]);
  });
});
