/**
 * COR-1975 — an agent file's `allowedSkills`: what it accepts, how a write keeps it, that a run may
 * activate only what it names, that a skill from a source the host does not trust is refused at
 * activation, and that a write cannot grant one. A file that lists nothing has no skills, as a file
 * agent had none before the key existed.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';

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
  ownerPath,
  serve,
} from './http/management/agent-definitions-fixtures.test-support.ts';
import { discoverSkills, type SkillCatalogRevision } from './skills';
import {
  pollUntil,
  createScheduleFireHarness,
  durableStatus,
} from './schedule-fire-fixtures.test-support';
import {
  letStepsCommit,
  pollForTime,
  removeSkillRoots,
  skillCatalogOnDisk,
  skillsRecorded,
} from './skill-policy-fixtures.test-support';
import { agentFileDirectory } from './sources/agent-file-directory';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { agentFileText, KNOWN_MODEL, lookupTool } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { BureauOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';

const decoder = new TextDecoder();

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

describe('allowedSkills in the frontmatter', () => {
  it('holds the list as written, and a file without the key, or with a null one, has none', () => {
    expect(
      parsed('---\nmodel: a/b\nallowedSkills: [b, a]\n---\n').definition.allowedSkills,
    ).toEqual(['b', 'a']);
    expect(parsed('---\nmodel: a/b\n---\n').definition).not.toHaveProperty('allowedSkills');
    expect(parsed('---\nmodel: a/b\nallowedSkills:\n---\n').definition).not.toHaveProperty(
      'allowedSkills',
    );
  });

  it('keeps an empty list, which grants none and is what the file says', () => {
    expect(parsed('---\nmodel: a/b\nallowedSkills: []\n---\n').definition.allowedSkills).toEqual(
      [],
    );
  });

  it('names the field of a value it refuses', () => {
    expect(issuePaths('allowedSkills: reviewer')).toEqual(['allowedSkills']);
    expect(issuePaths('allowedSkills: [a, a]')).toEqual(['allowedSkills']);
    expect(issuePaths('allowedSkills: [""]')).toEqual(['allowedSkills.0']);
    expect(issuePaths('allowedSkills: [{ id: a }]')).toEqual(['allowedSkills.0']);
  });

  it('does not read the old `skills` list as a grant', () => {
    const file = parsed('---\nmodel: a/b\nskills:\n  - id: reviewer\n---\n');
    expect(file.definition).not.toHaveProperty('allowedSkills');
  });
});

describe('writing allowedSkills', () => {
  const BASE = { model: 'a/b', instructions: 'Body.\n' };

  it('writes a list, an empty list, and no key for no list', () => {
    const text = (allowedSkills: readonly string[] | null | undefined) =>
      decoder.decode(serializeNewAgentFile({ ...BASE, allowedSkills }));
    expect(parsed(text(['a'])).definition.allowedSkills).toEqual(['a']);
    expect(parsed(text([])).definition.allowedSkills).toEqual([]);
    expect(text(null)).not.toContain('allowedSkills');
    expect(text(undefined)).not.toContain('allowedSkills');
  });

  it('keeps the file’s list when an update omits it, and keeps every other line', () => {
    const file = parsed(
      '---\nmodel: a/b\n# a comment\nallowedSkills: [a]\ncolor: blue\n---\nBody.\n',
    );
    const kept = decoder.decode(
      serializeUpdatedAgentFile('helper', file, { ...BASE, name: 'Named' }) ?? new Uint8Array(),
    );
    expect(parsed(kept).definition).toMatchObject({ name: 'Named', allowedSkills: ['a'] });
    expect(kept).toContain('color: blue');
    expect(kept).toContain('# a comment');
  });

  it('does not give a file the key when an update omits it', () => {
    const file = parsed('---\nmodel: a/b\n---\nBody.\n');
    const renamed = decoder.decode(
      serializeUpdatedAgentFile('helper', file, { ...BASE, name: 'Named' }) ?? new Uint8Array(),
    );
    expect(renamed).not.toContain('allowedSkills');
  });

  it('changes a list the update states, empties it, and removes it for null', () => {
    const file = parsed('---\nmodel: a/b\nallowedSkills: [a]\n---\nBody.\n');
    const update = (allowedSkills: readonly string[] | null) =>
      decoder.decode(
        serializeUpdatedAgentFile('helper', file, { ...BASE, allowedSkills }) ?? new Uint8Array(),
      );
    expect(parsed(update(['b'])).definition.allowedSkills).toEqual(['b']);
    expect(parsed(update([])).definition.allowedSkills).toEqual([]);
    expect(update(null)).not.toContain('allowedSkills');
  });

  it('rewrites nothing when the update states the list the file has', () => {
    const file = parsed('---\nmodel: a/b\nallowedSkills: [a]\n---\nBody.\n');
    expect(
      serializeUpdatedAgentFile('helper', file, { ...BASE, allowedSkills: ['a'] }),
    ).toBeUndefined();
  });

  it('treats no list and an empty one as different statements', () => {
    const file = parsed('---\nmodel: a/b\n---\nBody.\n');
    const emptied = serializeUpdatedAgentFile('helper', file, { ...BASE, allowedSkills: [] });
    expect(parsed(decoder.decode(emptied)).definition.allowedSkills).toEqual([]);
  });

  it('says `null` for a definition with none, so a restore removes what the file gained', () => {
    const { definition } = parsed('---\nmodel: a/b\n---\nBody.\n');
    expect(agentFileInputOf(definition).allowedSkills).toBeNull();
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

  it('loads when it was written before the field existed, and keeps a list when it has one', () => {
    expect(agentFileDefinitionSchema.parse(OLD_SNAPSHOT).allowedSkills).toBeUndefined();
    expect(
      agentFileDefinitionSchema.parse({ ...OLD_SNAPSHOT, allowedSkills: ['a'] }).allowedSkills,
    ).toEqual(['a']);
  });
});

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function sourceOf(names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-allowed-skills-'));
  roots.push(root);
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nFollow ${name}.\n`,
    );
  }
  return root;
}

/** `reviewer` and `writer` from a trusted source, `deploy` from one the host does not trust. */
async function catalogOf(
  trusted: readonly string[] = ['reviewer', 'writer'],
  untrusted: readonly string[] = ['deploy'],
): Promise<SkillCatalogRevision> {
  return discoverSkills({
    sources: [
      { id: 'home', kind: 'user', location: await sourceOf(trusted), precedence: 20 },
      { id: 'workspace', kind: 'project', location: await sourceOf(untrusted), precedence: 10 },
    ],
  });
}

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

