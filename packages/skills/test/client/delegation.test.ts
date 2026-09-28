import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemArtifactLoader } from '../../src/client/artifact-loader';
import { createSkillClientToolbox } from '../../src/client/client-toolbox';
import { createSkillClient, type SkillClient } from '../../src/client/skill-client';
import { discoverSkills } from '../../src/discovery/discover';
import type { SkillSource, SkillTrustPolicy } from '../../src/discovery/source';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-delegation-'));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string, allowedTools?: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Description for ${name}`,
      ...(allowedTools === undefined ? [] : [`allowed-tools: ${allowedTools}`]),
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
  );
}

const trustEverything: SkillTrustPolicy = {
  decide: () => ({ state: 'trusted', reason: 'test policy' }),
};

const now = (): string => '2026-09-19T00:00:00.000Z';

async function clientFor(root: string, sources?: readonly SkillSource[]): Promise<SkillClient> {
  const catalog = await discoverSkills({
    sources: sources ?? [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
    trustPolicy: trustEverything,
    now,
  });
  return createSkillClient({ catalog, loadArtifact: createFilesystemArtifactLoader(), now });
}

describe('delegation attenuation', () => {
  it('narrows a child to the granted skills', async () => {
    const root = await scratch();
    await writeSkill(root, 'shared');
    await writeSkill(root, 'parent-only');

    const parent = await clientFor(root);
    const child = parent.attenuate({ skills: ['shared'] });

    expect(
      parent
        .offered()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['parent-only', 'shared']);
    expect(child.offered().map((entry) => entry.name)).toEqual(['shared']);
  });

  it('refuses a skill outside the grant with a typed refusal', async () => {
    const root = await scratch();
    await writeSkill(root, 'shared');
    await writeSkill(root, 'parent-only');

    const parent = await clientFor(root);
    const child = parent.attenuate({ skills: ['shared'] });
    const outcome = await child.activate('parent-only');

    expect(outcome.activated).toBe(false);
    if (outcome.activated) return;
    expect(outcome.refusal).toBe('not-delegated');
  });

  it('cannot conjure a skill the parent could not use', async () => {
    const root = await scratch();
    await writeSkill(root, 'real');

    const parent = await clientFor(root);
    // A grant naming something the parent has no access to grants nothing: delegation attenuates,
    // it never acquires authority by going one level down.
    const child = parent.attenuate({ skills: ['real', 'imaginary'] });

    expect(child.offered().map((entry) => entry.name)).toEqual(['real']);
    const outcome = await child.activate('imaginary');
    expect(outcome.activated).toBe(false);
  });

  it('cannot reach a skill the parent itself was refused', async () => {
    const trusted = await scratch();
    const untrusted = await scratch();
    await writeSkill(trusted, 'allowed');
    await writeSkill(untrusted, 'forbidden');

    const catalog = await discoverSkills({
      sources: [
        { id: 'user', kind: 'user', location: trusted, precedence: 20 },
        { id: 'project', kind: 'project', location: untrusted, precedence: 10 },
      ],
      trustPolicy: {
        decide: (source) => (source.id === 'user' ? { state: 'trusted', reason: 'ok' } : undefined),
      },
      now,
    });
    const parent = createSkillClient({
      catalog,
      loadArtifact: createFilesystemArtifactLoader(),
      now,
    });

    const child = parent.attenuate({ skills: ['allowed', 'forbidden'] });

    expect(child.offered().map((entry) => entry.name)).toEqual(['allowed']);
    const outcome = await child.activate('forbidden');
    expect(outcome.activated).toBe(false);
    if (outcome.activated) return;
    expect(outcome.refusal).toBe('not-delegated');
  });

  it('passes the parent availability through when no skills are named', async () => {
    const root = await scratch();
    await writeSkill(root, 'one');
    await writeSkill(root, 'two');

    const parent = await clientFor(root);
    const child = parent.attenuate({});
    expect(
      child
        .offered()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['one', 'two']);
  });

  it('grants nothing for an empty skill list, which is not the same as omitting it', async () => {
    const root = await scratch();
    await writeSkill(root, 'one');

    const parentClient = await clientFor(root);
    const child = parentClient.attenuate({ skills: [] });
    expect(child.offered()).toEqual([]);
    // And with nothing offered, the child gets no skill tools at all.
    expect(createSkillClientToolbox(child)).toBeUndefined();
  });

  it('intersects tool requests with the grant rather than taking either alone', async () => {
    const root = await scratch();
    await writeSkill(root, 'narrowing', 'Read Write Bash');

    const parent = await clientFor(root);
    const child = parent.attenuate({ skills: ['narrowing'], tools: ['Read', 'Bash', 'Deploy'] });

    await child.activate('narrowing');

    // `Write` is dropped because the grant omits it; `Deploy` is dropped because the skill did not
    // ask for it. A skill cannot acquire a tool by being delegated one.
    expect(child.narrowedTools()).toEqual(['Read', 'Bash']);
  });

  it('applies the grant even when no active skill asked for tools', async () => {
    const root = await scratch();
    await writeSkill(root, 'silent');

    const parentClient = await clientFor(root);
    const child = parentClient.attenuate({ skills: ['silent'], tools: ['Read'] });
    await child.activate('silent');

    expect(child.narrowedTools()).toEqual(['Read']);
  });

  it('keeps the child active set separate from the parent', async () => {
    const root = await scratch();
    await writeSkill(root, 'shared');

    const parent = await clientFor(root);
    const child = parent.attenuate({ skills: ['shared'] });

    await child.activate('shared');

    // A parent's context is not a child's, and vice versa.
    expect(child.active().map((entry) => entry.record.name)).toEqual(['shared']);
    expect(parent.active()).toEqual([]);
  });

  it('composes so a grandchild narrows further and never widens back', async () => {
    const root = await scratch();
    await writeSkill(root, 'a', 'Read Write');
    await writeSkill(root, 'b');

    const parent = await clientFor(root);
    const child = parent.attenuate({ skills: ['a', 'b'], tools: ['Read', 'Write'] });
    const grandchild = child.attenuate({ skills: ['a', 'b'], tools: ['Read', 'Deploy'] });

    expect(
      grandchild
        .offered()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['a', 'b']);

    await grandchild.activate('a');
    // `Deploy` cannot come back at the third level just because the grandchild asked for it.
    expect(grandchild.narrowedTools()).toEqual(['Read']);

    const widened = grandchild.attenuate({ skills: ['a', 'b', 'imaginary'] });
    expect(
      widened
        .offered()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['a', 'b']);
  });
});

describe('an empty admitted catalog exposes no skill tools', () => {
  it('returns no toolbox when nothing is available', async () => {
    const root = await scratch();
    await writeSkill(root, 'untrusted-skill');

    const catalog = await discoverSkills({
      sources: [{ id: 'project', kind: 'project', location: root, precedence: 10 }],
      now,
    });
    const client = createSkillClient({
      catalog,
      loadArtifact: createFilesystemArtifactLoader(),
      now,
    });

    // A model handed `activate_skill` against an empty catalog wastes a turn discovering nothing
    // exists, and sometimes invents a plausible name to pass it.
    expect(client.offered()).toEqual([]);
    expect(createSkillClientToolbox(client)).toBeUndefined();
  });

  it('returns a toolbox as soon as one skill is available', async () => {
    const root = await scratch();
    await writeSkill(root, 'available');

    const client = await clientFor(root);
    const toolbox = createSkillClientToolbox(client);
    expect(toolbox).toBeDefined();
    expect(toolbox?.activateSkill.name).toBe('activate_skill');
    expect(toolbox?.deactivateSkill.name).toBe('deactivate_skill');
    expect(toolbox?.loadSkillResource.name).toBe('load_skill_resource');
  });

  it('returns a promise with the same deactivation success and failure responses', async () => {
    const root = await scratch();
    await writeSkill(root, 'available');
    const client = await clientFor(root);
    const toolbox = createSkillClientToolbox(client);
    await client.activate('available');

    const success = toolbox!.deactivateSkill.execute({ name: 'available' });
    expect(success).toBeInstanceOf(Promise);
    expect(await success).toEqual({ deactivated: true, name: 'available' });

    const failure = toolbox!.deactivateSkill.execute({ name: 'available' });
    expect(failure).toBeInstanceOf(Promise);
    expect(await failure).toEqual({ error: 'Skill is not active', name: 'available' });
  });

  it('refuses an unlisted name through the tool without naming what exists', async () => {
    const root = await scratch();
    await writeSkill(root, 'real-skill');

    const client = await clientFor(root);
    const toolbox = createSkillClientToolbox(client);
    const result = await toolbox!.activateSkill.execute({ name: 'invented' });

    expect(JSON.stringify(result)).toContain('not-in-catalog');
    expect(JSON.stringify(result)).not.toContain('real-skill');
  });
});
