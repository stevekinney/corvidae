import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  availableRecords,
  findRecord,
  generalCatalogProjection,
} from '../../src/discovery/catalog';
import { discoverSkills } from '../../src/discovery/discover';
import {
  admitSources,
  defaultSkillSources,
  defaultTrustForKind,
  resolveTrust,
  type SkillSource,
  type SkillTrustPolicy,
} from '../../src/discovery/source';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-discovery-'));
  roots.push(root);
  return root;
}

function skillMarkdown(name: string, description = `Description for ${name}`): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', 'Body.', ''].join('\n');
}

async function writeSkill(
  root: string,
  name: string,
  options?: { body?: string; description?: string },
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    skillMarkdown(name, options?.description ?? `Description for ${name}`),
  );
  if (options?.body !== undefined) {
    await mkdir(join(directory, 'references'), { recursive: true });
    await writeFile(join(directory, 'references', 'extra.md'), options.body);
  }
  return directory;
}

function source(id: string, location: string, overrides?: Partial<SkillSource>): SkillSource {
  return { id, kind: 'user', location, precedence: 20, ...overrides };
}

const trustEverything: SkillTrustPolicy = {
  decide: () => ({ state: 'trusted', reason: 'test policy' }),
};

const now = (): string => '2026-09-19T00:00:00.000Z';

