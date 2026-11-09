/**
 * COR-2137 — the agent-file keys `defaultEffort`, `toolApproval`, `childAgents` and
 * `skillDescriptors` became `effort`, `approvals`, `children` and `card`. For each: a file that uses
 * the new key parses, a file that still uses the old key is refused at the old key's own path, and
 * a snapshot or a saved version written under the old key still reads as the new one (and is never
 * written back under the old one). Override records of a built-in agent follow the same rule for the
 * two keys they hold.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { agentFileDefinitionSchema, parseAgentFile } from './agent-file';
import {
  agentOverrideVersionKey,
  AGENT_OVERRIDE_KEYS,
  createAgentOverrideStore,
  hashAgentOverrides,
} from './agent-override-store';
import { AGENT_SNAPSHOT_KEY_PREFIX, createAgentSnapshotStore } from './agent-snapshot-store';
import { parseAgentVersion } from './agent-version-store';
import { KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

const SKILL = { id: 'cite', name: 'Cite', description: 'Adds footnotes', tags: ['footnoting'] };

interface RenamedKey {
  readonly oldKey: string;
  readonly newKey: string;
  /** The key's value as frontmatter text. */
  readonly yaml: string;
  /** The key's value as a definition holds it. */
  readonly value: unknown;
  /** A different value, to tell which of two keys a read took. */
  readonly otherValue: unknown;
}

const RENAMED: readonly RenamedKey[] = [
  {
    oldKey: 'defaultEffort',
    newKey: 'effort',
    yaml: 'high',
    value: 'high',
    otherValue: 'low',
  },
  {
    oldKey: 'toolApproval',
    newKey: 'approvals',
    yaml: '{ lookup-order: never }',
    value: { 'lookup-order': 'never' },
    otherValue: { 'lookup-order': 'always' },
  },
  {
    oldKey: 'childAgents',
    newKey: 'children',
    yaml: '[reviewer]',
    value: ['reviewer'],
    otherValue: ['editor'],
  },
  {
    oldKey: 'skillDescriptors',
    newKey: 'card',
    yaml: '[{id: cite, name: Cite, description: Adds footnotes, tags: [footnoting]}]',
    value: [SKILL],
    otherValue: [{ ...SKILL, id: 'other' }],
  },
];

function fileWith(key: string, yaml: string): string {
  return `---\nmodel: ${KNOWN_MODEL}\n${key}: ${yaml}\n---\nBody.\n`;
}

/** A stored definition as a snapshot or a saved version holds it, with `extra` keys added. */
function storedDefinition(extra: Record<string, unknown>) {
  return {
    name: 'Helper',
    description: null,
    model: KNOWN_MODEL,
    tools: [],
    a2a: false,
    instructions: 'Recorded.\n',
    ...extra,
  };
}

describe.each(RENAMED)(
  'the $oldKey key, now $newKey',
  ({ oldKey, newKey, yaml, value, otherValue }) => {
    it(`parses a file that says ${newKey}`, () => {
      const result = parseAgentFile('helper', fileWith(newKey, yaml));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.file.definition).toMatchObject({ [newKey]: value });
      expect(result.file.definition).not.toHaveProperty(oldKey);
    });

    it(`refuses a file that still says ${oldKey}, at the path ${oldKey}, with the rename message`, () => {
      const result = parseAgentFile('helper', fileWith(oldKey, yaml));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.code).toBe('invalid-frontmatter');
      expect(result.problem.issues).toEqual([
        { path: oldKey, message: expect.stringContaining(`renamed to \`${newKey}\``) },
      ]);
    });

    it(`refuses ${oldKey} even when it is empty`, () => {
      const result = parseAgentFile(
        'helper',
        `---\nmodel: ${KNOWN_MODEL}\n${oldKey}:\n---\nBody.\n`,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.issues?.map((issue) => issue.path)).toEqual([oldKey]);
    });

    it('reads a stored definition that names the old key as the new key, and drops the old one', () => {
      const definition = agentFileDefinitionSchema.parse(storedDefinition({ [oldKey]: value }));
      expect(definition).toMatchObject({ [newKey]: value });
      expect(definition).not.toHaveProperty(oldKey);
    });

    it('prefers the new key when a stored definition names both', () => {
      const definition = agentFileDefinitionSchema.parse(
        storedDefinition({ [oldKey]: otherValue, [newKey]: value }),
      );
      expect(definition).toMatchObject({ [newKey]: value });
      expect(definition).not.toHaveProperty(oldKey);
    });

    it('resumes a snapshot written under the old key with the same meaning', async () => {
      const backing = textValueStore(new MemoryStorage());
      const store = createAgentSnapshotStore({
        store: backing,
        nowISO: () => '2026-11-01T00:00:00Z',
      });
      await backing.set(
        `${AGENT_SNAPSHOT_KEY_PREFIX}helper:aa`,
        JSON.stringify({
          schemaVersion: 1,
          id: 'helper',
          hash: 'aa',
          firstRunAt: '2026-10-01T00:00:00.000Z',
          lastRunAt: '2026-10-01T00:00:00.000Z',
          definition: storedDefinition({ [oldKey]: value }),
        }),
      );
      const loaded = await store.load('helper', 'aa');
      expect(loaded?.definition).toMatchObject({ [newKey]: value });
      expect(loaded?.definition).not.toHaveProperty(oldKey);
    });

    it('reads a saved version written under the old key, and the key it lists as changed', () => {
      const version = parseAgentVersion(
        JSON.stringify({
          revision: 2,
          hash: 'b'.repeat(64),
          savedAt: '2026-10-02T00:00:00.000Z',
          savedBy: null,
          owner: 'anonymous:local',
          definition: storedDefinition({ [oldKey]: value }),
          changedKeys: [oldKey, 'instructions'],
        }),
      );
      expect(version?.definition).toMatchObject({ [newKey]: value });
      expect(version?.definition).not.toHaveProperty(oldKey);
      expect(version?.changedKeys).toEqual([newKey, 'instructions']);
    });
  },
);

