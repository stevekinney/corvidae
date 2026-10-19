/**
 * COR-1527 — a file that cannot be used is listed `invalid` with a typed code, is never handed to
 * the engine, and leaves every other workflow working.
 */
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { nodeAgentFileOperations } from './agent-file-operations';
import {
  createWorkflowFileFixture,
  type WorkflowFileFixture,
  workflowFileText,
} from './testing/workflow-file-fixtures.test-support';
import { WORKFLOW_FILE_SIZE_LIMIT } from './workflow-file';

const fixtures: WorkflowFileFixture[] = [];

async function start(options?: Parameters<typeof createWorkflowFileFixture>[0]) {
  const fixture = await createWorkflowFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function listing(fixture: WorkflowFileFixture, id: string) {
  return fixture.catalog.list().find((entry) => entry.id === id);
}

describe('loading the workflow directory', () => {
  it('lists a valid file as ready, owned by the deployment owner, with its version and hash', async () => {
    const fixture = await start();
    await fixture.put('digest.json', workflowFileText('digest', { agent: 'writer' }));
    await fixture.catalog.refresh();

    const entry = listing(fixture, 'digest');
    expect(entry).toMatchObject({
      id: 'digest',
      state: 'ready',
      owner: 'anonymous:local',
      agent: 'writer',
      paused: false,
    });
    expect(entry?.version).toStartWith('sha256:');
    expect(entry?.hash).toHaveLength(64);
    expect(fixture.catalog.find('digest')?.document.name).toBe('digest');
  });

  it('ignores dotfiles, other extensions, upper-case extensions, and directories', async () => {
    const fixture = await start();
    await fixture.put('.hidden.json', workflowFileText('hidden'));
    await fixture.put('notes.txt', 'x');
    await fixture.put('upper.JSON', workflowFileText('upper'));
    await mkdir(join(fixture.directory, 'folder.json'));
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()).toEqual([]);
  });

  it('follows a symbolic link to a file', async () => {
    const fixture = await start({ subdirectory: 'workflows' });
    await mkdir(fixture.directory, { recursive: true });
    await fixture.put('real.txt', workflowFileText('linked'));
    await symlink(join(fixture.directory, 'real.txt'), join(fixture.directory, 'linked.json'));
    await fixture.catalog.refresh();
    expect(listing(fixture, 'linked')?.state).toBe('ready');
  });

  it('treats a directory that does not exist as an empty catalog', async () => {
    const fixture = await start({ subdirectory: 'not-yet' });
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()).toEqual([]);
  });
});

describe('an invalid file', () => {
  it('invalid-identifier: the filename breaks the identifier pattern', async () => {
    const fixture = await start();
    await fixture.put('1st.json', workflowFileText('1st'));
    await fixture.put('Bad_Name.json', workflowFileText('Bad_Name'));
    await fixture.put(`${'a'.repeat(65)}.json`, workflowFileText('a'.repeat(65)));
    await fixture.catalog.refresh();
    for (const id of ['1st', 'Bad_Name', 'a'.repeat(65)]) {
      expect(listing(fixture, id)).toMatchObject({
        state: 'invalid',
        problem: { code: 'invalid-identifier' },
      });
      expect(fixture.catalog.find(id)).toBeUndefined();
    }
  });

  it('invalid-json: the text is not a JSON object', async () => {
    const fixture = await start();
    await fixture.put('broken.json', '{ "name": ');
    await fixture.put('array.json', '[]');
    await fixture.catalog.refresh();
    expect(listing(fixture, 'broken')?.problem?.code).toBe('invalid-json');
    expect(listing(fixture, 'array')?.problem?.code).toBe('invalid-json');
  });

  it('invalid-document: a name that is not the identifier, an unknown key, bad agent or paused, another trigger kind', async () => {
    const fixture = await start();
    await fixture.put('renamed.json', workflowFileText('other'));
    await fixture.put('extra.json', workflowFileText('extra', { owner: 'me' }));
    await fixture.put('agentless.json', workflowFileText('agentless', { agent: 7 }));
    await fixture.put('pausey.json', workflowFileText('pausey', { paused: 'no' }));
    await fixture.put(
      'signalled.json',
      workflowFileText('signalled', { trigger: { kind: 'signal' } }),
    );
    await fixture.catalog.refresh();
    for (const id of ['renamed', 'extra', 'agentless', 'pausey', 'signalled']) {
      expect(listing(fixture, id)).toMatchObject({
        state: 'invalid',
        problem: { code: 'invalid-document' },
      });
      expect(listing(fixture, id)?.problem?.issues?.length).toBeGreaterThan(0);
    }
  });

  it('shadows-code-workflow: the identifier is a workflow the engine has from code', async () => {
    const fixture = await start({ codeWorkflows: ['code-workflow'] });
    await fixture.put('code-workflow.json', workflowFileText('code-workflow'));
    await fixture.catalog.refresh();
    expect(listing(fixture, 'code-workflow')?.problem?.code).toBe('shadows-code-workflow');
    expect(fixture.catalog.find('code-workflow')).toBeUndefined();
  });

  it('file-too-large: the file is over the limit and is not read', async () => {
    const reads: string[] = [];
    const fixture = await start({
      operations: {
        ...nodeAgentFileOperations,
        read: (path) => {
          reads.push(path);
          return nodeAgentFileOperations.read(path);
        },
      },
    });
    await fixture.put('huge.json', 'x'.repeat(WORKFLOW_FILE_SIZE_LIMIT + 1));
    await fixture.catalog.refresh();
    expect(listing(fixture, 'huge')?.problem?.code).toBe('file-too-large');
    expect(listing(fixture, 'huge')?.hash).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('not-utf8: the bytes are not valid UTF-8', async () => {
    const fixture = await start();
    await fixture.put('bytes.json', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    await fixture.catalog.refresh();
    expect(listing(fixture, 'bytes')?.problem?.code).toBe('not-utf8');
    expect(listing(fixture, 'bytes')?.hash).toHaveLength(64);
  });

  it('unreadable: the file cannot be read', async () => {
    const fixture = await start({
      operations: {
        ...nodeAgentFileOperations,
        read: async (path) => {
          if (path.endsWith('locked.json')) throw new Error('EACCES: permission denied');
          return nodeAgentFileOperations.read(path);
        },
      },
    });
    await fixture.put('locked.json', workflowFileText('locked'));
    await fixture.put('fine.json', workflowFileText('fine'));
    await fixture.catalog.refresh();
    expect(listing(fixture, 'locked')?.problem?.code).toBe('unreadable');
    expect(listing(fixture, 'locked')?.problem?.message).toContain('EACCES');
    expect(listing(fixture, 'fine')?.state).toBe('ready');
  });

  it('never affects another workflow', async () => {
    const fixture = await start();
    await fixture.put('good.json', workflowFileText('good'));
    await fixture.put('bad.json', '{');
    await fixture.catalog.refresh();
    expect(fixture.catalog.find('good')?.id).toBe('good');
    expect(fixture.catalog.find('bad')).toBeUndefined();
    expect(fixture.catalog.list().map((entry) => entry.state)).toEqual(['invalid', 'ready']);
  });
});
