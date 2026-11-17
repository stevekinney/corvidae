/**
 * COR-2120 — an agent that names an owner's guardrail copies it. Its identity folds the digest in,
 * so a changed guardrail is a new agent revision; a snapshot of the agent stores the definition, so
 * a run that resumes rebuilds the guardrail it began with whatever the file says now, even deleted;
 * and an agent that names none is exactly what it was before.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentSnapshotError } from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import { createFileAgentRuntime } from './agent-file-runtime';
import { AGENT_SNAPSHOT_KEY_PREFIX, createAgentSnapshotStore } from './agent-snapshot-store';
import { parseGuardrailFile } from './guardrail-file';
import type { OwnerGuardrailCopy } from './owner-guardrails';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function copyOf(id: string, phrase: string, checks = 'output'): OwnerGuardrailCopy {
  const parsed = parseGuardrailFile(
    id,
    JSON.stringify({
      kind: 'pattern',
      description: `Guards ${phrase}.`,
      checks,
      phrases: [phrase],
    }),
  );
  if (!parsed.ok) throw new Error(`fixture is not a valid file: ${parsed.code}`);
  return { id, digest: parsed.digest, definition: parsed.definition };
}

const NAMES = agentFileText({ model: KNOWN_MODEL, guardrails: '[no-sauce]' }, 'Be helpful.\n');

async function start(initial: readonly OwnerGuardrailCopy[]) {
  const owned = { current: [...initial] };
  const fixture = await createAgentFileFixture({
    watch: false,
    ownerGuardrails: () => owned.current,
  });
  fixtures.push(fixture);
  await fixture.catalog.refresh();
  return { fixture, owned };
}

function bindingOf(fixture: AgentFileFixture, id = 'helper') {
  const agent = fixture.catalog.find(id);
  const binding = agent === undefined ? undefined : readFileAgentBinding(agent);
  if (binding === undefined) throw new Error(`Expected the ${id} agent to be ready.`);
  return binding;
}

const listing = (fixture: AgentFileFixture, id = 'helper') =>
  fixture.catalog.list().find((candidate) => candidate.id === id);

function snapshots() {
  const store = textValueStore(new MemoryStorage());
  return {
    store,
    snapshots: createAgentSnapshotStore({ store, nowISO: () => '2026-11-16T00:00:00.000Z' }),
  };
}

describe('an agent that names an owner guardrail', () => {
  it('copies it, and folds its digest into the identity its snapshot is keyed by', async () => {
    const { fixture } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();

    const binding = bindingOf(fixture);

    expect(binding.guardrailDefinitions).toEqual([copyOf('no-sauce', 'secret-sauce')]);
    // Not the file's own hash: the agent is the file and the guardrail it names.
    expect(binding.hash).not.toBe(listing(fixture)?.definitionHash);
    expect(binding.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is exactly what it was before for an agent that names none', async () => {
    const { fixture } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('plain.md', validAgentFile());
    await fixture.catalog.refresh();

    const binding = bindingOf(fixture, 'plain');

    expect(binding.guardrailDefinitions).toBeUndefined();
    expect(binding.hash).toBe(listing(fixture, 'plain')?.definitionHash as string);
  });

  it('is a new agent revision when the guardrail it names is edited, though its file is not', async () => {
    const { fixture, owned } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const first = bindingOf(fixture);
    const firstListing = listing(fixture);

    owned.current = [copyOf('no-sauce', 'family-recipe')];
    await fixture.catalog.revalidate();

    const second = bindingOf(fixture);
    expect(second.hash).not.toBe(first.hash);
    expect(second.guardrailDefinitions?.[0]?.definition.phrases).toEqual(['family-recipe']);
    expect(listing(fixture)?.definitionHash).toBe(firstListing?.definitionHash);
    expect(listing(fixture)?.definitionRevision).toBe((firstListing?.definitionRevision ?? 0) + 1);
  });

  it('is the same agent when a guardrail it does not name is edited', async () => {
    const { fixture, owned } = await start([
      copyOf('no-sauce', 'secret-sauce'),
      copyOf('other', 'x'),
    ]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const first = bindingOf(fixture);

    owned.current = [copyOf('no-sauce', 'secret-sauce'), copyOf('other', 'y')];
    await fixture.catalog.revalidate();

    expect(bindingOf(fixture).hash).toBe(first.hash);
    expect(listing(fixture)?.definitionRevision).toBe(1);
  });

  it('is invalid with reference-unresolved when the guardrail it names is gone', async () => {
    const { fixture, owned } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();

    owned.current = [];
    await fixture.catalog.revalidate();

    expect(listing(fixture)).toMatchObject({
      state: 'invalid',
      problem: { code: 'reference-unresolved' },
    });
  });

  it('names an owner guardrail in escalations as well, with the same copy', async () => {
    const { fixture } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, escalations: '[no-sauce]' }, 'Be helpful.\n'),
    );
    await fixture.catalog.refresh();

    expect(bindingOf(fixture).guardrailDefinitions).toEqual([copyOf('no-sauce', 'secret-sauce')]);
  });
});

describe('a run that resumes from its snapshot', () => {
  it('rebuilds the guardrail it began with after the file is edited, and with its identity', async () => {
    const { fixture, owned } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const { snapshots: store } = snapshots();
    const began = bindingOf(fixture);
    await store.recordRun(began, 'run-1');

    owned.current = [copyOf('no-sauce', 'family-recipe')];
    await fixture.catalog.revalidate();
    await store.recordRun(bindingOf(fixture), 'run-2');

    const snapshot = await store.load('helper', began.hash);
    if (snapshot === undefined) throw new Error('Expected the first snapshot.');
    expect(snapshot.guardrailDefinitions).toEqual([copyOf('no-sauce', 'secret-sauce')]);
    const rebuilt = readFileAgentBinding(fixture.catalog.agentFromSnapshot(snapshot, 1));
    expect(rebuilt?.hash).toBe(began.hash);
    expect(rebuilt?.guardrailDefinitions).toEqual([copyOf('no-sauce', 'secret-sauce')]);
  });

  it('is rebuilt by the runtime a resumed run takes, from the identity its run recorded', async () => {
    const { fixture, owned } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const { snapshots: store } = snapshots();
    const runtime = createFileAgentRuntime({
      files: fixture.catalog,
      snapshots: store,
      diagnose: (message, cause) => {
        throw new Error(`${message} ${String(cause)}`);
      },
    });
    const agent = fixture.catalog.find('helper');
    if (agent === undefined) throw new Error('Expected the helper agent.');
    const began = await runtime.recordRunStart(agent, 'run-1');

    owned.current = [copyOf('no-sauce', 'family-recipe')];
    await fixture.catalog.revalidate();
    const resumed = await runtime.agentForRecordedRun('helper', began?.hash ?? '', 1, 'run-1');

    expect(resumed.binding.hash).toBe(began?.hash as string);
    expect(resumed.binding.guardrailDefinitions).toEqual([copyOf('no-sauce', 'secret-sauce')]);
  });

  it('rebuilds even when the guardrail file has since been deleted', async () => {
    const { fixture, owned } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const { snapshots: store } = snapshots();
    const began = bindingOf(fixture);
    await store.recordRun(began, 'run-1');

    owned.current = [];
    await fixture.catalog.revalidate();
    expect(listing(fixture)?.state).toBe('invalid');

    const snapshot = await store.load('helper', began.hash);
    if (snapshot === undefined) throw new Error('Expected the snapshot.');
    expect(
      readFileAgentBinding(fixture.catalog.agentFromSnapshot(snapshot, 1))?.guardrailDefinitions,
    ).toEqual([copyOf('no-sauce', 'secret-sauce')]);
  });

  it('cannot rebuild a snapshot that names an owner guardrail and copied none, which names no file now', async () => {
    const { fixture } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const { snapshots: store, store: raw } = snapshots();
    await store.recordRun(bindingOf(fixture), 'run-1');
    const [key] = await raw.list(AGENT_SNAPSHOT_KEY_PREFIX);
    const written = JSON.parse((await raw.get(key!)) ?? '{}') as Record<string, unknown>;
    delete written['guardrailDefinitions'];
    await raw.set(key!, JSON.stringify(written));
    const snapshot = await store.load('helper', bindingOf(fixture).hash);
    if (snapshot === undefined) throw new Error('Expected the snapshot.');

    expect(() => fixture.catalog.agentFromSnapshot(snapshot, 1)).toThrow(AgentSnapshotError);
  });
});

describe('the snapshot store', () => {
  it('reads a snapshot written before guardrail copies existed, and holds the field only for an agent that has one', async () => {
    const { fixture } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('plain.md', validAgentFile());
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const { snapshots: store, store: raw } = snapshots();
    await store.recordRun(bindingOf(fixture, 'plain'), 'run-plain');
    await store.recordRun(bindingOf(fixture), 'run-helper');

    const keys = await raw.list(AGENT_SNAPSHOT_KEY_PREFIX);
    const texts = await Promise.all(keys.map(async (key) => (await raw.get(key)) ?? ''));
    expect(texts.filter((text) => text.includes('guardrailDefinitions'))).toHaveLength(1);
    const plain = await store.load('plain', bindingOf(fixture, 'plain').hash);
    expect(plain?.guardrailDefinitions).toBeUndefined();
  });

  it('refuses a snapshot whose copy is not what its digest says, or is not a definition', async () => {
    const { fixture } = await start([copyOf('no-sauce', 'secret-sauce')]);
    await fixture.put('helper.md', NAMES);
    await fixture.catalog.refresh();
    const { snapshots: store, store: raw } = snapshots();
    const binding = bindingOf(fixture);
    await store.recordRun(binding, 'run-1');
    const [key] = await raw.list(AGENT_SNAPSHOT_KEY_PREFIX);
    const original = (await raw.get(key!)) ?? '';

    for (const tamper of [
      (copies: Record<string, unknown>[]) => {
        (copies[0]!['definition'] as Record<string, unknown>)['phrases'] = ['tampered'];
      },
      (copies: Record<string, unknown>[]) => {
        (copies[0]!['definition'] as Record<string, unknown>)['patterns'] = ['('];
      },
      (copies: Record<string, unknown>[]) => {
        copies[0]!['digest'] = 'f'.repeat(64);
      },
    ]) {
      const written = JSON.parse(original) as { guardrailDefinitions: Record<string, unknown>[] };
      tamper(written.guardrailDefinitions);
      await raw.set(key!, JSON.stringify(written));
      const failure = await store.load('helper', binding.hash).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AgentSnapshotError);
      expect((failure as AgentSnapshotError).code).toBe('snapshot-unresolvable');
    }
  });
});
