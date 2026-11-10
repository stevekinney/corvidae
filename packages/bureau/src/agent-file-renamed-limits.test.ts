/**
 * COR-2138 — the agent-file keys `stepLimit`, `costBudget` and `toolBudget` became `limits.steps`,
 * `limits.cost` and `limits.tools`, and the fields inside the two budgets were renamed: `perRunUsd`,
 * `perChatUsd` and `warnAt` are `run`, `chat` and `warn`, and `maxCalls` and `maxDurationSeconds`
 * are `calls` and `seconds`. For each limit: a file that uses the new shape parses, a file that
 * still uses the old key is refused at the old key's own path, and a snapshot or a saved version
 * written under the old key still reads as the new one (and is never written back under the old
 * one). Override records of a built-in agent follow the same rule.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { agentFileDefinitionSchema, parseAgentFile, serializeUpdatedAgentFile } from './agent-file';
import {
  legacyAgentOverrideVersionKey,
  AGENT_OVERRIDE_KEYS,
  createAgentOverrideStore,
  hashAgentOverrides,
} from './agent-override-store';
import { AGENT_SNAPSHOT_KEY_PREFIX, createAgentSnapshotStore } from './agent-snapshot-store';
import { parseAgentVersion } from './agent-version-store';
import { KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

interface RenamedLimit {
  readonly oldKey: string;
  readonly newKey: string;
  /** The limit's name inside `limits`. */
  readonly name: 'steps' | 'cost' | 'tools';
  /** The old key's value as frontmatter text. */
  readonly oldYaml: string;
  /** The new key's value as frontmatter text. */
  readonly newYaml: string;
  /** The old key's value as a stored definition or override record held it. */
  readonly oldValue: unknown;
  /** The limit as a definition holds it. */
  readonly value: unknown;
  /** A different old value, to tell which of two keys a read took. */
  readonly otherOldValue: unknown;
}

const RENAMED: readonly RenamedLimit[] = [
  {
    oldKey: 'stepLimit',
    newKey: 'limits.steps',
    name: 'steps',
    oldYaml: '12',
    newYaml: '12',
    oldValue: 12,
    value: 12,
    otherOldValue: 40,
  },
  {
    oldKey: 'costBudget',
    newKey: 'limits.cost',
    name: 'cost',
    oldYaml: '{ perRunUsd: 2, perChatUsd: 5, warnAt: [0.5, 0.9] }',
    newYaml: '{ run: 2, chat: 5, warn: [0.5, 0.9] }',
    oldValue: { perRunUsd: 2, perChatUsd: 5, warnAt: [0.5, 0.9] },
    value: { run: 2, chat: 5, warn: [0.5, 0.9] },
    otherOldValue: { perRunUsd: 9 },
  },
  {
    oldKey: 'toolBudget',
    newKey: 'limits.tools',
    name: 'tools',
    oldYaml: '{ maxCalls: 3, maxDurationSeconds: 60 }',
    newYaml: '{ calls: 3, seconds: 60 }',
    oldValue: { maxCalls: 3, maxDurationSeconds: 60 },
    value: { calls: 3, seconds: 60 },
    otherOldValue: { maxCalls: 7 },
  },
];

function fileWith(frontmatter: string): string {
  return `---\nmodel: ${KNOWN_MODEL}\n${frontmatter}\n---\nBody.\n`;
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
  ({ oldKey, newKey, name, oldYaml, newYaml, oldValue, value, otherOldValue }) => {
    it(`parses a file that says ${newKey}`, () => {
      const result = parseAgentFile('helper', fileWith(`limits: { ${name}: ${newYaml} }`));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.file.definition.limits).toEqual({ [name]: value });
      expect(result.file.definition).not.toHaveProperty(oldKey);
    });

    it(`refuses a file that still says ${oldKey}, at the path ${oldKey}, with the rename message`, () => {
      const result = parseAgentFile('helper', fileWith(`${oldKey}: ${oldYaml}`));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.code).toBe('invalid-frontmatter');
      expect(result.problem.issues).toEqual([
        { path: oldKey, message: expect.stringContaining(`renamed to \`${newKey}\``) },
      ]);
    });

    it(`refuses ${oldKey} even when it is empty`, () => {
      const result = parseAgentFile('helper', fileWith(`${oldKey}:`));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.issues?.map((issue) => issue.path)).toEqual([oldKey]);
    });

    it('reads a stored definition that names the old key as the new limit, and drops the old key', () => {
      const definition = agentFileDefinitionSchema.parse(storedDefinition({ [oldKey]: oldValue }));
      expect(definition.limits).toEqual({ [name]: value });
      expect(definition).not.toHaveProperty(oldKey);
    });

    it('prefers the new limit when a stored definition names both', () => {
      const definition = agentFileDefinitionSchema.parse(
        storedDefinition({ [oldKey]: otherOldValue, limits: { [name]: value } }),
      );
      expect(definition.limits).toEqual({ [name]: value });
      expect(definition).not.toHaveProperty(oldKey);
    });

    it('still refuses a stored definition whose old value is not valid', () => {
      const invalid = oldKey === 'stepLimit' ? 0 : { perRunUsd: 0, maxCalls: 0 };
      expect(
        agentFileDefinitionSchema.safeParse(storedDefinition({ [oldKey]: invalid })).success,
      ).toBe(false);
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
          definition: storedDefinition({ [oldKey]: oldValue }),
        }),
      );
      const loaded = await store.load('helper', 'aa');
      expect(loaded?.definition.limits).toEqual({ [name]: value });
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
          definition: storedDefinition({ [oldKey]: oldValue }),
          changedKeys: [oldKey, 'instructions'],
        }),
      );
      expect(version?.definition.limits).toEqual({ [name]: value });
      expect(version?.definition).not.toHaveProperty(oldKey);
      expect(version?.changedKeys).toEqual(['limits', 'instructions']);
    });
  },
);

