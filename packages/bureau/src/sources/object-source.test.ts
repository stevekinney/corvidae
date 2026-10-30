/**
 * COR-1762 — the S3 definition sources beyond the shared contract suite: what a listing counts as
 * a definition, how scans follow continuations and avoid re-reading, how conditional writes and
 * deletes resolve refusals, and how the poll runs on the injected runtime. Every case runs against
 * the in-process S3 server in `@lostgradient/testing`.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_FILE_SIZE_LIMIT } from '../agent-file';
import { agentObjectSource } from './agent-object-source';
import {
  type AgentSource,
  type DefinitionSource,
  type DefinitionSourceChange,
  hashDefinitionBytes,
  SourceConflictError,
} from './definition-source';
import * as sources from './index';
import { createS3ObjectOperations, type ObjectStoreOperations } from './object-operations';
import { workflowObjectSource } from './workflow-object-source';

const encoder = new TextEncoder();
const hashOf = (text: string): string => hashDefinitionBytes(encoder.encode(text));
const PREFIX = 'definitions/';
const POLL = 50;

interface Calls {
  lists: number;
  reads: string[];
  puts: number;
  removes: number;
}

interface Setup {
  readonly server: S3TestServer;
  readonly client: Bun.S3Client;
  readonly runtime: ManualRuntimeServices;
  readonly calls: Calls;
  readonly diagnostics: string[];
  readonly source: DefinitionSource;
  /** Replace what the next request of a kind does, once. */
  readonly before: {
    put?: ((key: string) => void | Promise<void>) | undefined;
    remove?: ((key: string) => void | Promise<void>) | undefined;
  };
  /** The unrecorded operations over the same server. */
  readonly real: ObjectStoreOperations;
  /** Make the operations a source built from `overrides` uses. */
  make(overrides?: Partial<ObjectStoreOperations>): DefinitionSource;
}

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop();
});

function setup(options: { watch?: boolean; pollIntervalMilliseconds?: number } = {}): Setup {
  const server = createS3TestServer();
  stops.push(() => server.stop());
  const client = new Bun.S3Client(server.clientOptions());
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const calls: Calls = { lists: 0, reads: [], puts: 0, removes: 0 };
  const diagnostics: string[] = [];
  const real = createS3ObjectOperations(client, server.bucket, 'text/plain');
  const before: Setup['before'] = {};
  const recorded: ObjectStoreOperations = {
    list: (prefix, token) => {
      calls.lists += 1;
      return real.list(prefix, token);
    },
    read: (key) => {
      calls.reads.push(key);
      return real.read(key);
    },
    put: async (key, bytes, condition) => {
      calls.puts += 1;
      await before.put?.(key);
      return real.put(key, bytes, condition);
    },
    remove: async (key, etag) => {
      calls.removes += 1;
      await before.remove?.(key);
      return real.remove(key, etag);
    },
  };
  function make(overrides: Partial<ObjectStoreOperations> = {}): DefinitionSource {
    return agentObjectSource(
      { bucket: server.bucket, prefix: PREFIX },
      {
        client,
        operations: { ...recorded, ...overrides },
        runtime,
        pollIntervalMilliseconds: options.pollIntervalMilliseconds ?? POLL,
        diagnose: (message, cause) => {
          diagnostics.push(`${message} ${String(cause)}`);
        },
        ...(options.watch === undefined ? {} : { watch: options.watch }),
      },
    );
  }
  return { server, client, runtime, calls, diagnostics, source: make(), before, real, make };
}

/** The identifiers `source` holds now, sorted. */
async function idsOf(source: DefinitionSource): Promise<string[]> {
  const entries = await source.load();
  return entries.map((entry) => entry.id).toSorted();
}

/** Watch `source`, collecting what it reports. */
function collect(source: DefinitionSource): DefinitionSourceChange[] {
  const reports: DefinitionSourceChange[] = [];
  stops.push(source.watch((change) => reports.push(change)));
  return reports;
}

