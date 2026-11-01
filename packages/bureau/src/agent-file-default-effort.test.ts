/**
 * COR-1961 — an agent file's `defaultEffort`: what it accepts, how a write keeps it, that a write
 * is refused for an effort the default model cannot do, that the definition output carries it, that
 * a chat starts at it unless steered away, and that a file without it behaves as it did before.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  agentFileDefinitionSchema,
  agentFileInputOf,
  AgentFileError,
  parseAgentFile,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';
import {
  callAs,
  DEFINITION,
  disposeServed,
  serve,
} from './http/management/agent-definitions-fixtures.test-support.ts';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { waitForTaskState } from './test';

const decoder = new TextDecoder();

/** Portable tiers low, medium and high; `max` and `xhigh` degrade to `high`. */
const THREE_TIERS = 'anthropic/claude-opus-4-5';
/** A model with no effort support at all. */
const NO_EFFORT = 'openai/gpt-4.1';

function parsed(text: string): ParsedAgentFile {
  const result = parseAgentFile('helper', text);
  if (!result.ok) throw new Error(`Expected the file to parse: ${result.problem.message}`);
  return result.file;
}

function issuePaths(frontmatter: string): string[] | undefined {
  const result = parseAgentFile('helper', `---\nmodel: a/b\n${frontmatter}\n---\n`);
  if (result.ok) return undefined;
  expect(result.problem.code).toBe('invalid-frontmatter');
  return result.problem.issues?.map((issue) => issue.path);
}

describe('defaultEffort in the frontmatter', () => {
  it('holds the tier as written, and a file without the key, or with a null one, has none', () => {
    expect(parsed('---\nmodel: a/b\ndefaultEffort: high\n---\n').definition.defaultEffort).toBe(
      'high',
    );
    expect(parsed('---\nmodel: a/b\n---\n').definition).not.toHaveProperty('defaultEffort');
    expect(parsed('---\nmodel: a/b\ndefaultEffort:\n---\n').definition).not.toHaveProperty(
      'defaultEffort',
    );
  });

  it('accepts every tier Operative knows', () => {
    for (const tier of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(
        parsed(`---\nmodel: a/b\ndefaultEffort: ${tier}\n---\n`).definition.defaultEffort,
      ).toBe(tier);
    }
  });

  it('names the field of a value it refuses', () => {
    expect(issuePaths('defaultEffort: extreme')).toEqual(['defaultEffort']);
    expect(issuePaths('defaultEffort: 3')).toEqual(['defaultEffort']);
    expect(issuePaths('defaultEffort: [high]')).toEqual(['defaultEffort']);
  });
});

describe('writing defaultEffort', () => {
  const BASE = { model: 'a/b', instructions: 'Body.\n' };

  it('writes the tier, and no key for none', () => {
    const text = (defaultEffort: 'high' | null | undefined) =>
      decoder.decode(serializeNewAgentFile({ ...BASE, defaultEffort }));
    expect(parsed(text('high')).definition.defaultEffort).toBe('high');
    expect(text(null)).not.toContain('defaultEffort');
    expect(text(undefined)).not.toContain('defaultEffort');
  });

  it('keeps the file’s tier when an update omits it, and keeps every other line', () => {
    const file = parsed(
      '---\nmodel: a/b\n# a comment\ndefaultEffort: low\ncolor: blue\n---\nBody.\n',
    );
    const kept = decoder.decode(
      serializeUpdatedAgentFile('helper', file, { ...BASE, name: 'Named' }) ?? new Uint8Array(),
    );
    expect(parsed(kept).definition).toMatchObject({ name: 'Named', defaultEffort: 'low' });
    expect(kept).toContain('color: blue');
    expect(kept).toContain('# a comment');
  });

  it('does not give a file the key when an update omits it', () => {
    const file = parsed('---\nmodel: a/b\n---\nBody.\n');
    const renamed = decoder.decode(
      serializeUpdatedAgentFile('helper', file, { ...BASE, name: 'Named' }) ?? new Uint8Array(),
    );
    expect(renamed).not.toContain('defaultEffort');
  });

  it('changes a tier the update states, and removes it for null', () => {
    const file = parsed('---\nmodel: a/b\ndefaultEffort: low\n---\nBody.\n');
    const update = (defaultEffort: 'max' | null) =>
      decoder.decode(
        serializeUpdatedAgentFile('helper', file, { ...BASE, defaultEffort }) ?? new Uint8Array(),
      );
    expect(parsed(update('max')).definition.defaultEffort).toBe('max');
    expect(update(null)).not.toContain('defaultEffort');
  });

  it('rewrites nothing when the update states the tier the file has', () => {
    const file = parsed('---\nmodel: a/b\ndefaultEffort: low\n---\nBody.\n');
    expect(
      serializeUpdatedAgentFile('helper', file, { ...BASE, defaultEffort: 'low' }),
    ).toBeUndefined();
  });

  it('says `null` for a definition with none, so a restore removes what the file gained', () => {
    const { definition } = parsed('---\nmodel: a/b\n---\nBody.\n');
    expect(agentFileInputOf(definition).defaultEffort).toBeNull();
  });
});

