/**
 * COR-1527 — `bureau.workflows.*` over a real Bureau and its handler: the owner predicate and the
 * operator scopes on every operation (a black-box test with several principals, over the exported
 * list so a later operation is covered without editing it), and each operation's results and
 * typed faults.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createBureau } from '../../create-bureau.ts';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import { BUREAU_HANDLER_OPERATIONS, createBureauHandler } from '../create-bureau-handler.ts';
import { rpc, type RpcBody } from './management-fixtures.test-support.ts';
import { ownerRpc, type Served, serveWorkflows } from './workflows-fixtures.test-support.ts';
import { bureauWorkflowsOperations } from './workflows-operations.ts';
import { createMemoryAssetStorage } from '../../assets/storage';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const serve = (onDiagnostic?: (event: { level: string; message: string }) => void) =>
  serveWorkflows(cleanups, onDiagnostic === undefined ? {} : { onDiagnostic });

/** The array an operation's result holds under `key`, empty when it holds none. */
function listOf(response: RpcBody, key: string): Array<{ id: string }> {
  const value = response.result?.[key];
  return Array.isArray(value) ? (value as Array<{ id: string }>) : [];
}

const DEFINITION = { agent: 'writer', trigger: FAST_SCHEDULE, steps: [AGENT_STEP] };