describe('what a listing counts as a definition', () => {
  it('holds only the .md objects directly under the prefix, by the name minus the extension', async () => {
    const { server, source } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    server.put(`${PREFIX}my agent.md`, 'two');
    server.put(`${PREFIX}nested/deep.md`, 'nested');
    server.put(`${PREFIX}.hidden.md`, 'dotfile');
    server.put(`${PREFIX}notes.txt`, 'wrong extension');
    server.put(`${PREFIX}.md`, 'no name');
    server.put('elsewhere/other.md', 'other prefix');
    server.put('definitions-sibling/other.md', 'sibling prefix');
    const entries = await source.load();
    expect(entries.map((entry) => entry.id).toSorted()).toEqual(['helper', 'my agent']);
    expect(entries.find((entry) => entry.id === 'helper')).toMatchObject({
      hash: hashOf('one'),
    });
  });

  it('treats a prefix without its trailing slash as the same folder', async () => {
    const { server, client } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    const source = agentObjectSource({ bucket: server.bucket, prefix: 'definitions' }, { client });
    expect(await idsOf(source)).toEqual(['helper']);
  });

  it('follows list continuations past one page', async () => {
    const { server, source } = setup();
    server.put(`${PREFIX}a.md`, 'first');
    // 1000 listed objects that are not definitions fill the first page and a half.
    for (let index = 0; index < 1000; index += 1) {
      server.put(`${PREFIX}f${String(index).padStart(4, '0')}.txt`, '');
    }
    server.put(`${PREFIX}zzz.md`, 'after the page boundary');
    expect(await idsOf(source)).toEqual(['a', 'zzz']);
  });

  it('lists an object over the size cap as a problem without reading it', async () => {
    const { server, source, calls } = setup();
    server.put(`${PREFIX}big.md`, new Uint8Array(AGENT_FILE_SIZE_LIMIT + 1));
    const [entry] = await source.load();
    expect(entry).toMatchObject({
      id: 'big',
      hash: '',
      problem: { code: 'file-too-large', size: AGENT_FILE_SIZE_LIMIT + 1 },
    });
    expect(calls.reads).toEqual([]);
  });

  it('reads an object again only when its ETag changed', async () => {
    const { server, source, calls } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    await source.load();
    await source.load();
    expect(calls.reads).toEqual([`${PREFIX}helper.md`]);
    server.put(`${PREFIX}helper.md`, 'two');
    const [entry] = await source.load();
    expect(calls.reads).toHaveLength(2);
    expect(entry?.hash).toBe(hashOf('two'));
  });

  it('lists an unreadable object as a problem and reads it again on the next scan', async () => {
    const { server, make, real } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    let failing = true;
    const source = make({
      read: async (key) => {
        if (failing) throw new Error('connection reset');
        return real.read(key);
      },
    });
    const [broken] = await source.load();
    expect(broken?.problem).toMatchObject({ code: 'unreadable', message: 'connection reset' });
    failing = false;
    const [healed] = await source.load();
    expect(healed).toMatchObject({ hash: hashOf('one') });
    expect(healed?.problem).toBeUndefined();
  });

  it('rejects load() when the listing fails, and keeps the entries it had', async () => {
    const { server, make, real } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    let failing = false;
    const source = make({
      list: async (prefix, token) => {
        if (failing) throw new Error('store unavailable');
        return real.list(prefix, token);
      },
    });
    expect(await source.load()).toHaveLength(1);
    failing = true;
    const failure = await source.load().catch((thrown: unknown) => thrown);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('store unavailable');
  });
});