describe('a stored definition', () => {
  const OLD_SNAPSHOT = {
    name: 'Helper',
    description: null,
    model: KNOWN_MODEL,
    tools: [],
    skillDescriptors: [],
    a2a: false,
    instructions: '',
  };

  it('loads when it was written before the field existed, and keeps a tier when it has one', () => {
    expect(agentFileDefinitionSchema.parse(OLD_SNAPSHOT).defaultEffort).toBeUndefined();
    expect(
      agentFileDefinitionSchema.parse({ ...OLD_SNAPSHOT, defaultEffort: 'high' }).defaultEffort,
    ).toBe('high');
  });

  it('refuses a stored tier that is not one', () => {
    expect(() =>
      agentFileDefinitionSchema.parse({ ...OLD_SNAPSHOT, defaultEffort: 'extreme' }),
    ).toThrow();
  });
});

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  await disposeServed();
});

async function start(generate?: GenerateFunction) {
  const harness = await startFileBureau(
    generate === undefined ? {} : { overrides: { models: { generate: () => generate } } },
  );
  harnesses.push(harness);
  return harness;
}

async function hashOf(harness: FileBureauHarness, id: string): Promise<string> {
  await harness.bureau.agents.refresh();
  const listing = harness.bureau.agents.list().find((agent) => agent.id === id);
  return listing?.definitionHash ?? '';
}

async function definitionOf(bureau: FileBureauHarness['bureau'], id = 'helper') {
  const detail = await bureau.agents.detail(id);
  return detail?.definition;
}

async function modelOf(bureau: FileBureauHarness['bureau']) {
  const definition = await definitionOf(bureau);
  return definition?.model;
}

