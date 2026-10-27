/**
 * COR-1529 — a chat session run that is in flight across a restart keeps its agent identity, so a
 * workflow tool it calls after the restart still writes a file as that agent instead of answering
 * `invalid-agent`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction } from '@lostgradient/operative';
import { afterEach, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import type { Bureau } from './types';
import { WORKFLOW_TOOL_NAMES } from './workflow-tools';
import type { AgentDefinitions } from './agent-catalog';
import { agentFileDirectory } from './sources/agent-file-directory';
import { workflowFileDirectory } from './sources/workflow-file-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

it('writes the file as the agent after a restart, for a session run that was in flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-tools-recovery-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agents = join(root, 'agents');
  const workflows = join(root, 'workflows');
  await mkdir(agents, { recursive: true });
  await writeFile(
    join(agents, 'scribe.md'),
    agentFileText({
      name: 'scribe',
      model: KNOWN_MODEL,
      tools: `[${WORKFLOW_TOOL_NAMES.join(', ')}]`,
    }),
  );
  const storage = { type: 'sqlite', path: join(root, 'bureau.sqlite') } as const;
  const results: unknown[] = [];

  async function open(generate: GenerateFunction): Promise<Bureau> {
    return createBureau<AgentDefinitions>({
      agents: {},
      agentSource: agentFileDirectory(agents),
      workflowSource: workflowFileDirectory(workflows),
      models: { generate: () => generate },
      storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
      onDiagnostic: () => undefined,
    });
  }

  const stuck = await open(() => new Promise<never>(() => {}));
  const created = await stuck.createRun({ message: 'write it', agentName: 'scribe' });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await stuck.tasks.workflow(created.id)) !== undefined) break;
    await Bun.sleep(5);
  }
  // The first process is left as a crash leaves it: the run is in flight in the store, and nothing
  // cancelled it.
  cleanups.push(() => stuck.dispose());

  const second = await open(async ({ conversation }) => {
    const rows = conversation.getMessages();
    const answered = rows.findLast((row) => row.role === 'tool-result');
    if (answered !== undefined && rows.at(-1) === answered) {
      results.push((answered as { toolResult?: unknown }).toolResult);
      return { content: 'done', toolCalls: [] };
    }
    return {
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'workflows-create',
          arguments: {
            name: 'Digest',
            trigger: { kind: 'schedule', spec: '1h' },
            steps: [
              { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Go' } },
            ],
          },
        },
      ],
    };
  });
  cleanups.push(() => second.dispose());
  await second.waitForRecovery?.();
  await second.tasks.wait(created.id);

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ outcome: 'success', content: { status: 'ok', id: 'digest' } });
  const file = JSON.parse(await readFile(join(workflows, 'digest.json'), 'utf8')) as {
    agent: string;
  };
  expect(file.agent).toBe('scribe');
});