describe('reading a reference beside the definitions', () => {
  it('lists the key for its size first, and reads an object over the limit never', async () => {
    const { server, source, calls } = setup();
    server.put(`${PREFIX}docs/style.md`, 'Be brief.');
    server.put(`${PREFIX}docs/style.md.bak`, 'a sibling that shares the key as a prefix');
    const agentSource = source as AgentSource;
    expect(await agentSource.readSibling('docs/style.md', { limit: 9 })).toMatchObject({
      kind: 'found',
    });
    expect(calls.reads).toEqual([`${PREFIX}docs/style.md`]);
    calls.reads.length = 0;
    expect(await agentSource.readSibling('docs/style.md', { limit: 8 })).toEqual({
      kind: 'too-large',
      size: 9,
    });
    expect(calls.reads).toEqual([]);
    expect(await agentSource.readSibling('docs/other.md', { limit: 100 })).toEqual({
      kind: 'missing',
    });
  });

  it('is not shown the objects of another prefix, whatever the path', async () => {
    const { server, source } = setup();
    server.put('elsewhere/secret.md', 'not yours');
    const agentSource = source as AgentSource;
    expect(await agentSource.readSibling('secret.md', { limit: 100 })).toEqual({ kind: 'missing' });
    expect(
      await rejectionOf(agentSource.readSibling('../elsewhere/secret.md', { limit: 100 })),
    ).toBeInstanceOf(TypeError);
  });
});

describe('watch', () => {
  it('polls on the injected runtime, reporting empty lists when nothing changed', async () => {
    const { server, source, runtime, calls } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    await source.load();
    const reports = collect(source);
    // The scan watch() starts finds nothing new, and a scan that finds nothing is silent.
    await source.load();
    expect(reports).toEqual([]);
    await runtime.advance(POLL);
    await waitUntil(() => reports.length === 1, { message: 'the first poll' });
    expect(reports[0]).toEqual({ added: [], changed: [], removed: [] });
    await runtime.advance(POLL);
    await waitUntil(() => reports.length === 2, { message: 'the second poll' });
    expect(reports[1]).toEqual({ added: [], changed: [], removed: [] });
    expect(calls.reads).toEqual([`${PREFIX}helper.md`]);
  });

  it('reports what was added, changed, and removed by identifier', async () => {
    const { server, source, runtime } = setup();
    server.put(`${PREFIX}kept.md`, 'kept');
    server.put(`${PREFIX}edited.md`, 'before');
    server.put(`${PREFIX}doomed.md`, 'doomed');
    await source.load();
    const reports = collect(source);
    await source.load();
    expect(reports).toEqual([]);
    server.put(`${PREFIX}edited.md`, 'after');
    server.put(`${PREFIX}fresh.md`, 'fresh');
    await new Bun.S3Client(server.clientOptions()).delete(`${PREFIX}doomed.md`);
    await runtime.advance(POLL);
    await waitUntil(() => reports.length === 1, { message: 'the poll that sees the edits' });
    expect(reports[0]).toEqual({ added: ['fresh'], changed: ['edited'], removed: ['doomed'] });
  });

  it('waits a whole interval, honors a custom one, and stops when the returned function is called', async () => {
    const { source, runtime, calls } = setup({ pollIntervalMilliseconds: 200 });
    await source.load();
    const stop = source.watch(() => undefined);
    // Quiesce: the scan watch() starts, and nothing else yet.
    await source.load();
    const settled = calls.lists;
    await runtime.advance(199);
    await source.load();
    expect(calls.lists).toBe(settled + 1);
    await runtime.advance(1);
    await waitUntil(() => calls.lists === settled + 2, { message: 'the tick at 200 ms' });
    stop();
    stop();
    const afterStop = calls.lists;
    await runtime.advance(2000);
    await source.load();
    expect(calls.lists).toBe(afterStop + 1);
  });

  it('keeps polling until the last of several watchers leaves', async () => {
    const { source, runtime, calls } = setup();
    const stopFirst = source.watch(() => undefined);
    const stopSecond = source.watch(() => undefined);
    await source.load();
    stopFirst();
    const before = calls.lists;
    await runtime.advance(POLL);
    await waitUntil(() => calls.lists > before, { message: 'a poll with one watcher left' });
    stopSecond();
    await source.load();
    const after = calls.lists;
    await runtime.advance(POLL * 5);
    await source.load();
    expect(calls.lists).toBe(after + 1);
  });

  it('starts no timer and no scan under watch: false, and load() still rescans', async () => {
    const { server, source, runtime, calls } = setup({ watch: false });
    const reports = collect(source);
    await runtime.advance(10_000);
    await source.load();
    expect(calls.lists).toBe(1);
    server.put(`${PREFIX}late.md`, 'late');
    expect(await idsOf(source)).toEqual(['late']);
    expect(reports).toEqual([{ added: ['late'], changed: [], removed: [] }]);
  });

  it('reports a failed poll through diagnose, keeps its entries, and polls again', async () => {
    const { server, make, real, runtime, diagnostics } = setup();
    server.put(`${PREFIX}helper.md`, 'one');
    let failing = false;
    const source = make({
      list: async (prefix, token) => {
        if (failing) throw new Error('store unavailable');
        return real.list(prefix, token);
      },
    });
    await source.load();
    const reports = collect(source);
    await source.load();
    expect(reports).toEqual([]);
    failing = true;
    await runtime.advance(POLL);
    await waitUntil(() => diagnostics.length === 1, { message: 'the diagnostic' });
    expect(diagnostics[0]).toContain('could not be scanned');
    expect(diagnostics[0]).toContain('store unavailable');
    expect(reports).toEqual([]);
    failing = false;
    await runtime.advance(POLL);
    await waitUntil(() => reports.length === 1, { message: 'the poll after recovery' });
    expect(reports[0]).toEqual({ added: [], changed: [], removed: [] });
    expect(await idsOf(source)).toEqual(['helper']);
  });

  it('uses the runtime and diagnostics the Bureau lends when it was given none', async () => {
    const { server, client } = setup();
    const lent = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const diagnostics: string[] = [];
    server.put(`${PREFIX}helper.md`, 'one');
    const source = agentObjectSource(
      { bucket: server.bucket, prefix: PREFIX },
      { client, pollIntervalMilliseconds: POLL },
    );
    source.attach?.({
      runtime: lent,
      diagnose: (message) => {
        diagnostics.push(message);
      },
    });
    const reports = collect(source);
    await waitUntil(() => reports.length === 1, { message: 'the scan watch() starts' });
    await lent.advance(POLL);
    await waitUntil(() => reports.length === 2, { message: 'a poll on the lent runtime' });
    expect(diagnostics).toEqual([]);
  });
});

