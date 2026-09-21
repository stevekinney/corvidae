import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TypedEventTarget } from '@lostgradient/lifecycle';

import type { SkillAdmissionPolicy } from '../../src/admission';
import { createFilesystemArtifactLoader } from '../../src/client/artifact-loader';
import { createSkillClientToolbox } from '../../src/client/client-toolbox';
import { createSkillClient, type SkillClient } from '../../src/client/skill-client';
import { discoverSkills } from '../../src/discovery/discover';
import type { SkillTrustPolicy } from '../../src/discovery/source';
import { SkillRejectedEvent, type SkillEventMap } from '../../src/events';

const now = (): string => '2026-09-19T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootWith(names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-admission-'));
  roots.push(root);
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, 'SKILL.md'),
      ['---', `name: ${name}`, `description: Description for ${name}`, '---', '', 'Body.', ''].join(
        '\n',
      ),
    );
  }
  return root;
}

const trustEverything: SkillTrustPolicy = {
  decide: () => ({ state: 'trusted', reason: 'test policy' }),
};

async function clientWith(
  admissionPolicy: SkillAdmissionPolicy | undefined,
  names: readonly string[],
  events?: TypedEventTarget<SkillEventMap>,
): Promise<SkillClient> {
  const root = await rootWith(names);
  const catalog = await discoverSkills({
    sources: [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
    trustPolicy: trustEverything,
    now,
  });
  return createSkillClient({
    catalog,
    loadArtifact: createFilesystemArtifactLoader(),
    now,
    ...(admissionPolicy === undefined ? {} : { admissionPolicy }),
    ...(events === undefined ? {} : { events }),
  });
}

describe('the admission policy is the deployment’s answer, not the catalog’s', () => {
  it('refuses a perfectly trustworthy skill the deployment does not permit', async () => {
    const client = await clientWith({ denyList: ['restricted'] }, ['restricted']);

    // The catalog admitted it: trusted source, conformant, available. Admission is a separate
    // question and answers no.
    expect(client.catalog().records[0]?.available).toBe(true);
    const outcome = await client.activate('restricted');
    expect(outcome.activated).toBe(false);
  });

  it('omits a refused skill from the tier-one catalog entirely', async () => {
    const client = await clientWith({ denyList: ['restricted'] }, ['restricted', 'permitted']);

    // Gating activation alone is not enough: a name listed in tier one has already told the model
    // the skill exists, whatever the activation tool then says about it.
    expect(client.offered().map((entry) => entry.name)).toEqual(['permitted']);
  });

  it('treats an allow list as exhaustive', async () => {
    const client = await clientWith({ allowList: ['permitted'] }, ['permitted', 'other']);

    expect(client.offered().map((entry) => entry.name)).toEqual(['permitted']);
    const refused = await client.activate('other');
    expect(refused.activated).toBe(false);
    const admitted = await client.activate('permitted');
    expect(admitted.activated).toBe(true);
  });

  it('lets deny win over allow for a name on both lists', async () => {
    const client = await clientWith({ allowList: ['both'], denyList: ['both'] }, ['both']);

    // The deny list is the more restrictive statement; admitting the name would honour the weaker
    // half of the policy's own configuration.
    expect(client.offered()).toEqual([]);
  });
});

describe('a refusal is not an existence oracle', () => {
  it('answers a denied name exactly as it answers an absent one', async () => {
    const client = await clientWith({ denyList: ['restricted'] }, ['restricted']);

    const denied = await client.activate('restricted');
    const absent = await client.activate('never-existed');

    // Identical but for the caller's own echoed name, which tells it nothing it did not just
    // supply. A model that could read the difference between "you may not have this" and "this
    // does not exist" could probe names to enumerate the operator's configuration.
    expect(JSON.stringify(denied).replaceAll('restricted', 'NAME')).toBe(
      JSON.stringify(absent).replaceAll('never-existed', 'NAME'),
    );
  });

  it('answers identically through the model-facing tool, too', async () => {
    const client = await clientWith({ denyList: ['restricted'] }, ['restricted', 'permitted']);
    const toolbox = createSkillClientToolbox(client);

    const denied = await toolbox!.activateSkill.execute({ name: 'restricted' });
    const absent = await toolbox!.activateSkill.execute({ name: 'never-existed' });

    expect(JSON.stringify(denied).replaceAll('restricted', 'X')).toBe(
      JSON.stringify(absent).replaceAll('never-existed', 'X'),
    );
    expect(JSON.stringify(denied)).not.toContain('permitted');
  });

  it('checks admission before availability, so an untrusted denied skill reads as absent', async () => {
    const root = await rootWith(['restricted']);
    // No trust policy: a project source is untrusted by default, so the record is unavailable.
    const untrusted = await discoverSkills({
      sources: [{ id: 'project', kind: 'project', location: root, precedence: 10 }],
      now,
    });
    expect(untrusted.records[0]?.available).toBe(false);

    const client = createSkillClient({
      catalog: untrusted,
      loadArtifact: createFilesystemArtifactLoader(),
      admissionPolicy: { denyList: ['restricted'] },
      now,
    });

    // Were availability consulted first, this would refuse with `source-untrusted` and name a
    // reason the deployment already decided the caller may not learn.
    const outcome = await client.activate('restricted');
    expect(outcome.activated).toBe(false);
    if (outcome.activated) return;
    expect(outcome.refusal).toBe('not-in-catalog');
  });
});

describe('the host still learns which rule fired', () => {
  it('carries the admission rule on the rejection event', async () => {
    const events = new TypedEventTarget<SkillEventMap>();
    const seen: SkillRejectedEvent[] = [];
    events.addEventListener(SkillRejectedEvent.type, (event) => seen.push(event));

    const client = await clientWith({ denyList: ['restricted'] }, ['restricted'], events);
    await client.activate('restricted');

    // The split the refusal makes possible: the model learns nothing, the host learns everything.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('ownership-policy');
    expect(seen[0]?.rule).toBe('deny-list');
    expect(seen[0]?.skillName).toBe('restricted');
  });

  it('distinguishes an allow-list refusal from a deny-list one', async () => {
    const events = new TypedEventTarget<SkillEventMap>();
    const seen: SkillRejectedEvent[] = [];
    events.addEventListener(SkillRejectedEvent.type, (event) => seen.push(event));

    const client = await clientWith({ allowList: ['permitted'] }, ['permitted', 'other'], events);
    await client.activate('other');

    expect(seen[0]?.rule).toBe('allow-list');
  });

  it('reports a refused skill to the host with its rule, rather than hiding it', async () => {
    const client = await clientWith({ denyList: ['restricted'] }, ['restricted']);

    // An operator asking "why can this run not use that skill" needs the answer; the model does not.
    const entry = client.report().find((line) => line.name === 'restricted');
    expect(entry?.standing).toBe('not-permitted');
    expect(entry?.admissionRule).toBe('deny-list');
  });

  it('names the rule without disclosing the policy’s contents', async () => {
    const client = await clientWith(
      { denyList: ['restricted', 'also-restricted', 'secret-skill'] },
      ['restricted'],
    );

    // The identity of the rule, never its membership: a report that listed the deny list would
    // disclose skills the deployment deliberately never mentions.
    expect(JSON.stringify(client.report())).not.toContain('secret-skill');
  });
});

describe('admission composes with delegation', () => {
  it('keeps a child from reaching a skill the deployment refuses the parent', async () => {
    const parent = await clientWith({ denyList: ['restricted'] }, ['restricted', 'permitted']);
    const child = parent.attenuate({ skills: ['restricted', 'permitted'] });

    // Delegation attenuates; it cannot grant what the deployment withheld from the parent.
    expect(child.offered().map((entry) => entry.name)).toEqual(['permitted']);
    const outcome = await child.activate('restricted');
    expect(outcome.activated).toBe(false);
  });

  it('exposes no tools at all when admission empties the catalog', async () => {
    const client = await clientWith({ denyList: ['only-skill'] }, ['only-skill']);

    expect(client.offered()).toEqual([]);
    expect(createSkillClientToolbox(client)).toBeUndefined();
  });
});