describe('discoverSkills', () => {
  it('builds a catalog entry carrying provenance, trust, digest and compatibility', async () => {
    const root = await scratch();
    await writeSkill(root, 'code-review');

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    const record = findRecord(revision, 'code-review');
    expect(record?.sourceId).toBe('user');
    expect(record?.sourceKind).toBe('user');
    expect(record?.sourceLocation).toBe(root);
    expect(record?.trust).toBe('trusted');
    expect(record?.bundleSupport).toBe('complete');
    expect(record?.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record?.compatibility.conformant).toBe(true);
    expect(record?.available).toBe(true);
    expect(revision.outcome).toBe('completed');
  });

  it('is deterministic regardless of the order sources are configured in', async () => {
    const projectRoot = await scratch();
    const userRoot = await scratch();
    await writeSkill(projectRoot, 'shared', { description: 'Project copy.' });
    await writeSkill(userRoot, 'shared', { description: 'User copy.' });
    await writeSkill(userRoot, 'user-only');

    const sources = [
      source('project', projectRoot, { kind: 'project', precedence: 10 }),
      source('user', userRoot),
    ];

    const forward = await discoverSkills({ sources, trustPolicy: trustEverything, now });
    const reversed = await discoverSkills({
      sources: sources.toReversed(),
      trustPolicy: trustEverything,
      now,
    });

    // Precedence lives on the source, not on the array, so reordering configuration cannot
    // silently change which skill shadows which.
    expect(forward.digest).toBe(reversed.digest);
    expect(
      forward.records.map((record) => [record.name, record.sourceId, record.available]),
    ).toEqual(reversed.records.map((record) => [record.name, record.sourceId, record.available]));
  });

  it('resolves a name collision by precedence and keeps the loser, marked', async () => {
    const projectRoot = await scratch();
    const userRoot = await scratch();
    await writeSkill(projectRoot, 'shared', { description: 'Project copy.' });
    await writeSkill(userRoot, 'shared', { description: 'User copy.' });

    const revision = await discoverSkills({
      sources: [
        source('project', projectRoot, { kind: 'project', precedence: 10 }),
        source('user', userRoot),
      ],
      trustPolicy: trustEverything,
      now,
    });

    const shared = revision.records.filter((record) => record.name === 'shared');
    expect(shared).toHaveLength(2);

    const winner = shared.find((record) => record.available);
    const loser = shared.find((record) => !record.available);

    expect(winner?.sourceId).toBe('project');
    // The loser stays in the catalog rather than vanishing: an operator asking "why is my project
    // skill not the one running" needs to see both entries.
    expect(loser?.sourceId).toBe('user');
    expect(loser?.unavailableReason).toBe('shadowed');
    expect(loser?.shadowedBy).toBe('project');
  });

  it('shadows an identical duplicate without treating it as a conflict', async () => {
    const first = await scratch();
    const second = await scratch();
    await writeSkill(first, 'twin');
    await writeSkill(second, 'twin');

    const revision = await discoverSkills({
      sources: [source('a', first, { precedence: 10 }), source('b', second, { precedence: 20 })],
      trustPolicy: trustEverything,
      now,
    });

    const twins = revision.records.filter((record) => record.name === 'twin');
    // Same skill reached through two sources: identical digests, so this is a fact rather than a
    // disagreement, and no source diagnostic is raised.
    expect(twins[0]?.artifactDigest).toBe(twins[1]?.artifactDigest);
    expect(revision.sourceDiagnostics).toEqual([]);
  });

  it('leaves a project skill unavailable until its source is admitted', async () => {
    const projectRoot = await scratch();
    await writeSkill(projectRoot, 'workspace-skill');

    const sources = [source('project', projectRoot, { kind: 'project', precedence: 10 })];

    const untrusted = await discoverSkills({ sources, now });

    // Present, so a host can offer "this workspace has skills, trust it?" — but never available.
    // Opening a repository must not be the same act as letting its files instruct a model.
    const record = findRecord(untrusted, 'workspace-skill');
    expect(record).toBeDefined();
    expect(record?.available).toBe(false);
    expect(record?.unavailableReason).toBe('source-untrusted');
    expect(availableRecords(untrusted)).toEqual([]);
    expect(untrusted.sourceDiagnostics.map((diagnostic) => diagnostic.code)).toContain('untrusted');

    const admitted = await discoverSkills({
      sources,
      trustPolicy: admitSources(['project']),
      now,
    });
    expect(findRecord(admitted, 'workspace-skill')?.available).toBe(true);
  });

  it('marks a revoked source distinctly from a merely untrusted one', async () => {
    const root = await scratch();
    await writeSkill(root, 'revoked-skill');

    const revision = await discoverSkills({
      sources: [source('revoked', root)],
      trustPolicy: { decide: () => ({ state: 'revoked', reason: 'withdrawn by the operator' }) },
      now,
    });

    expect(findRecord(revision, 'revoked-skill')?.unavailableReason).toBe('source-revoked');
    expect(revision.sourceDiagnostics.map((diagnostic) => diagnostic.code)).toContain('revoked');
  });

  it('records an unavailable root without failing the pass', async () => {
    const root = await scratch();
    await writeSkill(root, 'present');

    const revision = await discoverSkills({
      sources: [source('present', root), source('missing', join(root, 'nope'))],
      trustPolicy: trustEverything,
      now,
    });

    expect(revision.outcome).toBe('completed');
    expect(findRecord(revision, 'present')?.available).toBe(true);
    expect(revision.sourceDiagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unavailable',
    );
  });

  it('catalogues a non-portable skill as unconformant but usable', async () => {
    const root = await scratch();
    const directory = join(root, 'client-fields');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      [
        '---',
        'name: client-fields',
        'description: Carries a key the specification does not define.',
        'when_to_use: whenever',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    const record = findRecord(revision, 'client-fields');
    // The verdict lives on the entry. It costs portability and confers no authority, so the skill
    // stays available and the diagnostic stays attached to it.
    expect(record?.available).toBe(true);
    expect(record?.compatibility.conformant).toBe(false);
    expect(record?.compatibility.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unexpected-field',
    );
  });

  it('marks a skill with no usable identity unavailable', async () => {
    const root = await scratch();
    const directory = join(root, 'broken');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      ['---', 'name: Not_Valid', 'description: A skill.', '---', '', 'Body.'].join('\n'),
    );

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    const record = revision.records[0];
    expect(record?.available).toBe(false);
    expect(record?.unavailableReason).toBe('invalid');
  });

  it('refuses a skill whose bundle escapes its directory, and keeps scanning', async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeFile(join(outside, 'secrets.txt'), 'do not read me');
    const directory = await writeSkill(root, 'escaping');
    await symlink(join(outside, 'secrets.txt'), join(directory, 'stolen.txt'));
    await writeSkill(root, 'innocent');

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    expect(findRecord(revision, 'escaping')).toBeUndefined();
    expect(findRecord(revision, 'innocent')?.available).toBe(true);
    const diagnostic = revision.sourceDiagnostics.find(
      (entry) => entry.code === 'admission-failed',
    );
    expect(diagnostic?.admission?.map((entry) => entry.code)).toContain('symlink-escape');
  });

  it('carries a source that can only serve SKILL.md as manifest-only', async () => {
    const root = await scratch();
    await writeSkill(root, 'partial');

    const revision = await discoverSkills({
      sources: [source('partial-source', root, { bundleSupport: 'manifest-only' })],
      trustPolicy: trustEverything,
      now,
    });

    // A source declares what it can actually deliver. Claiming complete bundle support here would
    // promise resources no resource load could ever return.
    expect(findRecord(revision, 'partial')?.bundleSupport).toBe('manifest-only');
  });

  it('produces a revision when cancelled rather than throwing', async () => {
    const root = await scratch();
    await writeSkill(root, 'first');
    await writeSkill(root, 'second');

    const controller = new AbortController();
    controller.abort();

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      signal: controller.signal,
      now,
    });

    // A caller that aborted still wants to know what was found; a rejected promise would throw
    // that away.
    expect(revision.outcome).toBe('cancelled');
    expect(revision.sourceDiagnostics.map((diagnostic) => diagnostic.code)).toContain('cancelled');
  });

  it('stops at the next skill boundary when aborted mid-pass', async () => {
    const root = await scratch();
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) await writeSkill(root, name);

    const controller = new AbortController();
    let seen = 0;
    const countingPolicy: SkillTrustPolicy = {
      decide: () => {
        seen += 1;
        return { state: 'trusted', reason: 'test policy' };
      },
    };

    // Abort at a named barrier: after the source is admitted but while its skills are being read.
    queueMicrotask(() => controller.abort());

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: countingPolicy,
      signal: controller.signal,
      now,
    });

    expect(seen).toBe(1);
    expect(revision.outcome).toBe('cancelled');
    expect(revision.records.length).toBeLessThan(4);
  });

  it('digests equal catalogs equally and different ones differently', async () => {
    const root = await scratch();
    await writeSkill(root, 'stable');

    const first = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });
    const second = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });
    expect(first.digest).toBe(second.digest);

    await writeSkill(root, 'added');
    const third = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });
    expect(third.digest).not.toBe(first.digest);
  });

  it('freezes the revision it returns, all the way down', async () => {
    const root = await scratch();
    await writeSkill(root, 'frozen');

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    // `discoverSkills` is exported, and feeding its result back in as a catalog's `initial` is the
    // natural way to produce a revision — so asserting only the two outer levels left the
    // immutability guarantee with a hole in exactly the shape of its intended use.
    const record = revision.records[0]!;
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.records)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.compatibility)).toBe(true);
    expect(Object.isFrozen(record.compatibility.diagnostics)).toBe(true);
    expect(Object.isFrozen(revision.sourceDiagnostics)).toBe(true);
  });

  it('stops enumerating a large root as soon as the signal aborts', async () => {
    const root = await scratch();
    // Enough entries that a scan which only checks the signal between sources would visit all of
    // them before noticing.
    for (let index = 0; index < 400; index++) {
      await writeSkill(root, `skill-${String(index).padStart(3, '0')}`);
    }

    const controller = new AbortController();
    let resolvedTrust = 0;
    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: {
        decide: () => {
          resolvedTrust += 1;
          // Aborts while the root is still being enumerated.
          controller.abort();
          return { state: 'trusted', reason: 'test policy' };
        },
      },
      signal: controller.signal,
      now,
    });

    expect(resolvedTrust).toBe(1);
    expect(revision.outcome).toBe('cancelled');

    // Enumeration is the slow part a caller wants to cancel, and honouring the signal only between
    // sources left a single large root unresponsive for its whole duration. The source-scoped
    // diagnostic is what makes that observable: without the in-enumeration check the pass still
    // ends `cancelled` with no records, so a test asserting only those two things passes against
    // an unresponsive scan.
    const stopped = revision.sourceDiagnostics.find(
      (entry) => entry.code === 'cancelled' && entry.sourceId === 'user',
    );
    expect(stopped?.message).toMatch(/stopped after \d+ entries/u);
    expect(revision.records).toEqual([]);
  });

  it('emits a diagnostic for a real name conflict but not for an identical duplicate', async () => {
    const first = await scratch();
    const second = await scratch();
    await writeSkill(first, 'conflicted', { description: 'One body.' });
    await writeSkill(second, 'conflicted', { description: 'A different body.' });

    const conflicting = await discoverSkills({
      sources: [source('a', first, { precedence: 10 }), source('b', second, { precedence: 20 })],
      trustPolicy: trustEverything,
      now,
    });

    // Different content under one name is a real disagreement, and the operator is told which
    // source won. Asserting only that identical duplicates are quiet proved nothing while no
    // conflict ever produced a diagnostic either.
    const conflict = conflicting.sourceDiagnostics.find((entry) => entry.sourceId === 'b');
    expect(conflict?.message).toContain('takes precedence');

    const identicalFirst = await scratch();
    const identicalSecond = await scratch();
    await writeSkill(identicalFirst, 'twin');
    await writeSkill(identicalSecond, 'twin');

    const identical = await discoverSkills({
      sources: [
        source('a', identicalFirst, { precedence: 10 }),
        source('b', identicalSecond, { precedence: 20 }),
      ],
      trustPolicy: trustEverything,
      now,
    });

    expect(identical.sourceDiagnostics).toEqual([]);
  });

  it('refuses a skill directory that is itself a symbolic link out of the root', async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeSkill(outside, 'leaked', { description: 'Content from outside the root.' });
    await symlink(join(outside, 'leaked'), join(root, 'leaked'));
    await writeSkill(root, 'legitimate');

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    // The walk used to `stat` here, which follows the link — and because the artifact reader
    // canonicalizes the path it is given, containment was then enforced relative to the link's
    // *target*. The skill was read in full and catalogued as living at the configured root.
    expect(findRecord(revision, 'leaked')).toBeUndefined();
    expect(findRecord(revision, 'legitimate')?.available).toBe(true);
    expect(revision.sourceDiagnostics.some((entry) => entry.code === 'containment-refused')).toBe(
      true,
    );
  });

  it('changes its digest when a field the catalog exposes changes', async () => {
    const original = await scratch();
    await writeSkill(original, 'moved');

    const before = await discoverSkills({
      sources: [source('user', original)],
      trustPolicy: trustEverything,
      now,
    });

    // Same content, different location and bundle support. A digest blind to these reported
    // `unchanged` for ever, so the catalog served a stale location permanently.
    const relocated = await scratch();
    await writeSkill(relocated, 'moved');
    const after = await discoverSkills({
      sources: [source('user', relocated, { bundleSupport: 'manifest-only' })],
      trustPolicy: trustEverything,
      now,
    });

    expect(after.digest).not.toBe(before.digest);
  });

  it('changes its digest when a source starts failing, even holding no skills', async () => {
    const root = await scratch();

    const healthy = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });
    const broken = await discoverSkills({
      sources: [source('user', join(root, 'gone'))],
      trustPolicy: trustEverything,
      now,
    });

    expect(healthy.records).toEqual([]);
    expect(broken.records).toEqual([]);
    expect(broken.digest).not.toBe(healthy.digest);
  });

  it('reports a duplicate source id rather than silently conflating two roots', async () => {
    const first = await scratch();
    const second = await scratch();
    await writeSkill(first, 'one');
    await writeSkill(second, 'two');

    const revision = await discoverSkills({
      sources: [
        source('same', first, { precedence: 10 }),
        source('same', second, { precedence: 20 }),
      ],
      trustPolicy: trustEverything,
      now,
    });

    expect(
      revision.sourceDiagnostics.some((entry) => entry.message.includes('more than once')),
    ).toBe(true);
  });

  it('counts admitted skill directories against the limit, not stray files', async () => {
    const root = await scratch();
    for (const index of [0, 1, 2]) await writeFile(join(root, `noise-${index}.txt`), 'x');
    await writeSkill(root, 'real-skill');

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      maximumSkillsPerSource: 2,
      now,
    });

    // `noise-*.txt` sorts before `real-skill`. Slicing raw entries first hid every real skill
    // behind stray files.
    expect(findRecord(revision, 'real-skill')?.available).toBe(true);
  });
});