describe('a write of defaultEffort', () => {
  it('saves a tier the default model supports', async () => {
    const { bureau } = await start();
    await bureau.agents.create('helper', { ...DEFINITION, defaultEffort: 'xhigh' });
    expect(await definitionOf(bureau)).toMatchObject({ defaultEffort: 'xhigh' });
  });

  it('refuses a create for a tier the default model cannot do, naming the model and its tiers', async () => {
    const { bureau, directory } = await start();
    const error = await rejectionOf(
      bureau.agents.create('helper', { ...DEFINITION, model: THREE_TIERS, defaultEffort: 'max' }),
    );
    expect(error).toBeInstanceOf(AgentFileError);
    const refused = error as AgentFileError;
    expect(refused.code).toBe('effort-not-supported');
    expect(refused.message).toContain(THREE_TIERS);
    expect(refused.message).toContain('low, medium, high');
    expect(refused.problem?.issues).toEqual([
      expect.objectContaining({ path: 'defaultEffort', reference: THREE_TIERS }),
    ]);
    expect(await Bun.file(`${directory}/helper.md`).exists()).toBe(false);
  });

  it('refuses any tier for a model with no effort support', async () => {
    const { bureau } = await start();
    const error = await rejectionOf(
      bureau.agents.create('helper', { ...DEFINITION, model: NO_EFFORT, defaultEffort: 'low' }),
    );
    expect((error as AgentFileError).code).toBe('effort-not-supported');
    expect((error as AgentFileError).message).toContain(NO_EFFORT);
  });

  it('saves a file with no tier for a model with no effort support', async () => {
    const { bureau } = await start();
    await bureau.agents.create('helper', { ...DEFINITION, model: NO_EFFORT });
    expect(await modelOf(bureau)).toBe(NO_EFFORT);
  });

  it('refuses an update to an unsupported tier', async () => {
    const harness = await start();
    await harness.bureau.agents.create('helper', { ...DEFINITION, model: THREE_TIERS });
    const error = await rejectionOf(
      harness.bureau.agents.update(
        'helper',
        { ...DEFINITION, model: THREE_TIERS, defaultEffort: 'max' },
        { expectedHash: await hashOf(harness, 'helper') },
      ),
    );
    expect((error as AgentFileError).code).toBe('effort-not-supported');
  });

  it('keeps the tier through an update that omits it, and removes it for null', async () => {
    const harness = await start();
    await harness.bureau.agents.create('helper', { ...DEFINITION, defaultEffort: 'high' });
    const kept = await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, name: 'Renamed' },
      { expectedHash: await hashOf(harness, 'helper') },
    );
    expect(await definitionOf(harness.bureau)).toMatchObject({
      name: 'Renamed',
      defaultEffort: 'high',
    });
    await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, defaultEffort: null },
      { expectedHash: kept.hash },
    );
    expect(await definitionOf(harness.bureau)).not.toHaveProperty('defaultEffort');
  });

  it('refuses an update that switches the model and omits the tier the new model cannot do', async () => {
    const harness = await start();
    await harness.bureau.agents.create('helper', { ...DEFINITION, defaultEffort: 'max' });
    const hash = await hashOf(harness, 'helper');
    const error = await rejectionOf(
      harness.bureau.agents.update(
        'helper',
        { ...DEFINITION, model: THREE_TIERS },
        { expectedHash: hash },
      ),
    );
    expect((error as AgentFileError).code).toBe('effort-not-supported');
    // Naming the tier away lets the same switch save.
    await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, model: THREE_TIERS, defaultEffort: null },
      { expectedHash: hash },
    );
    expect(await modelOf(harness.bureau)).toBe(THREE_TIERS);
  });

  it('refuses a try of an unsupported tier and builds nothing', async () => {
    const { bureau } = await start();
    const error = await rejectionOf(
      bureau.agents.try({ ...DEFINITION, model: NO_EFFORT, defaultEffort: 'high' }, 'hello', {
        principal: OWNER.alice,
      }),
    );
    expect((error as AgentFileError).code).toBe('effort-not-supported');
  });

  it('does not refuse a scan: a file a hand edit left over an unsupported tier is still listed', async () => {
    const harness = await start();
    await harness.put(
      'helper.md',
      agentFileText({ name: 'Helper', model: THREE_TIERS, defaultEffort: 'max' }),
    );
    await harness.bureau.agents.refresh();
    expect(harness.bureau.agents.list().find((agent) => agent.id === 'helper')?.state).toBe(
      'ready',
    );
  });

  it('records the key a save changed in the version', async () => {
    const harness = await start();
    await harness.bureau.agents.create('helper', DEFINITION);
    await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, defaultEffort: 'low' },
      { expectedHash: await hashOf(harness, 'helper') },
    );
    const [latest] = await harness.bureau.agents.versions.list('helper');
    expect(latest?.changedKeys).toEqual(['defaultEffort']);
  });
});