describe('limits together', () => {
  it('parses all three in one file', () => {
    const result = parseAgentFile(
      'helper',
      fileWith('limits:\n  steps: 9\n  cost: { run: 1 }\n  tools: { calls: 2 }'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.definition.limits).toEqual({
      steps: 9,
      cost: { run: 1 },
      tools: { calls: 2 },
    });
  });

  it('refuses all three old keys at once, each at its own path', () => {
    const result = parseAgentFile(
      'helper',
      fileWith('stepLimit: 9\ncostBudget: { perRunUsd: 1 }\ntoolBudget: { maxCalls: 2 }'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.issues?.map((issue) => issue.path).toSorted()).toEqual([
      'costBudget',
      'stepLimit',
      'toolBudget',
    ]);
  });

  it('refuses a limit name that is not steps, cost or tools', () => {
    const result = parseAgentFile('helper', fileWith('limits: { stepLimit: 9 }'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.issues?.map((issue) => issue.path)).toEqual(['limits']);
  });

  it('refuses the old field names inside limits.cost and limits.tools', () => {
    for (const frontmatter of [
      'limits: { cost: { perRunUsd: 1 } }',
      'limits: { tools: { maxCalls: 1 } }',
    ]) {
      expect(parseAgentFile('helper', fileWith(frontmatter)).ok).toBe(false);
    }
  });

  it('reads a stored definition holding all three old keys as one limits object', () => {
    const definition = agentFileDefinitionSchema.parse(
      storedDefinition({
        stepLimit: 12,
        costBudget: { perRunUsd: 2, warnAt: [0.5] },
        toolBudget: { maxDurationSeconds: 30 },
      }),
    );
    expect(definition.limits).toEqual({
      steps: 12,
      cost: { run: 2, warn: [0.5] },
      tools: { seconds: 30 },
    });
  });

  it('keeps each old key a stored definition holds when limits holds another', () => {
    const definition = agentFileDefinitionSchema.parse(
      storedDefinition({ stepLimit: 12, limits: { cost: { run: 3 } } }),
    );
    expect(definition.limits).toEqual({ steps: 12, cost: { run: 3 } });
  });

  it('lists a saved version’s three old limit keys once, as limits', () => {
    const version = parseAgentVersion(
      JSON.stringify({
        revision: 2,
        hash: 'b'.repeat(64),
        savedAt: '2026-10-02T00:00:00.000Z',
        savedBy: null,
        owner: 'anonymous:local',
        definition: storedDefinition({}),
        changedKeys: ['stepLimit', 'costBudget', 'instructions', 'toolBudget'],
      }),
    );
    expect(version?.changedKeys).toEqual(['limits', 'instructions']);
  });
});

describe('updating limits', () => {
  const decoder = new TextDecoder();
  const FILE =
    '---\nmodel: a/b\nlimits:\n  steps: 7\n  cost: { run: 1 }\n  tools: { calls: 5 }\n---\nBody.\n';

  function updated(limits: Parameters<typeof serializeUpdatedAgentFile>[2]['limits']) {
    const file = parseAgentFile('helper', FILE);
    if (!file.ok) throw new Error(file.problem.message);
    const bytes = serializeUpdatedAgentFile('helper', file.file, {
      model: 'a/b',
      instructions: 'Body.\n',
      ...(limits === undefined ? {} : { limits }),
    });
    const next = parseAgentFile('helper', bytes === undefined ? FILE : decoder.decode(bytes));
    return { bytes, definition: next.ok ? next.file.definition : undefined };
  }

  it('keeps every limit when the update leaves limits out', () => {
    expect(updated(undefined).bytes).toBeUndefined();
  });

  it('keeps each limit the update leaves out of limits, and changes the one it states', () => {
    expect(updated({ cost: { run: 3 } }).definition?.limits).toEqual({
      steps: 7,
      cost: { run: 3 },
      tools: { calls: 5 },
    });
  });

  it('removes the limit the update sets to null and keeps the others', () => {
    expect(updated({ steps: null }).definition?.limits).toEqual({
      cost: { run: 1 },
      tools: { calls: 5 },
    });
    expect(updated({ cost: null, tools: null }).definition?.limits).toEqual({ steps: 7 });
  });

  it('removes limits for null, and writes no limits key when none is left', () => {
    const none = updated(null);
    expect(none.definition).not.toHaveProperty('limits');
    expect(decoder.decode(none.bytes)).not.toContain('limits');
    const emptied = updated({ steps: null, cost: null, tools: null });
    expect(emptied.definition).not.toHaveProperty('limits');
  });

  it('writes the new keys, never the old ones', () => {
    const text = decoder.decode(updated({ cost: { run: 3, chat: 4, warn: [0.9, 0.5] } }).bytes);
    expect(text).toContain('limits:');
    expect(text).toContain('run: 3');
    expect(text).toContain('chat: 4');
    for (const old of ['stepLimit', 'costBudget', 'toolBudget', 'perRunUsd', 'maxCalls']) {
      expect(text).not.toContain(old);
    }
  });
});

describe('a saved override record of a built-in agent', () => {
  async function storeHolding(overrides: Record<string, unknown>, changedKeys: string[]) {
    const backing = textValueStore(new MemoryStorage());
    await backing.set(
      legacyAgentOverrideVersionKey('tool-runner', 1),
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

  it('written with stepLimit, costBudget and toolBudget reads as limits', async () => {
    const store = await storeHolding(
      {
        tools: ['lookup-order'],
        stepLimit: 20,
        costBudget: { perRunUsd: 2, perChatUsd: 5, warnAt: [0.5] },
        toolBudget: { maxCalls: 3, maxDurationSeconds: 60 },
      },
      ['tools', 'stepLimit', 'costBudget', 'toolBudget'],
    );
    const [record] = await store.list('tool-runner');
    expect(record?.overrides).toEqual({
      tools: ['lookup-order'],
      limits: {
        steps: 20,
        cost: { run: 2, chat: 5, warn: [0.5] },
        tools: { calls: 3, seconds: 60 },
      },
    });
    expect(record?.changedKeys).toEqual(['tools', 'limits']);
    const current = await store.current('tool-runner');
    expect(current.overrides).toEqual(record?.overrides ?? {});
  });

  it('prefers a limit under limits when a record holds it under the old key too', async () => {
    const store = await storeHolding(
      { stepLimit: 5, costBudget: { perRunUsd: 1 }, limits: { steps: 9 } },
      [],
    );
    const current = await store.current('tool-runner');
    expect(current.overrides).toEqual({ limits: { steps: 9, cost: { run: 1 } } });
  });

  it('is saved again under limits, never the old keys', async () => {
    const store = await storeHolding({ stepLimit: 20 }, []);
    const { hash } = await store.current('tool-runner');
    const next = { limits: { steps: 20, cost: { run: 2 } } };
    await store.save('tool-runner', next, {
      expectedHash: hash,
      savedBy: 'anonymous:local',
      owner: 'anonymous:local',
    });
    const [newest] = await store.list('tool-runner');
    expect(newest?.version).toBe(2);
    expect(newest?.hash).toBe(hashAgentOverrides(next));
    expect(newest?.changedKeys).toEqual(['limits']);
    expect(AGENT_OVERRIDE_KEYS).toContain('limits');
    for (const old of ['stepLimit', 'costBudget', 'toolBudget']) {
      expect(AGENT_OVERRIDE_KEYS).not.toContain(old);
    }
  });

  it('refuses a save that still says the old keys, and one that sets no limit under limits', async () => {
    const store = await storeHolding({}, []);
    const { hash } = await store.current('tool-runner');
    const saved = { expectedHash: hash, savedBy: 'anonymous:local', owner: 'anonymous:local' };
    for (const overrides of [
      { stepLimit: 5 },
      { costBudget: { perRunUsd: 1 } },
      { toolBudget: { maxCalls: 1 } },
      { limits: {} },
    ]) {
      const failure = await rejectionOf(store.save('tool-runner', overrides, saved));
      expect(failure).toBeInstanceOf(Error);
    }
  });
});