describe('the general catalog projection', () => {
  it('exposes only name and description', async () => {
    const root = await scratch();
    await writeSkill(root, 'projected');

    const revision = await discoverSkills({
      sources: [source('user', root)],
      trustPolicy: trustEverything,
      now,
    });

    // Built by omission rather than redaction: a projection that deleted fields would leak every
    // field someone later added and forgot to delete here.
    expect(generalCatalogProjection(revision)).toEqual([
      { name: 'projected', description: 'Description for projected' },
    ]);
  });

  it('omits an unavailable skill entirely', async () => {
    const projectRoot = await scratch();
    await writeSkill(projectRoot, 'workspace-skill');

    const revision = await discoverSkills({
      sources: [source('project', projectRoot, { kind: 'project', precedence: 10 })],
      now,
    });

    expect(generalCatalogProjection(revision)).toEqual([]);
  });
});

describe('default sources and trust', () => {
  it('names the specification root and keeps the compatibility root opt-in', () => {
    const sources = defaultSkillSources({
      projectRoot: '/workspace',
      homeDirectory: '/home/person',
    });

    expect(sources.map((entry) => entry.location)).toEqual([
      '/workspace/.agents/skills',
      '/home/person/.agents/skills',
    ]);

    const withCompatibility = defaultSkillSources({
      projectRoot: '/workspace',
      homeDirectory: '/home/person',
      includeCompatibilityRoots: true,
    });

    // A workspace that happens to have a `.claude/skills` directory is not thereby asking this
    // runtime to load it.
    expect(withCompatibility.map((entry) => entry.location)).toContain('/workspace/.claude/skills');
  });

  it('orders project ahead of user ahead of built-in', () => {
    const sources = defaultSkillSources({
      projectRoot: '/workspace',
      homeDirectory: '/home/person',
      builtInRoots: ['/opt/host/skills'],
    });

    const byKind = new Map(sources.map((entry) => [entry.kind, entry.precedence]));
    expect(byKind.get('project')).toBeLessThan(byKind.get('user')!);
    expect(byKind.get('user')).toBeLessThan(byKind.get('built-in')!);
  });

  it('defaults project and remote sources to untrusted', () => {
    expect(defaultTrustForKind('project').state).toBe('untrusted');
    expect(defaultTrustForKind('remote').state).toBe('untrusted');
    expect(defaultTrustForKind('user').state).toBe('trusted');
    expect(defaultTrustForKind('built-in').state).toBe('trusted');
  });

  it('lets a policy admit one source without admitting its kind', () => {
    const admitted = source('project', '/workspace/.agents/skills', {
      kind: 'project',
      precedence: 10,
    });
    const other = source('other-project', '/elsewhere', { kind: 'project', precedence: 10 });
    const policy = admitSources(['project']);

    expect(resolveTrust(admitted, policy).state).toBe('trusted');
    expect(resolveTrust(other, policy).state).toBe('untrusted');
  });
});