describe('the agent definition operations', () => {
  it('read the tier back, keep it through an update that omits it, and remove it for null', async () => {
    const served = await serve();
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'effortful',
      definition: { ...DEFINITION, defaultEffort: 'high' },
    });
    const effortNow = async () => {
      const read = await callAs(served.owner, 'bureau.agents.definitions.get', {
        id: 'effortful',
      });
      const { definition } = read.result as { definition: { defaultEffort: string | null } };
      return definition.defaultEffort;
    };
    expect(await effortNow()).toBe('high');

    const kept = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'effortful',
      expectedHash: (created.result as { hash: string }).hash,
      definition: { ...DEFINITION, name: 'Renamed' },
    });
    expect(await effortNow()).toBe('high');

    await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'effortful',
      expectedHash: (kept.result as { hash: string }).hash,
      definition: { ...DEFINITION, defaultEffort: null },
    });
    expect(await effortNow()).toBeNull();
  });

  it('carry the tier in each saved version and restore it', async () => {
    const served = await serve();
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'versioned',
      definition: { ...DEFINITION, defaultEffort: 'low' },
    });
    const cleared = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'versioned',
      expectedHash: (created.result as { hash: string }).hash,
      definition: { ...DEFINITION, defaultEffort: null },
    });
    const listed = await callAs(served.owner, 'bureau.agents.versions.list', { id: 'versioned' });
    const versions = (
      listed.result as {
        versions: Array<{ revision: number; definition: { defaultEffort: unknown } }>;
      }
    ).versions;
    expect(versions.map((version) => [version.revision, version.definition.defaultEffort])).toEqual(
      [
        [2, null],
        [1, 'low'],
      ],
    );

    await callAs(served.owner, 'bureau.agents.versions.restore', {
      id: 'versioned',
      revision: 1,
      expectedHash: (cleared.result as { hash: string }).hash,
    });
    const read = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'versioned' });
    expect(
      (read.result as { definition: { defaultEffort: string | null } }).definition.defaultEffort,
    ).toBe('low');
  });

  it('answer null for an agent whose file has none', async () => {
    const served = await serve();
    await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'plain',
      definition: DEFINITION,
    });
    const read = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'plain' });
    expect(
      (read.result as { definition: { defaultEffort: string | null } }).definition.defaultEffort,
    ).toBeNull();
  });

  it('answer Unprocessable for an unsupported tier, naming the reason, and write nothing', async () => {
    const served = await serve();
    const refused = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'refused',
      definition: { ...DEFINITION, model: NO_EFFORT, defaultEffort: 'high' },
    });
    expect(refused.error?.data?.httpStatus).toBe(422);
    expect(refused.error?.data).toMatchObject({ reason: 'effort-not-supported' });
    expect(refused.error?.message).toContain(NO_EFFORT);
  });

  it('refuse a tier that is not one as invalid params', async () => {
    const served = await serve();
    const refused = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'bad',
      definition: { ...DEFINITION, defaultEffort: 'extreme' },
    });
    expect(refused.error?.data?.httpStatus).toBe(400);
  });
});

describe('a chat of an agent with a default effort', () => {
  /** A generate that records the effort each call's steering carried. */
  function recording(): { generate: GenerateFunction; efforts: (string | undefined)[] } {
    const efforts: (string | undefined)[] = [];
    return {
      efforts,
      generate: async (context) => {
        efforts.push(context.steering?.effort);
        return { content: 'done', toolCalls: [] };
      },
    };
  }

  it('starts at the default, as the model is told on its first step', async () => {
    const { generate, efforts } = recording();
    const { bureau } = await start(generate);
    await bureau.agents.create('helper', { ...DEFINITION, defaultEffort: 'high' });
    const run = await bureau.tasks.start('helper', 'go', { principal: OWNER.alice });
    await waitForTaskState(bureau, run.id);
    expect(efforts).toEqual(['high']);
  });

  it('uses the effort the person steered to, and writes the default into no session state', async () => {
    const { generate, efforts } = recording();
    const { bureau } = await start(generate);
    await bureau.agents.create('helper', { ...DEFINITION, defaultEffort: 'high' });
    const first = await bureau.tasks.start('helper', 'go', { principal: OWNER.alice });
    await waitForTaskState(bureau, first.id);
    const steered = await bureau.contexts.steer(first.contextId, {
      id: 'lower',
      principal: OWNER.alice,
      requestedValue: { target: 'effort', override: 'low' },
    });
    expect(steered.outcome).toBe('accepted');
    const second = await bureau.tasks.start('helper', 'again', {
      contextId: first.contextId,
      principal: OWNER.alice,
    });
    await waitForTaskState(bureau, second.id);
    expect(efforts).toEqual(['high', 'low']);
  });

  it('leaves a chat of a file without the field exactly as it was: no effort is sent', async () => {
    const { generate, efforts } = recording();
    const { bureau } = await start(generate);
    await bureau.agents.create('helper', DEFINITION);
    const run = await bureau.tasks.start('helper', 'go', { principal: OWNER.alice });
    await waitForTaskState(bureau, run.id);
    expect(efforts).toEqual([undefined]);
  });
});