interface Sighting {
  readonly tools: readonly string[];
  readonly system: string;
  readonly activations: readonly string[];
}

/**
 * A Bureau over `catalog`, whose agents try to activate each of `tries` in their first step and
 * record what they were offered and how each try was answered.
 */
async function start(
  catalog: () => SkillCatalogRevision | undefined,
  tries: readonly string[] = [],
  overrides: Partial<BureauOptions<AgentDefinitions>> = {},
) {
  const seen: Sighting[] = [];
  const generate: GenerateFunction = async ({ step, toolbox, conversation }) => {
    const activations: string[] = [];
    if (step === 0 && toolbox.tools().some((tool) => tool.name === 'activate_skill')) {
      for (const name of tries) {
        const outcome = await toolbox.execute({ name: 'activate_skill', arguments: { name } });
        activations.push(JSON.stringify((outcome as { result: unknown }).result));
      }
    }
    seen.push({
      tools: toolbox.tools().map((tool) => tool.name),
      system: conversation
        .getMessages()
        .filter((message) => message.role === 'system')
        .map((message) => JSON.stringify(message.content))
        .join('\n'),
      activations,
    });
    return { content: 'done', toolCalls: [] };
  };
  const harness = await startFileBureau({
    overrides: {
      agentSkillCatalog: catalog,
      models: { generate: () => generate },
      ...overrides,
    },
  });
  harnesses.push(harness);
  return { ...harness, seen };
}

/** One run of the agent `helper`, to its end. */
async function runOnce(bureau: FileBureauHarness['bureau']): Promise<void> {
  const run = await bureau.tasks.start('helper', 'go');
  await run.result();
}

async function definitionOf(bureau: FileBureauHarness['bureau'], id = 'helper') {
  const detail = await bureau.agents.detail(id);
  return detail?.definition;
}

async function hashOf(harness: FileBureauHarness, id: string): Promise<string> {
  await harness.bureau.agents.refresh();
  const listing = harness.bureau.agents.list().find((agent) => agent.id === id);
  return listing?.definitionHash ?? '';
}