describe('the operations list', () => {
  it('serves the eleven workflow operations, with their scopes registered', () => {
    expect(bureauWorkflowsOperations.map((operation) => operation.name)).toEqual([
      'bureau.workflows.create',
      'bureau.workflows.update',
      'bureau.workflows.pause',
      'bureau.workflows.resume',
      'bureau.workflows.delete',
      'bureau.workflows.get',
      'bureau.workflows.list',
      'bureau.workflows.revisions',
      'bureau.workflows.runs.list',
      'bureau.workflows.runs.get',
      'bureau.workflows.signal',
    ]);
    expect(BUREAU_SCOPES).toContain('bureau.workflows:read');
    expect(BUREAU_SCOPES).toContain('bureau.workflows:write');
    for (const operation of bureauWorkflowsOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
  });
});

/** The state of the world the operations act on, as the file system and the Bureau see it. */
async function seed(served: Served) {
  const created = await served.bureau.workflows!.create('digest', DEFINITION);
  const run = await served.bureau.durableEngine()!.start('digest', null, { id: 'digest-run' });
  await run.result();
  return created;
}

type Call = {
  readonly method: string;
  readonly params: (hash: string) => unknown;
  readonly scope: 'read' | 'write';
};

const CALLS: readonly Call[] = [
  { method: 'bureau.workflows.get', params: () => ({ id: 'digest' }), scope: 'read' },
  { method: 'bureau.workflows.list', params: () => ({}), scope: 'read' },
  { method: 'bureau.workflows.revisions', params: () => ({ id: 'digest' }), scope: 'read' },
  { method: 'bureau.workflows.runs.list', params: () => ({}), scope: 'read' },
  { method: 'bureau.workflows.runs.get', params: () => ({ runId: 'digest-run' }), scope: 'read' },
  {
    method: 'bureau.workflows.create',
    params: () => ({ id: 'another', definition: DEFINITION }),
    scope: 'write',
  },
  {
    method: 'bureau.workflows.update',
    params: (hash) => ({
      id: 'digest',
      expectedHash: hash,
      definition: { ...DEFINITION, agent: 'editor' },
    }),
    scope: 'write',
  },
  {
    method: 'bureau.workflows.pause',
    params: (hash) => ({ id: 'digest', expectedHash: hash }),
    scope: 'write',
  },
  {
    method: 'bureau.workflows.resume',
    params: (hash) => ({ id: 'digest', expectedHash: hash }),
    scope: 'write',
  },
  {
    method: 'bureau.workflows.delete',
    params: (hash) => ({ id: 'digest', expectedHash: hash }),
    scope: 'write',
  },
  { method: 'bureau.workflows.signal', params: () => ({ name: 'go' }), scope: 'write' },
];

describe('the owner predicate, with several principals', () => {
  it('covers every operation the module exports', () => {
    expect(CALLS.map((call) => call.method).toSorted()).toEqual(
      bureauWorkflowsOperations.map((operation) => operation.name).toSorted(),
    );
  });

  for (const call of CALLS) {
    const wire = call.scope;
    describe(call.method, () => {
      it('answers a caller who owns nothing and holds no scope as if the workflow did not exist, and changes nothing', async () => {
        const served = await serve();
        const { hash } = await seed(served);
        const before = await readFile(join(served.directory, 'digest.json'), 'utf8');
        const response = await rpc(served.keyed, call.method, call.params(hash), 'alice-key');
        if (call.method === 'bureau.workflows.signal') {
          expect(response.error).toBeUndefined();
          expect(response.result).toEqual({ started: [], delivered: [] });
        } else if (
          call.method === 'bureau.workflows.list' ||
          call.method === 'bureau.workflows.runs.list'
        ) {
          expect(response.error).toBeUndefined();
          const key = call.method === 'bureau.workflows.list' ? 'workflows' : 'runs';
          expect(response.result?.[key]).toEqual([]);
        } else if (call.method === 'bureau.workflows.create') {
          expect(response.error?.data?.httpStatus).toBe(403);
        } else {
          expect(response.error?.data?.httpStatus).toBe(404);
        }
        expect(await readFile(join(served.directory, 'digest.json'), 'utf8')).toBe(before);
        expect(served.bureau.workflows?.list().map((entry) => entry.id)).toEqual(['digest']);
      });

      it(`is served to the operator scope for ${wire}, and not to the other scope`, async () => {
        const served = await serve();
        const { hash } = await seed(served);
        const allowedKey = wire === 'read' ? 'workflows-reader-key' : 'workflows-writer-key';
        const deniedKey = wire === 'read' ? 'workflows-writer-key' : 'workflows-reader-key';
        const denied = await rpc(served.keyed, call.method, call.params(hash), deniedKey);
        const deniedStatus = denied.error?.data?.httpStatus;
        const emptyPage =
          denied.result !== undefined &&
          (['workflows', 'runs', 'started'] as const).some(
            (key) => listOf(denied, key).length === 0 && Array.isArray(denied.result?.[key]),
          );
        expect(emptyPage || deniedStatus === 404 || deniedStatus === 403).toBe(true);
        const allowed = await rpc(served.keyed, call.method, call.params(hash), allowedKey);
        expect(allowed.error).toBeUndefined();
        expect(allowed.result).toBeDefined();
      });

      it('is served to the owner of the deployment’s workflows with no scope at all', async () => {
        const served = await serve();
        const { hash } = await seed(served);
        const response = await ownerRpc(served.owner, call.method, call.params(hash));
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
      });

      it('is served to an operator who holds every Bureau scope', async () => {
        const served = await serve();
        const { hash } = await seed(served);
        const response = await rpc(served.keyed, call.method, call.params(hash), 'operator-key');
        expect(response.error).toBeUndefined();
      });
    });
  }
});

describe('results', () => {
  it('creates, reads, lists, and writes the file a person could write by hand', async () => {
    const served = await serve();
    const created = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'digest',
      definition: DEFINITION,
    });
    expect(created.result?.['id']).toBe('digest');
    const text = await readFile(join(served.directory, 'digest.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      name: 'digest',
      agent: 'writer',
      trigger: FAST_SCHEDULE,
    });

    const got = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'digest' });
    expect(got.result).toMatchObject({
      id: 'digest',
      state: 'ready',
      owner: 'anonymous:local',
      hash: created.result?.['hash'],
      agent: 'writer',
      paused: false,
      text,
      problem: null,
      schedule: { id: 'bureau-workflow-schedule:digest:1', status: 'active' },
    });
    const listed = await ownerRpc(served.owner, 'bureau.workflows.list', {});
    expect(listOf(listed, 'workflows').length).toBe(1);
    expect(listed.result?.['nextOffset']).toBeNull();
  });

  it('pages the list with limit and offset', async () => {
    const served = await serve();
    for (const id of ['a-flow', 'b-flow', 'c-flow']) {
      await served.bureau.workflows!.create(id, DEFINITION);
    }
    const first = await ownerRpc(served.owner, 'bureau.workflows.list', { limit: 2 });
    expect(listOf(first, 'workflows').map((entry) => entry.id)).toEqual(['a-flow', 'b-flow']);
    expect(first.result?.['nextOffset']).toBe(2);
    const second = await ownerRpc(served.owner, 'bureau.workflows.list', { limit: 2, offset: 2 });
    expect(listOf(second, 'workflows').length).toBe(1);
    expect(second.result?.['nextOffset']).toBeNull();
  });

  it('lists each file with its description, its trigger, and the counts of its instances', async () => {
    const served = await serve();
    const described = { ...DEFINITION, description: 'Writes the daily digest.' };
    await served.bureau.workflows!.create('digest', described);
    await served.bureau.workflows!.create('bare', DEFINITION);
    const before = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
    const byId = (response: RpcBody, id: string) =>
      listOf(response, 'workflows').find((entry) => entry.id === id) as
        Record<string, unknown> | undefined;
    expect(byId(before, 'digest')).toMatchObject({
      description: 'Writes the daily digest.',
      trigger: FAST_SCHEDULE,
      runs: { active: 0, last24Hours: 0, lastRunAt: null },
    });
    expect(byId(before, 'bare')).toMatchObject({ description: null });

    const run = await served.bureau.durableEngine()!.start('digest', null, { id: 'digest-run' });
    await run.result();
    const after = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
    const counted = byId(after, 'digest')?.['runs'] as {
      active: number;
      last24Hours: number;
      lastRunAt: string | null;
    };
    expect(counted.active).toBe(0);
    expect(counted.last24Hours).toBe(1);
    expect(Number.isNaN(Date.parse(counted.lastRunAt ?? ''))).toBe(false);
    expect(byId(after, 'bare')?.['runs']).toMatchObject({ last24Hours: 0, lastRunAt: null });
  });

  it('counts an instance that has not finished as active, and counts it among the day’s', async () => {
    const served = await serve();
    await served.bureau.workflows!.create('waiting', {
      trigger: FAST_SCHEDULE,
      steps: [{ kind: 'await-signal', signal: 'never-sent' }],
    });
    await served.bureau.durableEngine()!.start('waiting', null, { id: 'waiting-run' });
    const listed = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
    expect(listed.result?.['workflows']).toMatchObject([
      { id: 'waiting', runs: { active: 1, last24Hours: 1 } },
    ]);
  });

  it('still lists every file, with no counts for the one whose engine read fails', async () => {
    const diagnostics: string[] = [];
    const served = await serve((event) => diagnostics.push(`${event.level}: ${event.message}`));
    for (const id of ['a-flow', 'b-flow', 'c-flow']) {
      await served.bureau.workflows!.create(id, DEFINITION);
    }
    const engine = served.bureau.durableEngine()!;
    const original = engine.list.bind(engine);
    const failing = spyOn(engine, 'list').mockImplementation(async (filter, options) => {
      if (filter?.type === 'b-flow') throw new Error('engine unavailable');
      return original(filter, options);
    });
    try {
      const listed = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
      expect(listed.error).toBeUndefined();
      expect(listed.result?.['workflows']).toMatchObject([
        { id: 'a-flow', runs: { active: 0, last24Hours: 0, lastRunAt: null } },
        { id: 'b-flow', state: 'ready', runs: null },
        { id: 'c-flow', runs: { active: 0, last24Hours: 0, lastRunAt: null } },
      ]);
      expect(failing).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
    }
    expect(
      diagnostics.some((line) => line.includes('Could not count') && line.includes('b-flow')),
    ).toBe(true);
  });

  it('widens the window for a quiet workflow, and reads its whole history only as a last resort', async () => {
    const served = await serve();
    await served.bureau.workflows!.create('digest', DEFINITION);
    const engine = served.bureau.durableEngine()!;
    const DAY = 24 * 60 * 60 * 1000;
    const longAgo = Date.now() - 400 * DAY;
    const reads: Array<{ ageInDays: number | null }> = [];
    // The engine's clock is its own, so answer the windowed reads here: nothing in the last day or
    // the last 30 days, and one instance, 400 days old, in the history.
    const stub = spyOn(engine, 'list').mockImplementation(async (filter) => {
      const gte = filter?.createdAt?.gte;
      reads.push({ ageInDays: gte === undefined ? null : Math.round((Date.now() - gte) / DAY) });
      const found = gte === undefined && filter?.status === undefined;
      return {
        items: found ? [{ createdAt: longAgo }] : [],
        total: found ? 1 : 0,
      } as never;
    });
    try {
      const listed = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
      const files = (listed.result?.['workflows'] ?? []) as Array<{ runs: unknown }>;
      const file = files[0];
      expect(file?.runs).toEqual({
        active: 0,
        last24Hours: 0,
        lastRunAt: new Date(longAgo).toISOString(),
      });
    } finally {
      stub.mockRestore();
    }
    // The count of the day, then 30 days, then the whole history; the active read has no window.
    expect(reads.filter((read) => read.ageInDays !== null)).toEqual([
      { ageInDays: 1 },
      { ageInDays: 30 },
    ]);
    expect(reads.filter((read) => read.ageInDays === null).length).toBe(2);
  });

  it('leaves the counts out unless the caller asks for them, because each one reads the engine', async () => {
    const served = await serve();
    await seed(served);
    const listed = await ownerRpc(served.owner, 'bureau.workflows.list', {});
    expect(listed.result?.['workflows']).toMatchObject([
      { id: 'digest', state: 'ready', description: null, runs: null },
    ]);
    const counted = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
    expect(listed.result?.['workflows']).not.toEqual(counted.result?.['workflows']);
    expect(counted.result?.['workflows']).toMatchObject([
      { id: 'digest', runs: { active: 0, last24Hours: 1 } },
    ]);
  });

  it('lists a file that cannot be used with no counts', async () => {
    const served = await serve();
    await writeFile(join(served.directory, 'broken.json'), '{ not json');
    await served.bureau.workflows!.refresh();
    const listed = await ownerRpc(served.owner, 'bureau.workflows.list', { includeRuns: true });
    expect(listed.result?.['workflows']).toMatchObject([
      { id: 'broken', state: 'invalid', description: null, trigger: null, runs: null },
    ]);
  });

  it('keeps the description through a pause and a resume, and replaces it on an update', async () => {
    const served = await serve();
    const created = await served.bureau.workflows!.create('digest', {
      ...DEFINITION,
      description: 'Writes the daily digest.',
    });
    const paused = await ownerRpc(served.owner, 'bureau.workflows.pause', {
      id: 'digest',
      expectedHash: created.hash,
    });
    const resumed = await ownerRpc(served.owner, 'bureau.workflows.resume', {
      id: 'digest',
      expectedHash: paused.result?.['hash'],
    });
    const kept = JSON.parse(await readFile(join(served.directory, 'digest.json'), 'utf8'));
    expect(kept).toMatchObject({ description: 'Writes the daily digest.', paused: false });

    const updated = await ownerRpc(served.owner, 'bureau.workflows.update', {
      id: 'digest',
      expectedHash: resumed.result?.['hash'],
      definition: { ...DEFINITION, description: 'Writes the weekly digest.' },
    });
    expect(updated.error).toBeUndefined();
    const got = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'digest' });
    expect(got.result).toMatchObject({ description: 'Writes the weekly digest.' });
  });

  it('pauses and resumes through the file and the schedule, adds no revision, and deletes', async () => {
    const served = await serve();
    const created = await seed(served);
    const paused = await ownerRpc(served.owner, 'bureau.workflows.pause', {
      id: 'digest',
      expectedHash: created.hash,
    });
    expect(JSON.parse(await readFile(join(served.directory, 'digest.json'), 'utf8')).paused).toBe(
      true,
    );
    const afterPause = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'digest' });
    expect(afterPause.result).toMatchObject({ paused: true, schedule: { status: 'paused' } });
    const resumed = await ownerRpc(served.owner, 'bureau.workflows.resume', {
      id: 'digest',
      expectedHash: paused.result?.['hash'],
    });
    const afterResume = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'digest' });
    expect(afterResume.result).toMatchObject({ paused: false, schedule: { status: 'active' } });
    const revisions = await ownerRpc(served.owner, 'bureau.workflows.revisions', { id: 'digest' });
    expect(listOf(revisions, 'revisions').length).toBe(1);

    const deleted = await ownerRpc(served.owner, 'bureau.workflows.delete', {
      id: 'digest',
      expectedHash: resumed.result?.['hash'],
    });
    expect(deleted.error).toBeUndefined();
    const gone = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'digest' });
    expect(gone.error?.data?.httpStatus).toBe(404);
    const schedule = await served.bureau.getSchedule('bureau-workflow-schedule:digest:1');
    expect(schedule?.status).toBe('cancelled');
    // The revisions that ran are still there.
    const kept = await ownerRpc(served.owner, 'bureau.workflows.revisions', { id: 'digest' });
    expect(listOf(kept, 'revisions').length).toBe(1);
  });

  it('lists the instances and reads one, with its trigger and result', async () => {
    const served = await serve();
    await seed(served);
    const listed = await ownerRpc(served.owner, 'bureau.workflows.runs.list', {
      workflow: 'digest',
    });
    expect(listOf(listed, 'runs').map((run) => run.id)).toEqual(['digest-run']);
    const run = await ownerRpc(served.owner, 'bureau.workflows.runs.get', { runId: 'digest-run' });
    expect(run.result).toMatchObject({
      id: 'digest-run',
      workflow: 'digest',
      status: 'completed',
      error: null,
      result: { content: 'written', output: null, finishReason: 'stop-condition' },
    });
    const none = await ownerRpc(served.owner, 'bureau.workflows.runs.list', {
      workflow: 'unknown-flow',
    });
    expect(none.result?.['runs']).toEqual([]);
  });

  it('answers a run that is not an instance of a workflow file as it answers a missing run', async () => {
    const served = await serve();
    await seed(served);
    const agentRuns = await served.bureau.durableEngine()!.list({ type: 'agentRun' });
    const agentRunId = agentRuns.items[0]?.id;
    expect(agentRunId).toBeDefined();
    const response = await ownerRpc(served.owner, 'bureau.workflows.runs.get', {
      runId: agentRunId,
    });
    expect(response.error?.data?.httpStatus).toBe(404);
  });
});

