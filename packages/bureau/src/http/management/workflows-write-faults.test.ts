import { afterEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { nodeAgentFileOperations } from '../../sources/agent-file-operations.ts';
import { workflowFileDirectory } from '../../sources/workflow-file-directory.ts';
import { ownerRpc, serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
const definition = {
  trigger: { kind: 'manual' },
  steps: [{ kind: 'sleep', duration: '15m' }],
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('workflow writes refused by the file system', () => {
  test('create names the file without exposing the host path or leaving a workflow', async () => {
    const served = await serveWorkflows(cleanups, {
      workflowFileOperations: {
        ...nodeAgentFileOperations,
        writeTemporary: async (path) => {
          throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
        },
      },
    });
    const answer = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'morning-briefing',
      definition,
    });

    expect(answer.error?.message).toBe(
      'morning-briefing.json couldn’t be written: permission denied.',
    );
    expect(answer.error?.data).toMatchObject({
      httpStatus: 422,
      reason: 'workflow-file-write-denied',
    });
    expect(await readdir(served.directory)).toEqual([]);
    expect(served.bureau.workflows?.list()).toEqual([]);
  });

  test('a create in the default workflow directory can name its home-relative location', async () => {
    const source = workflowFileDirectory(join(homedir(), '.interborough', 'workflows'), {
      operations: {
        ...nodeAgentFileOperations,
        read: async () => undefined,
        makeDirectory: async () => undefined,
        writeTemporary: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      },
    });
    let failure: unknown;
    try {
      await source.write('morning-briefing', new Uint8Array(), { expectedHash: null });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message:
        '~/.interborough/workflows/morning-briefing.json couldn’t be written: permission denied.',
    });
  });

  test('update keeps the prior file and hash when publishing it is denied', async () => {
    let denyRename = false;
    const served = await serveWorkflows(cleanups, {
      workflowFileOperations: {
        ...nodeAgentFileOperations,
        rename: async (from, to) => {
          if (denyRename) throw Object.assign(new Error(`EPERM: ${to}`), { code: 'EPERM' });
          await nodeAgentFileOperations.rename(from, to);
        },
      },
    });
    const created = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'release-notes',
      definition,
    });
    expect(created.error).toBeUndefined();
    const { hash } = created.result as { hash: string };
    const file = join(served.directory, 'release-notes.json');
    const previous = await readFile(file, 'utf8');
    denyRename = true;

    const answer = await ownerRpc(served.owner, 'bureau.workflows.update', {
      id: 'release-notes',
      expectedHash: hash,
      definition: { ...definition, title: 'Release notes' },
    });

    expect(answer.error?.message).toBe(
      'release-notes.json couldn’t be written: permission denied.',
    );
    expect(answer.error?.data).toMatchObject({
      httpStatus: 422,
      reason: 'workflow-file-write-denied',
    });
    expect(await readdir(served.directory)).toEqual(['release-notes.json']);
    expect(await readFile(file, 'utf8')).toBe(previous);
    expect(served.bureau.workflows?.list()[0]?.hash).toBe(hash);
  });
});