describe('a run of a file agent', () => {
  it('has no skills when the file lists none, as a file agent had none before the key', async () => {
    const catalog = await catalogOf();
    const { bureau, put, seen } = await start(() => catalog);
    await put('helper.md', agentFileText({ model: KNOWN_MODEL }));
    await bureau.agents.refresh();
    await runOnce(bureau);
    expect(seen[0]?.tools).not.toContain('activate_skill');
    expect(seen[0]?.system).not.toContain('reviewer');
  });

  it('has no skills when the list is empty', async () => {
    const catalog = await catalogOf();
    const { bureau, put, seen } = await start(() => catalog);
    await put('helper.md', agentFileText({ model: KNOWN_MODEL, allowedSkills: '[]' }));
    await bureau.agents.refresh();
    await runOnce(bureau);
    expect(seen[0]?.tools).not.toContain('activate_skill');
  });

  it('is offered and activates only what the file names', async () => {
    const catalog = await catalogOf();
    const { bureau, put, seen } = await start(() => catalog, ['reviewer', 'writer']);
    await put('helper.md', agentFileText({ model: KNOWN_MODEL, allowedSkills: '[reviewer]' }));
    await bureau.agents.refresh();
    await runOnce(bureau);

    expect(seen[0]?.tools).toContain('activate_skill');
    expect(seen[0]?.system).toContain('reviewer');
    expect(seen[0]?.system).not.toContain('writer');
    expect(seen[0]?.activations[0]).toContain('reviewer');
    expect(seen[0]?.activations[0]).not.toContain('refusal');
    // Refused as an absent skill is, so a run cannot learn what the deployment holds.
    expect(seen[0]?.activations[1]).toContain('not-in-catalog');
  });

  it('refuses a skill the file names from a source the host does not trust', async () => {
    const catalog = await catalogOf();
    const { bureau, put, seen } = await start(() => catalog, ['deploy']);
    await put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, allowedSkills: '[reviewer, deploy]' }),
    );
    await bureau.agents.refresh();
    expect(bureau.agents.list().find((agent) => agent.id === 'helper')?.state).toBe('ready');
    await runOnce(bureau);

    expect(seen[0]?.system).not.toContain('deploy');
    expect(seen[0]?.activations[0]).toContain('source-untrusted');
  });

  it('reads the catalog per run, so a source trusted later is offered without a new file', async () => {
    let catalog = await catalogOf([], ['reviewer']);
    const { bureau, put, seen } = await start(() => catalog);
    await put('helper.md', agentFileText({ model: KNOWN_MODEL, allowedSkills: '[reviewer]' }));
    await bureau.agents.refresh();
    await runOnce(bureau);
    expect(seen.at(-1)?.tools).not.toContain('activate_skill');

    catalog = await catalogOf(['reviewer'], []);
    await runOnce(bureau);
    expect(seen.at(-1)?.tools).toContain('activate_skill');
  });

  it('runs with no skills while the host has no catalog yet', async () => {
    const { bureau, put, seen } = await start(() => undefined);
    await put('helper.md', agentFileText({ model: KNOWN_MODEL, allowedSkills: '[reviewer]' }));
    await bureau.agents.refresh();
    await runOnce(bureau);
    expect(seen[0]?.tools).not.toContain('activate_skill');
  });

  it('refuses a skill the source stopped being trusted for during the run', async () => {
    let catalog = await catalogOf(['reviewer'], []);
    const revoked = await catalogOf([], ['reviewer']);
    const seen: string[] = [];
    const generate: GenerateFunction = async ({ step, toolbox }) => {
      if (step === 0) {
        catalog = revoked;
        const outcome = await toolbox.execute({
          name: 'activate_skill',
          arguments: { name: 'reviewer' },
        });
        seen.push(JSON.stringify((outcome as { result: unknown }).result));
      }
      return { content: 'done', toolCalls: [] };
    };
    const harness = await start(() => catalog, [], { models: { generate: () => generate } });
    await harness.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, allowedSkills: '[reviewer]' }),
    );
    await harness.bureau.agents.refresh();
    await runOnce(harness.bureau);
    // The current catalog names the skill under another source, so the run's own is gone.
    expect(seen[0]).toContain('not-in-catalog');
  });
});