describe('conditional writes and deletes', () => {
  const key = `${PREFIX}helper.md`;
  const text = (server: S3TestServer): string | undefined => {
    const bytes = server.objects().get(key);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  };

  it('a create that loses to an external create conflicts with the winner’s hash', async () => {
    const { server, source, before } = setup();
    before.put = () => {
      before.put = undefined;
      server.put(key, 'external');
    };
    const error = await source
      .write('helper', encoder.encode('mine'), { expectedHash: null })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SourceConflictError);
    expect(error).toMatchObject({ expectedHash: null, actualHash: hashOf('external') });
    expect(text(server)).toBe('external');
  });

  it('a replace whose key vanished before the write conflicts with a null hash', async () => {
    const { server, client, source, before } = setup();
    server.put(key, 'original');
    before.put = async () => {
      before.put = undefined;
      await client.delete(key);
    };
    const error = await source
      .write('helper', encoder.encode('mine'), { expectedHash: hashOf('original') })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SourceConflictError);
    expect(error).toMatchObject({ expectedHash: hashOf('original'), actualHash: null });
    expect(text(server)).toBeUndefined();
  });

  it('a delete that loses to an external edit conflicts with its hash and removes nothing', async () => {
    const { server, source, before } = setup();
    server.put(key, 'original');
    before.remove = () => {
      before.remove = undefined;
      server.put(key, 'edited');
    };
    const error = await source
      .delete('helper', { expectedHash: hashOf('original') })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SourceConflictError);
    expect(error).toMatchObject({ actualHash: hashOf('edited') });
    expect(text(server)).toBe('edited');
  });

  it('a delete whose key vanished conflicts with a null hash, and a stale or absent one never calls remove', async () => {
    const { server, client, source, before, calls } = setup();
    server.put(key, 'original');
    before.remove = async () => {
      before.remove = undefined;
      await client.delete(key);
    };
    const vanished = await source
      .delete('helper', { expectedHash: hashOf('original') })
      .catch((thrown: unknown) => thrown);
    expect(vanished).toMatchObject({ actualHash: null });
    const removesBefore = calls.removes;
    const absent = await source
      .delete('helper', { expectedHash: hashOf('original') })
      .catch((thrown: unknown) => thrown);
    expect(absent).toBeInstanceOf(SourceConflictError);
    expect(absent).toMatchObject({ actualHash: null });
    expect(calls.removes).toBe(removesBefore);
  });

  it('a delete with the matching hash removes the object', async () => {
    const { server, source } = setup();
    server.put(key, 'original');
    await source.delete('helper', { expectedHash: hashOf('original') });
    expect(text(server)).toBeUndefined();
  });

  it('sends the bytes it was given even if the caller reuses the array while the write is in flight', async () => {
    const { server, source, before } = setup();
    const bytes = encoder.encode('as given');
    before.put = () => {
      bytes.fill(0);
    };
    const entry = await source.write('helper', bytes, { expectedHash: null });
    expect(text(server)).toBe('as given');
    expect(entry.bytes).toEqual(encoder.encode('as given'));
  });

  it('refuses an identifier that is not a single object name', async () => {
    const { source, calls } = setup();
    for (const id of ['', '.hidden', 'a/b', 'a\\b', 'a\0b']) {
      // `write` and `delete` are async, so the refusal is a rejection, never a synchronous throw.
      const written = await source
        .write(id, new Uint8Array(), { expectedHash: null })
        .catch((thrown: unknown) => thrown);
      const deleted = await source
        .delete(id, { expectedHash: hashOf('x') })
        .catch((thrown: unknown) => thrown);
      expect(written).toBeInstanceOf(TypeError);
      expect(deleted).toBeInstanceOf(TypeError);
    }
    expect(calls.puts + calls.reads.length).toBe(0);
  });
});

