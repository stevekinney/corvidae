import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEncryptionKey } from '@lostgradient/cryptography';
import type { Storage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSqliteStorageFixture } from '../../test/storage-fixtures.ts';
import {
  type AgentFileOperations,
  nodeAgentFileOperations,
} from '../../sources/agent-file-operations.ts';
import { agentFileDirectory } from '../../sources/agent-file-directory.ts';
import { workflowFileDirectory } from '../../sources/workflow-file-directory.ts';
import { lookupTool } from '../../testing/agent-file-fixtures.test-support.ts';

import { callAs, disposeServed, seed, serve } from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

function interruptCompletionOnce(storage: Storage): Storage {
  let interrupted = false;
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'conditionalBatch' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<NonNullable<Storage['conditionalBatch']>>) => {
        const [, operations] = args;
        if (
          !interrupted &&
          operations.some(
            (operation: { readonly type: string; readonly key: string }) =>
              operation.type === 'put' &&
              operation.key.startsWith('bureau-agent-id-rename-complete:v1:'),
          )
        ) {
          interrupted = true;
          throw new Error('simulated completion receipt interruption');
        }
        return value.call(target, ...args);
      };
    },
  });
}

describe('bureau.agents.definitions.rename', () => {
  it('changes a saved agent through the normal authorized endpoint', async () => {
    const served = await serve();
    await seed(served);

    const renamed = await callAs(served.local, 'bureau.agents.definitions.rename', {
      id: 'researcher',
      to: 'investigator',
      expectedHash: served.hashOf('researcher'),
    });

    expect(renamed.error).toBeUndefined();
    expect(renamed.result).toMatchObject({
      from: 'researcher',
      to: 'investigator',
      phase: 'cutover',
    });
    const source = await callAs(served.local, 'bureau.agents.definitions.get', {
      id: 'researcher',
    });
    const target = await callAs(served.local, 'bureau.agents.definitions.get', {
      id: 'investigator',
    });
    expect(source.error).toMatchObject({ data: { weftCode: 'NotFound' } });
    expect(target.result).toMatchObject({ id: 'investigator' });
  });

  it('resumes one durable rename after restart without duplicating its agent or losing its live references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-saved-agent-rename-'));
    const storage = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    let failRetirement = true;
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      async remove(path) {
        if (failRetirement && path.endsWith('/researcher.md')) {
          failRetirement = false;
          throw new Error('simulated source retirement interruption');
        }
        await nodeAgentFileOperations.remove(path);
      },
    };
    const agentDirectory = join(root, 'agents');
    const workflowDirectory = join(root, 'workflows');
    await mkdir(agentDirectory, { recursive: true });
    const open = async (store: typeof storage.storage) =>
      serve({
        directory: agentDirectory,
        overrides: {
          storage: store,
          durableOwnership: { ownership: 'none' },
          agentSource: agentFileDirectory(agentDirectory, {
            tools: { 'lookup-order': lookupTool },
            operations,
          }),
          workflowSource: workflowFileDirectory(workflowDirectory),
          hooks: {},
          answerEncryption: { current: await generateEncryptionKey() },
        },
      });

    try {
      const first = await open(storage.storage);
      await seed(first);
      const before = first.hashOf('researcher');
      const historical = await first.bureau.tasks.start('researcher', 'Remember this history.');
      await historical.result();
      const historicalSession = await first.bureau.contexts.get(historical.contextId);
      const schedule = await first.bureau.schedules.create({
        agentName: 'researcher',
        input: 'Continue the retained chat.',
        spec: '1h',
        sessionId: historical.contextId,
      });
      const workflow = await first.bureau.workflows?.create('research-digest', {
        agent: 'researcher',
        trigger: { kind: 'manual' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'researcher', message: 'Summarize the research.' },
          },
        ],
      });
      const hook = await first.bureau.hooks?.create({
        name: 'Research settled',
        action: { type: 'notify' },
        events: ['run.settled'],
        scope: { kind: 'agent', id: 'researcher' },
      });
      expect(schedule).toBeDefined();
      expect(workflow).toBeDefined();
      expect(hook).toBeDefined();
      expect(historicalSession).toMatchObject({ agentName: 'researcher' });

      const interrupted = await callAs(first.local, 'bureau.agents.definitions.rename', {
        id: 'researcher',
        to: 'investigator',
        expectedHash: before,
      });
      expect(interrupted.error?.message).toBe('internal error');
      await first.dispose();

      const second = await open(await storage.reopen());
      const resumed = await callAs(second.local, 'bureau.agents.definitions.rename', {
        id: 'researcher',
        to: 'investigator',
        expectedHash: before,
      });
      expect(resumed.error).toBeUndefined();
      expect(resumed.result).toMatchObject({
        from: 'researcher',
        to: 'investigator',
        phase: 'cutover',
      });
      expect(
        second.bureau.agents
          .list()
          .filter(({ id }) => id === 'researcher' || id === 'investigator'),
      ).toEqual([expect.objectContaining({ id: 'investigator' })]);
      expect(await second.bureau.schedules.agentName(schedule!.id)).toBe('investigator');
      expect(await second.bureau.schedules.continuesChat(schedule!.id)).toBe(true);
      expect(await second.bureau.contexts.get(historical.contextId)).toMatchObject({
        agentName: 'researcher',
        incarnation: historicalSession?.incarnation,
      });
      expect(await second.bureau.workflows?.get('research-digest')).toMatchObject({
        agent: 'investigator',
        document: expect.objectContaining({
          steps: [
            expect.objectContaining({ input: expect.objectContaining({ agent: 'investigator' }) }),
          ],
        }),
      });
      expect(await second.bureau.hooks?.get(hook!.id)).toMatchObject({
        scope: { kind: 'agent', id: 'investigator' },
      });
      await second.dispose();
    } finally {
      await disposeServed();
      await storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays a retired source through the normal endpoint before its completion receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-retired-rename-replay-'));
    const storage = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    const directory = join(root, 'agents');
    await mkdir(directory, { recursive: true });
    const open = async (store: Storage) =>
      serve({
        directory,
        overrides: {
          storage: store,
          durableOwnership: { ownership: 'none' },
        },
      });

    try {
      const first = await open(interruptCompletionOnce(storage.storage));
      await seed(first);
      const expectedHash = first.hashOf('researcher');
      const interrupted = await callAs(first.local, 'bureau.agents.definitions.rename', {
        id: 'researcher',
        to: 'investigator',
        expectedHash,
      });
      expect(interrupted.error?.message).toBe('internal error');
      const source = await callAs(first.local, 'bureau.agents.definitions.get', {
        id: 'researcher',
      });
      expect(source.error).toMatchObject({ data: { weftCode: 'NotFound' } });
      await first.dispose();

      const second = await open(await storage.reopen());
      const replay = await callAs(second.local, 'bureau.agents.definitions.rename', {
        id: 'researcher',
        to: 'investigator',
        expectedHash,
      });
      expect(replay.error).toBeUndefined();
      expect(replay.result).toMatchObject({
        from: 'researcher',
        to: 'investigator',
        phase: 'cutover',
      });
      const duplicate = await callAs(second.local, 'bureau.agents.definitions.rename', {
        id: 'researcher',
        to: 'investigator',
        expectedHash,
      });
      expect(duplicate).toEqual(replay);
      expect(
        second.bureau.agents
          .list()
          .filter(({ id }) => id === 'researcher' || id === 'investigator'),
      ).toEqual([expect.objectContaining({ id: 'investigator' })]);
      await second.dispose();
    } finally {
      await disposeServed();
      await storage.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