describe('a write that grants a skill', () => {
  const DEFINITION = { model: KNOWN_MODEL, instructions: 'You are helpful.\n' };

  it('grants a skill the deployment can grant', async () => {
    const catalog = await catalogOf();
    const { bureau } = await start(() => catalog);
    await bureau.agents.create('helper', { ...DEFINITION, allowedSkills: ['reviewer'] });
    const definition = await definitionOf(bureau);
    expect(definition?.allowedSkills).toEqual(['reviewer']);
  });

  it('refuses a skill from a source the host does not trust, and writes nothing', async () => {
    const catalog = await catalogOf();
    const { bureau } = await start(() => catalog);
    const error = await rejectionOf(
      bureau.agents.create('helper', { ...DEFINITION, allowedSkills: ['reviewer', 'deploy'] }),
    );
    expect(error).toBeInstanceOf(AgentFileError);
    const { code, problem, message } = error as AgentFileError;
    expect(code).toBe('skill-not-grantable');
    expect(message).toContain('source-untrusted');
    expect(problem?.issues).toEqual([
      { path: 'allowedSkills.1', message: expect.stringContaining('deploy'), reference: 'deploy' },
    ]);
    expect(await bureau.agents.detail('helper')).toBeUndefined();
  });

  it('refuses a name the catalog lacks, and one when the deployment has no catalog', async () => {
    const catalog = await catalogOf();
    const { bureau } = await start(() => catalog);
    const unknown = await rejectionOf(
      bureau.agents.create('helper', { ...DEFINITION, allowedSkills: ['ghost'] }),
    );
    expect((unknown as AgentFileError).code).toBe('skill-not-grantable');
    expect((unknown as AgentFileError).message).toContain('not in the deployment');

    const none = await start(() => undefined);
    const refused = await rejectionOf(
      none.bureau.agents.create('helper', { ...DEFINITION, allowedSkills: ['reviewer'] }),
    );
    expect((refused as AgentFileError).code).toBe('skill-not-grantable');
  });

  it('grants a name with an available record though a shadowed twin of it is not', async () => {
    const shared = await sourceOf(['reviewer']);
    const twin = await sourceOf(['reviewer']);
    const catalog = await discoverSkills({
      sources: [
        { id: 'home', kind: 'user', location: shared, precedence: 20 },
        { id: 'other', kind: 'user', location: twin, precedence: 10 },
      ],
    });
    expect(catalog.records.some((record) => record.unavailableReason === 'shadowed')).toBe(true);
    const { bureau } = await start(() => catalog);
    await bureau.agents.create('helper', { ...DEFINITION, allowedSkills: ['reviewer'] });
    const definition = await definitionOf(bureau);
    expect(definition?.allowedSkills).toEqual(['reviewer']);
  });

  it('does not refuse an edit for a skill the file already names', async () => {
    const catalog = await catalogOf();
    const harness = await start(() => catalog);
    await harness.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, allowedSkills: '[deploy]' }),
    );
    const hash = await hashOf(harness, 'helper');
    // Omitted, and stated: neither grants anything the file does not already hold.
    const omitted = await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, name: 'Renamed' },
      { expectedHash: hash },
    );
    await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, name: 'Again', allowedSkills: ['deploy'] },
      { expectedHash: omitted.hash },
    );
    expect(await definitionOf(harness.bureau)).toMatchObject({
      name: 'Again',
      allowedSkills: ['deploy'],
    });
  });

  it('refuses an update that adds one beside a skill the file already names', async () => {
    const catalog = await catalogOf();
    const harness = await start(() => catalog);
    await harness.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, allowedSkills: '[reviewer]' }),
    );
    const error = await rejectionOf(
      harness.bureau.agents.update(
        'helper',
        { ...DEFINITION, allowedSkills: ['reviewer', 'deploy'] },
        { expectedHash: await hashOf(harness, 'helper') },
      ),
    );
    expect((error as AgentFileError).code).toBe('skill-not-grantable');
  });

  it('refuses a restore that would grant a skill the source has since lost', async () => {
    let catalog = await catalogOf(['reviewer'], []);
    const harness = await start(() => catalog);
    await harness.bureau.agents.create('helper', { ...DEFINITION, allowedSkills: ['reviewer'] });
    const hash = await hashOf(harness, 'helper');
    await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, allowedSkills: [] },
      { expectedHash: hash },
    );
    catalog = await catalogOf([], ['reviewer']);
    const error = await rejectionOf(
      harness.bureau.agents.versions.restore('helper', 1, {
        expectedHash: await hashOf(harness, 'helper'),
      }),
    );
    expect((error as AgentFileError).code).toBe('skill-not-grantable');
  });

  it('records the key a save changed in the version', async () => {
    const catalog = await catalogOf();
    const harness = await start(() => catalog);
    await harness.bureau.agents.create('helper', DEFINITION);
    await harness.bureau.agents.update(
      'helper',
      { ...DEFINITION, allowedSkills: ['reviewer'] },
      { expectedHash: await hashOf(harness, 'helper') },
    );
    const [latest] = await harness.bureau.agents.versions.list('helper');
    expect(latest?.changedKeys).toEqual(['allowedSkills']);
  });
});