describe('the constructors validate their arguments', () => {
  // No request is made, so no server runs.
  const client = new Bun.S3Client({
    endpoint: 'http://127.0.0.1:1',
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  });
  const location = { bucket: 'test-bucket', prefix: PREFIX };

  it('refuses a missing client, a bad location, and a bad interval', () => {
    const bad = (call: () => unknown): void => {
      expect(call).toThrow(TypeError);
    };
    const loose = agentObjectSource as (location: unknown, options: unknown) => unknown;
    const looseWorkflow = workflowObjectSource as (location: unknown, options: unknown) => unknown;
    bad(() => loose(location, {}));
    bad(() => loose(location, undefined));
    bad(() => loose(undefined, { client }));
    bad(() => loose({ bucket: '', prefix: PREFIX }, { client }));
    bad(() => loose({ bucket: 3, prefix: PREFIX }, { client }));
    bad(() => loose({ bucket: 'test-bucket' }, { client }));
    bad(() => loose({ bucket: 'test-bucket', prefix: '/leading' }, { client }));
    bad(() => loose(location, { client, pollIntervalMilliseconds: 0 }));
    bad(() => looseWorkflow(location, { client, pollIntervalMilliseconds: Number.NaN }));
  });

  it('tags the source with its kind and the agent source with its tools', () => {
    const agent = agentObjectSource(location, { client, tools: {} });
    const workflow = workflowObjectSource(location, { client });
    expect(agent.kind).toBe('agent');
    expect(agent.tools).toEqual({});
    expect(workflow.kind).toBe('workflow');
    expect(typeof sources.agentObjectSource).toBe('function');
    expect(typeof sources.workflowObjectSource).toBe('function');
  });
});
