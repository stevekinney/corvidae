/**
 * COR-1527 — workflow files are written with the agent files' rules: a temporary file renamed into
 * place, a typed conflict when the file exists or has changed since it was read, and nothing
 * written when the result would not load.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { type AgentFileOperations, nodeAgentFileOperations } from './agent-file-operations';
import {
  AGENT_STEP,
  createWorkflowFileFixture,
  FAST_SCHEDULE,
  type WorkflowFileFixture,
  workflowFileText,
} from './testing/workflow-file-fixtures.test-support';
import {
  hashWorkflowFileBytes,
  WorkflowFileConflictError,
  WorkflowFileError,
} from './workflow-file';

const fixtures: WorkflowFileFixture[] = [];

async function start(options?: Parameters<typeof createWorkflowFileFixture>[0]) {
  const fixture = await createWorkflowFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject.');
}

const definition = { agent: 'writer', trigger: FAST_SCHEDULE, steps: [AGENT_STEP] };

describe('create', () => {
  it('writes through a temporary dotfile in the same directory, renamed into place', async () => {
    const calls: string[] = [];
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      writeTemporary: (path, bytes) => {
        calls.push(`write ${path}`);
        return nodeAgentFileOperations.writeTemporary(path, bytes);
      },
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        return nodeAgentFileOperations.rename(from, to);
      },
    };
    const fixture = await start({ operations });
    const { hash } = await fixture.catalog.create('digest', definition);

    const temporary = calls[0]?.slice('write '.length) ?? '';
    expect(calls).toHaveLength(2);
    expect(temporary.startsWith(join(fixture.directory, '.digest.json.'))).toBe(true);
    expect(temporary.endsWith('.tmp')).toBe(true);
    expect(calls[1]).toBe(`rename ${temporary} -> ${join(fixture.directory, 'digest.json')}`);
    const bytes = new Uint8Array(await readFile(join(fixture.directory, 'digest.json')));
    expect(hashWorkflowFileBytes(bytes)).toBe(hash);
    expect(await readdir(fixture.directory)).toEqual(['digest.json']);
    expect(fixture.catalog.find('digest')?.agent).toBe('writer');
  });

  it('leaves no half-written file when the rename fails', async () => {
    const fixture = await start({
      operations: {
        ...nodeAgentFileOperations,
        rename: async () => {
          throw new Error('disk full');
        },
      },
    });
    const error = await rejection(fixture.catalog.create('digest', definition));
    expect((error as Error).message).toBe('disk full');
    expect(await readdir(fixture.directory)).toEqual([]);
    expect(fixture.catalog.list()).toEqual([]);
  });

  it('fails with a typed conflict when the identifier is taken, and writes nothing', async () => {
    const fixture = await start();
    await fixture.put('digest.json', workflowFileText('digest'));
    const before = await readFile(join(fixture.directory, 'digest.json'), 'utf8');
    const error = await rejection(fixture.catalog.create('digest', definition));
    expect(error).toBeInstanceOf(WorkflowFileConflictError);
    expect((error as WorkflowFileConflictError).code).toBe('workflow-file-exists');
    expect((error as WorkflowFileConflictError).currentHash).toBe(
      hashWorkflowFileBytes(new TextEncoder().encode(before)),
    );
    expect(await readFile(join(fixture.directory, 'digest.json'), 'utf8')).toBe(before);
    expect(await readdir(fixture.directory)).toEqual(['digest.json']);
  });

  it('refuses a result that would not load, with the problem, and writes nothing', async () => {
    const fixture = await start();
    const bad = await rejection(
      fixture.catalog.create('digest', {
        trigger: { kind: 'schedule', spec: 'nonsense' },
        steps: [AGENT_STEP],
      }),
    );
    expect(bad).toBeInstanceOf(WorkflowFileError);
    expect((bad as WorkflowFileError).code).toBe('invalid-document');
    const badIdentifier = await rejection(fixture.catalog.create('Bad_Name', definition));
    expect((badIdentifier as WorkflowFileError).code).toBe('invalid-identifier');
    const shadow = await rejection(fixture.catalog.create('code-workflow', definition));
    expect((shadow as WorkflowFileError).code).toBe('shadows-code-workflow');
    expect(await readdir(fixture.directory)).toEqual([]);
  });

  it('makes the workflow visible without a restart', async () => {
    const fixture = await start();
    await fixture.catalog.create('digest', definition);
    expect(fixture.catalog.list().map((entry) => entry.id)).toEqual(['digest']);
  });
});

describe('update', () => {
  it('replaces the file, keeping the name equal to the identifier', async () => {
    const fixture = await start();
    const created = await fixture.catalog.create('digest', definition);
    const updated = await fixture.catalog.update(
      'digest',
      { ...definition, steps: [{ kind: 'sleep', duration: 1 }] },
      { expectedHash: created.hash },
    );
    expect(updated.hash).not.toBe(created.hash);
    const written = JSON.parse(await readFile(join(fixture.directory, 'digest.json'), 'utf8'));
    expect(written.name).toBe('digest');
    expect(written.steps).toEqual([{ kind: 'sleep', duration: 1 }]);
  });

  it('writes nothing for an update that changes nothing', async () => {
    const calls: string[] = [];
    const fixture = await start({
      operations: {
        ...nodeAgentFileOperations,
        writeTemporary: (path, bytes) => {
          calls.push(path);
          return nodeAgentFileOperations.writeTemporary(path, bytes);
        },
      },
    });
    const created = await fixture.catalog.create('digest', definition);
    const same = await fixture.catalog.update('digest', definition, { expectedHash: created.hash });
    expect(same.hash).toBe(created.hash);
    expect(calls).toHaveLength(1);
  });

  it('fails with a typed conflict carrying currentHash on a stale expectedHash, and writes nothing', async () => {
    const fixture = await start();
    const created = await fixture.catalog.create('digest', definition);
    await writeFile(
      join(fixture.directory, 'digest.json'),
      workflowFileText('digest', { agent: 'other' }),
    );
    const currentHash = hashWorkflowFileBytes(
      new Uint8Array(await readFile(join(fixture.directory, 'digest.json'))),
    );
    const error = await rejection(
      fixture.catalog.update(
        'digest',
        { ...definition, agent: 'third' },
        {
          expectedHash: created.hash,
        },
      ),
    );
    expect(error).toBeInstanceOf(WorkflowFileConflictError);
    expect((error as WorkflowFileConflictError).code).toBe('workflow-file-changed');
    expect((error as WorkflowFileConflictError).currentHash).toBe(currentHash);
    expect(JSON.parse(await readFile(join(fixture.directory, 'digest.json'), 'utf8')).agent).toBe(
      'other',
    );
    expect(await readdir(fixture.directory)).toEqual(['digest.json']);
  });

  it('fails not-found for a file that is gone', async () => {
    const fixture = await start();
    const error = await rejection(
      fixture.catalog.update('digest', definition, { expectedHash: 'abc' }),
    );
    expect((error as WorkflowFileError).code).toBe('workflow-file-not-found');
  });

  it('refuses a replacement that would not load and keeps the file', async () => {
    const fixture = await start();
    const created = await fixture.catalog.create('digest', definition);
    const error = await rejection(
      fixture.catalog.update(
        'digest',
        { ...definition, steps: [] },
        { expectedHash: created.hash },
      ),
    );
    expect((error as WorkflowFileError).code).toBe('invalid-document');
    expect(
      hashWorkflowFileBytes(new Uint8Array(await readFile(join(fixture.directory, 'digest.json')))),
    ).toBe(created.hash);
  });
});

describe('pause and resume', () => {
  it('set paused in the file, keep the rest, and are no-ops when the value is already there', async () => {
    const writes: string[] = [];
    const fixture = await start({
      operations: {
        ...nodeAgentFileOperations,
        writeTemporary: (path, bytes) => {
          writes.push(path);
          return nodeAgentFileOperations.writeTemporary(path, bytes);
        },
      },
    });
    const created = await fixture.catalog.create('digest', definition);
    // Resuming a workflow that is not paused writes nothing.
    const untouched = await fixture.catalog.setPaused('digest', false, {
      expectedHash: created.hash,
    });
    expect(untouched.hash).toBe(created.hash);
    expect(writes).toHaveLength(1);

    const paused = await fixture.catalog.setPaused('digest', true, { expectedHash: created.hash });
    expect(paused.hash).not.toBe(created.hash);
    const written = JSON.parse(await readFile(join(fixture.directory, 'digest.json'), 'utf8'));
    expect(written).toMatchObject({ name: 'digest', agent: 'writer', paused: true });
    expect(fixture.catalog.list()[0]?.paused).toBe(true);

    const again = await fixture.catalog.setPaused('digest', true, { expectedHash: paused.hash });
    expect(again.hash).toBe(paused.hash);

    const resumed = await fixture.catalog.setPaused('digest', false, { expectedHash: paused.hash });
    expect(JSON.parse(await readFile(join(fixture.directory, 'digest.json'), 'utf8')).paused).toBe(
      false,
    );
    expect(fixture.catalog.list()[0]?.paused).toBe(false);
    expect(resumed.hash).not.toBe(paused.hash);
  });

  it('fail with a typed conflict on a stale expectedHash', async () => {
    const fixture = await start();
    const created = await fixture.catalog.create('digest', definition);
    await fixture.catalog.setPaused('digest', true, { expectedHash: created.hash });
    const error = await rejection(
      fixture.catalog.setPaused('digest', false, { expectedHash: created.hash }),
    );
    expect((error as WorkflowFileConflictError).code).toBe('workflow-file-changed');
    expect(typeof (error as WorkflowFileConflictError).currentHash).toBe('string');
  });

  it('refuse a file that is not a usable workflow file', async () => {
    const fixture = await start();
    await fixture.put('digest.json', '{');
    const hash = hashWorkflowFileBytes(new TextEncoder().encode('{'));
    const error = await rejection(
      fixture.catalog.setPaused('digest', true, { expectedHash: hash }),
    );
    expect((error as WorkflowFileError).code).toBe('invalid-document');
  });
});

describe('delete', () => {
  it('removes the file, and a stale expectedHash is a conflict that removes nothing', async () => {
    const fixture = await start();
    const created = await fixture.catalog.create('digest', definition);
    const stale = await rejection(
      fixture.catalog.delete('digest', { expectedHash: 'f'.repeat(64) }),
    );
    expect((stale as WorkflowFileConflictError).code).toBe('workflow-file-changed');
    expect(fixture.catalog.find('digest')).toBeDefined();
    await fixture.catalog.delete('digest', { expectedHash: created.hash });
    expect(await readdir(fixture.directory)).toEqual([]);
    expect(fixture.catalog.list()).toEqual([]);
  });
});

describe('read', () => {
  it('returns the text and hash, undefined for a missing file, and refuses a bad identifier', async () => {
    const fixture = await start();
    expect(await fixture.catalog.read('digest')).toBeUndefined();
    const created = await fixture.catalog.create('digest', definition);
    const read = await fixture.catalog.read('digest');
    expect(read?.hash).toBe(created.hash);
    expect(JSON.parse(read?.text ?? '').name).toBe('digest');
    expect(((await rejection(fixture.catalog.read('Bad_Name'))) as WorkflowFileError).code).toBe(
      'invalid-identifier',
    );
  });
});