describe('a saved override record of a built-in agent', () => {
  const approvals = { 'lookup-order': 'always' } as const;

  async function storeHolding(overrides: Record<string, unknown>, changedKeys: string[]) {
    const backing = textValueStore(new MemoryStorage());
    await backing.set(
      agentOverrideVersionKey('tool-runner', 1),
      JSON.stringify({
        version: 1,
        hash: 'c'.repeat(64),
        savedAt: '2026-10-01T00:00:00.000Z',
        savedBy: 'anonymous:local',
        owner: 'anonymous:local',
        overrides,
        changedKeys,
      }),
    );
    return createAgentOverrideStore({ store: backing, nowISO: () => '2026-11-01T00:00:00Z' });
  }

  it('written with toolApproval and defaultEffort reads as approvals and effort', async () => {
    const store = await storeHolding(
      { tools: ['lookup-order'], toolApproval: approvals, defaultEffort: 'high' },
      ['tools', 'toolApproval', 'defaultEffort'],
    );
    const [record] = await store.list('tool-runner');
    expect(record?.overrides).toEqual({ tools: ['lookup-order'], approvals, effort: 'high' });
    expect(record?.changedKeys).toEqual(['tools', 'approvals', 'effort']);
    const current = await store.current('tool-runner');
    expect(current.overrides).toEqual(record?.overrides ?? {});
  });

  it('prefers the new names when a record holds both', async () => {
    const store = await storeHolding(
      { toolApproval: { 'lookup-order': 'never' }, approvals, defaultEffort: 'low', effort: 'max' },
      [],
    );
    const current = await store.current('tool-runner');
    expect(current.overrides).toEqual({ approvals, effort: 'max' });
  });

  it('is saved again under the new names, never the old ones', async () => {
    const store = await storeHolding({ toolApproval: approvals, defaultEffort: 'high' }, []);
    const { hash } = await store.current('tool-runner');
    await store.save(
      'tool-runner',
      { approvals, effort: 'max' },
      { expectedHash: hash, savedBy: 'anonymous:local', owner: 'anonymous:local' },
    );
    const [newest] = await store.list('tool-runner');
    expect(newest?.version).toBe(2);
    expect(newest?.hash).toBe(hashAgentOverrides({ approvals, effort: 'max' }));
    expect(newest?.changedKeys).toEqual(['effort']);
    expect(AGENT_OVERRIDE_KEYS).toEqual(expect.arrayContaining(['approvals', 'effort']));
    expect(AGENT_OVERRIDE_KEYS).not.toContain('toolApproval');
    expect(AGENT_OVERRIDE_KEYS).not.toContain('defaultEffort');
  });

  it('refuses a save that still says the old names', async () => {
    const store = await storeHolding({}, []);
    const { hash } = await store.current('tool-runner');
    const failure = await rejectionOf(
      store.save('tool-runner', { toolApproval: approvals } as never, {
        expectedHash: hash,
        savedBy: 'anonymous:local',
        owner: 'anonymous:local',
      }),
    );
    expect(failure).toBeInstanceOf(Error);
  });
});