describe('a run of a file agent reattached after its process died', () => {
  const crashes = createScheduleFireHarness();
  afterEach(() => crashes.dispose());
  afterAll(removeSkillRoots);

  /**
   * Step 0 activates `lock`. Step 1 hangs in the first life, the process that dies there, and in the
   * second records the tools it was offered.
   */
  function dyingInStepOne(life: { current: string }, offered: string[]): GenerateFunction {
    return async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
        };
      }
      if (context.step === 1 && life.current === 'first') {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      offered.push(...context.toolbox.tools().map((tool) => tool.name));
      return { content: 'done', toolCalls: [] };
    };
  }

  it('resumes with the skill it had activated, so the skill still narrows the run’s tools', async () => {
    const onDisk = await skillCatalogOnDisk();
    const catalog = await onDisk.discover();
    const directory = await mkdtemp(join(tmpdir(), 'bureau-allowed-skills-agents-'));
    roots.push(directory);
    await writeFile(
      join(directory, 'helper.md'),
      agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]', allowedSkills: '[lock]' }),
    );
    const path = crashes.nextDatabasePath();
    const life = { current: 'first' };
    const offered: string[] = [];
    const open = () =>
      crashes.open({
        storage: crashes.sqliteHandle(path),
        agents: {},
        agentSource: agentFileDirectory(directory, {
          tools: { 'lookup-order': lookupTool },
          watch: false,
        }),
        models: { generate: () => dyingInStepOne(life, offered) },
        agentSkillCatalog: () => catalog,
      });

    const first = await open();
    await first.agents.refresh();
    const run = await first.tasks.start('helper', 'lock', { principal: OWNER.alice });
    await pollForTime(
      async () => ((await skillsRecorded(first, run.contextId)) ? true : undefined),
      'the active skill to be recorded',
    );
    await letStepsCommit();

    life.current = 'second';
    const restarted = await open();
    await pollUntil(
      async () => ((await durableStatus(restarted, run.id)) === 'completed' ? true : undefined),
      'the reattached run to complete',
    );

    expect(offered).toContain('deactivate_skill');
    expect(offered).not.toContain('lookup-order');
  });
});

describe('the agent definition operations', () => {
  afterEach(disposeServed);

  it('read the list back, keep it through an update that omits it, and remove it for null', async () => {
    const catalog = await catalogOf();
    const served = await serve({ overrides: { agentSkillCatalog: () => catalog } });
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'granted',
      definition: { ...DEFINITION, allowedSkills: ['reviewer'] },
    });
    const allowedNow = async () => {
      const read = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'granted' });
      const { definition } = read.result as { definition: { allowedSkills: string[] | null } };
      return definition.allowedSkills;
    };
    expect(await allowedNow()).toEqual(['reviewer']);

    const kept = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'granted',
      expectedHash: (created.result as { hash: string }).hash,
      definition: { ...DEFINITION, name: 'Renamed' },
    });
    expect(await allowedNow()).toEqual(['reviewer']);

    await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'granted',
      expectedHash: (kept.result as { hash: string }).hash,
      definition: { ...DEFINITION, allowedSkills: null },
    });
    expect(await allowedNow()).toBeNull();
  });

  it('answers Unprocessable for an untrusted skill, naming the reason, and writes nothing', async () => {
    const catalog = await catalogOf();
    const served = await serve({ overrides: { agentSkillCatalog: () => catalog } });
    const refused = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'refused',
      definition: { ...DEFINITION, allowedSkills: ['deploy'] },
    });
    expect(refused.error?.data?.httpStatus).toBe(422);
    expect(refused.error?.data).toMatchObject({ reason: 'skill-not-grantable' });
    expect(refused.error?.message).toContain('source-untrusted');
    expect(await Bun.file(ownerPath(served, 'refused')).exists()).toBe(false);
  });

  it('refuses a repeated name as a file’s frontmatter would be', async () => {
    const catalog = await catalogOf();
    const served = await serve({ overrides: { agentSkillCatalog: () => catalog } });
    const refused = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'repeated',
      definition: { ...DEFINITION, allowedSkills: ['reviewer', 'reviewer'] },
    });
    expect(refused.error?.data?.httpStatus).toBe(400);
  });
});