describe('faults', () => {
  it('Conflict for a taken identifier, with the reason', async () => {
    const served = await serve();
    await seed(served);
    const response = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'digest',
      definition: DEFINITION,
    });
    expect(response.error?.data?.httpStatus).toBe(409);
    expect(response.error?.data).toMatchObject({ reason: 'workflow-file-exists' });
  });

  it('StaleRevision for a stale expectedHash, carrying the hash on disk, and writes nothing', async () => {
    const served = await serve();
    const created = await seed(served);
    await ownerRpc(served.owner, 'bureau.workflows.pause', {
      id: 'digest',
      expectedHash: created.hash,
    });
    const onDisk = await readFile(join(served.directory, 'digest.json'), 'utf8');
    for (const method of ['update', 'pause', 'resume', 'delete'] as const) {
      const response = await ownerRpc(served.owner, `bureau.workflows.${method}`, {
        id: 'digest',
        expectedHash: created.hash,
        ...(method === 'update' ? { definition: DEFINITION } : {}),
      });
      expect(response.error?.data?.httpStatus, method).toBe(409);
      expect(response.error?.data?.['expectedRevision'], method).toBe(created.hash);
      expect(typeof response.error?.data?.['currentRevision'], method).toBe('string');
    }
    expect(await readFile(join(served.directory, 'digest.json'), 'utf8')).toBe(onDisk);
  });

  it('Unprocessable for a document that would not load, with the problem, and writes nothing', async () => {
    const served = await serve();
    const response = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'broken',
      definition: { trigger: { kind: 'signal' }, steps: [AGENT_STEP] },
    });
    expect(response.error?.data?.httpStatus).toBe(422);
    expect(response.error?.data).toMatchObject({ reason: 'invalid-document' });
    expect(served.bureau.workflows?.list()).toEqual([]);
  });

  it('Unprocessable for a description that is empty or too long for a list row, and writes nothing', async () => {
    const served = await serve();
    for (const description of ['   ', 'x'.repeat(281)]) {
      const response = await ownerRpc(served.owner, 'bureau.workflows.create', {
        id: 'described',
        definition: { ...DEFINITION, description },
      });
      expect(response.error?.data?.httpStatus).toBe(422);
      expect(response.error?.data).toMatchObject({ reason: 'invalid-document' });
    }
    expect(served.bureau.workflows?.list()).toEqual([]);
  });

  it('InvalidParams for an identifier that is not valid, and for a key the operation does not declare', async () => {
    const served = await serve();
    const bad = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'Bad_Name',
      definition: DEFINITION,
    });
    expect(bad.error?.data?.httpStatus).toBe(400);
    const extra = await ownerRpc(served.owner, 'bureau.workflows.get', {
      id: 'digest',
      owner: 'me',
    });
    expect(extra.error?.data?.httpStatus).toBe(400);
  });

  it('InvalidParams naming the key for a definition with an undeclared key, and writes nothing (create)', async () => {
    const served = await serve();
    const response = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'digest',
      definition: { ...DEFINITION, retries: 3 },
    });
    expect(response.error?.data?.httpStatus).toBe(400);
    expect(response.error?.data?.['weftCode']).toBe('InvalidParams');
    expect(response.error?.data?.['issues']).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        path: ['definition'],
        message: expect.stringContaining('"retries"'),
      }),
    );
    expect(await Bun.file(join(served.directory, 'digest.json')).exists()).toBe(false);
    expect(served.bureau.workflows?.list()).toEqual([]);
  });

  it('InvalidParams naming the key for a definition with an undeclared key, and leaves the file as it was (update)', async () => {
    const served = await serve();
    const created = await seed(served);
    const before = await readFile(join(served.directory, 'digest.json'));
    const response = await ownerRpc(served.owner, 'bureau.workflows.update', {
      id: 'digest',
      expectedHash: created.hash,
      definition: { ...DEFINITION, retries: 3 },
    });
    expect(response.error?.data?.httpStatus).toBe(400);
    expect(response.error?.data?.['weftCode']).toBe('InvalidParams');
    expect(response.error?.data?.['issues']).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        path: ['definition'],
        message: expect.stringContaining('"retries"'),
      }),
    );
    const after = await readFile(join(served.directory, 'digest.json'));
    expect(after.equals(before)).toBe(true);
  });

  it('leaves a trigger loose, so the trigger kind’s own validator refuses its unknown keys', async () => {
    const served = await serve();
    const response = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'digest',
      definition: { ...DEFINITION, trigger: { kind: 'schedule', spec: '1h', extra: 1 } },
    });
    expect(response.error?.data?.httpStatus).toBe(422);
    expect(response.error?.data).toMatchObject({
      weftCode: 'Unprocessable',
      reason: 'invalid-document',
    });
    // The refusal names the unknown key: a stripped trigger would lose `spec` with it and be refused
    // for that instead.
    expect(response.error?.message).toContain('extra');
    expect(await Bun.file(join(served.directory, 'digest.json')).exists()).toBe(false);
    expect(served.bureau.workflows?.list()).toEqual([]);
  });

  it('Unavailable for a write whose effect on the engine failed, which the next rescan applies', async () => {
    const diagnostics: string[] = [];
    const served = await serve((event) => diagnostics.push(event.message));
    const created = await seed(served);
    const engine = served.bureau.durableEngine()!;
    const original = engine.pauseSchedule.bind(engine);
    // The file watcher's own apply can reach the engine before the operation's does, so a single
    // injected failure may be spent on it. Keep failing until the operation's response has
    // arrived, then let the next rescan succeed.
    let failing = true;
    engine.pauseSchedule = async (...args: Parameters<typeof original>) => {
      if (failing) throw new Error('storage unavailable');
      return original(...args);
    };

    const response = await ownerRpc(served.owner, 'bureau.workflows.pause', {
      id: 'digest',
      expectedHash: created.hash,
    });

    expect(response.error?.data?.httpStatus).toBe(503);
    expect(response.error?.data).toMatchObject({ reason: 'workflow-apply-failed' });
    expect(response.error?.message).toContain('storage unavailable');
    // A persistent failure may be diagnosed by more than one apply (the operation's and the watcher's).
    expect(
      diagnostics.filter((message) => message.includes('Could not bring')).length,
    ).toBeGreaterThanOrEqual(1);
    failing = false;
    // The file changed, so the write is in the audit trail even though its apply failed.
    const audited = await served.bureau.auditTrail?.query({ runId: 'workflow:digest' });
    expect(audited?.map((entry) => entry.type)).toEqual(['workflow.created', 'workflow.paused']);
    await served.bureau.workflows?.refresh();
    const got = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'digest' });
    expect(got.result).toMatchObject({ paused: true, schedule: { status: 'paused' } });
  });

  it('NotFound for an update of a file that is gone', async () => {
    const served = await serve();
    const response = await ownerRpc(served.owner, 'bureau.workflows.update', {
      id: 'nobody',
      expectedHash: 'abc',
      definition: DEFINITION,
    });
    expect(response.error?.data?.httpStatus).toBe(404);
  });

  it('UnsupportedCapability on a Bureau with no workflow directory', async () => {
    const bureau = await createBureau({
      assets: { storage: createMemoryAssetStorage() },
      id: 'no-workflows',
      agents: {},
      storage: { type: 'memory' },
      durableExecution: true,
    });
    cleanups.push(() => bureau.dispose());
    const handler = createBureauHandler(bureau, {
      unauthenticatedAccess: 'allow',
    });
    const response = await ownerRpc(handler, 'bureau.workflows.list', {});
    expect(response.error?.data?.httpStatus).toBe(501);
  });
});
