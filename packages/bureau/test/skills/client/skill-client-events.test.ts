import { TypedEventTarget } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemArtifactLoader } from '../../../src/skills/client/artifact-loader';
import { createSkillClient } from '../../../src/skills/client/skill-client';
import { discoverSkills } from '../../../src/skills/discovery/discover';
import type { SkillSource, SkillTrustPolicy } from '../../../src/skills/discovery/source';
import type { SkillEventMap } from '../../../src/skills/events';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-events-'));
  roots.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  options?: { body?: string; resources?: Readonly<Record<string, string>> },
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Description for ${name}`,
      '---',
      '',
      options?.body ?? 'Body.',
      '',
    ].join('\n'),
  );
  for (const [path, content] of Object.entries(options?.resources ?? {})) {
    const target = join(directory, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
}

const trustEverything: SkillTrustPolicy = {
  decide: () => ({ state: 'trusted', reason: 'test policy' }),
};

const now = (): string => '2026-09-19T00:00:00.000Z';

/** Records every dispatched event type, in order. */
function recorder(): { events: TypedEventTarget<SkillEventMap>; seen: string[] } {
  const events = new TypedEventTarget<SkillEventMap>();
  const seen: string[] = [];
  for (const type of [
    'skill.loaded',
    'skill.activated',
    'skill.deactivated',
    'skill.rejected',
    'skill.failed',
    'skill.catalog-revised',
    'skill.source-admitted',
    'skill.compatibility-decided',
    'skill.resource-loaded',
    'skill.reinjected',
    'skill.recovered',
    'skill.cancelled',
  ] as const) {
    events.addEventListener(type, () => seen.push(type));
  }
  return { events, seen };
}

async function clientWith(
  root: string,
  events: TypedEventTarget<SkillEventMap>,
  trustPolicy: SkillTrustPolicy = trustEverything,
  sources?: readonly SkillSource[],
) {
  const catalog = await discoverSkills({
    sources: sources ?? [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
    trustPolicy,
    now,
  });
  return createSkillClient({
    catalog,
    loadArtifact: createFilesystemArtifactLoader(),
    events,
    correlation: { runId: 'run-1', sessionId: 'session-1', traceId: 'trace-1', agentName: 'agent' },
    now,
  });
}

describe('skill client events', () => {
  it('announces the catalog once, with counts rather than the records', async () => {
    const root = await scratch();
    await writeSkill(root, 'first');
    await writeSkill(root, 'second');

    const events = new TypedEventTarget<SkillEventMap>();
    const revisions: { revision: number; discovered: number; available: number }[] = [];
    events.addEventListener('skill.catalog-revised', (event) => {
      revisions.push({
        revision: event.revision,
        discovered: event.discovered,
        available: event.available,
      });
    });

    const client = await clientWith(root, events);
    client.offered();
    client.report();

    // Once at construction, not once per read: a catalog can hold hundreds of entries and
    // re-announcing it on every read would make observation cost more than the thing observed.
    expect(revisions).toEqual([{ revision: 1, discovered: 2, available: 2 }]);
  });

  it('orders skill.loaded before skill.activated', async () => {
    const root = await scratch();
    await writeSkill(root, 'ordered');

    const { events, seen } = recorder();
    const client = await clientWith(root, events);
    seen.length = 0;

    await client.activate('ordered');

    // COR-767's ordering: `loaded` separates "the bundle had it" from "it entered context".
    expect(seen).toEqual(['skill.loaded', 'skill.activated']);
  });

  it('emits loaded then rejected, and never activated, for a refused skill', async () => {
    const root = await scratch();
    await writeSkill(root, 'drifting', { body: 'Original.' });

    const { events, seen } = recorder();
    const client = await clientWith(root, events);

    // Content changes after the catalog was sealed, so the bundle loads but must not be admitted.
    await writeSkill(root, 'drifting', { body: 'Rewritten.' });
    seen.length = 0;

    const outcome = await client.activate('drifting');
    expect(outcome.activated).toBe(false);
    expect(seen).toContain('skill.rejected');
    expect(seen).not.toContain('skill.activated');
  });

  it('names artifact-changed as the rejection reason, not a generic failure', async () => {
    const root = await scratch();
    await writeSkill(root, 'drifting', { body: 'Original.' });

    const events = new TypedEventTarget<SkillEventMap>();
    const reasons: string[] = [];
    events.addEventListener('skill.rejected', (event) => reasons.push(event.reason));

    const client = await clientWith(root, events);
    await writeSkill(root, 'drifting', { body: 'Rewritten.' });
    await client.activate('drifting');

    // The security-relevant distinction: the skill at that path is no longer the one the trust
    // decision admitted. A generic failure would lose that.
    expect(reasons).toEqual(['artifact-changed']);
  });

  it('stamps source and artifact correlation so a name alone never identifies content', async () => {
    const root = await scratch();
    await writeSkill(root, 'correlated');

    const events = new TypedEventTarget<SkillEventMap>();
    let correlation: Record<string, unknown> | undefined;
    events.addEventListener('skill.activated', (event) => {
      correlation = { ...event.correlation };
    });

    const client = await clientWith(root, events);
    await client.activate('correlated');

    expect(correlation?.['runId']).toBe('run-1');
    expect(correlation?.['sessionId']).toBe('session-1');
    expect(correlation?.['traceId']).toBe('trace-1');
    expect(correlation?.['agentName']).toBe('agent');
    // Two sources can serve the same name, so provenance is what makes the event identify content.
    expect(correlation?.['sourceId']).toBe('user');
    expect(correlation?.['artifactDigest']).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('decides compatibility per skill, carrying codes rather than third-party messages', async () => {
    const root = await scratch();
    const directory = join(root, 'unconformant');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      [
        '---',
        'name: unconformant',
        'description: Has a client-specific key.',
        'when_to_use: always',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );

    const events = new TypedEventTarget<SkillEventMap>();
    const decisions: { name: string; conformant: boolean; codes: readonly string[] }[] = [];
    events.addEventListener('skill.compatibility-decided', (event) => {
      decisions.push({
        name: event.skillName,
        conformant: event.conformant,
        codes: event.diagnosticCodes,
      });
    });

    await clientWith(root, events);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.conformant).toBe(false);
    // A code is stable enough to branch on; a message is a third party's text that would end up in
    // every log line.
    expect(decisions[0]?.codes).toContain('unexpected-field');
  });

  it('reports a source admission decision including an untrusted one', async () => {
    const root = await scratch();
    await writeSkill(root, 'workspace-skill');

    const events = new TypedEventTarget<SkillEventMap>();
    const admissions: { sourceId: string; trust: string }[] = [];
    events.addEventListener('skill.source-admitted', (event) => {
      admissions.push({ sourceId: event.sourceId, trust: event.trust });
    });

    await clientWith(root, events, { decide: () => undefined }, [
      { id: 'project', kind: 'project', location: root, precedence: 10 },
    ]);

    // An untrusted source is still reported: a host that cannot see it cannot offer to trust it.
    expect(admissions).toEqual([{ sourceId: 'project', trust: 'untrusted' }]);
  });

  it('emits a resource-load event with media type and size, but not content', async () => {
    const root = await scratch();
    await writeSkill(root, 'with-resource', { resources: { 'references/guide.md': '# Guide' } });

    const events = new TypedEventTarget<SkillEventMap>();
    const loads: { path: string; mediaType: string; byteLength: number }[] = [];
    events.addEventListener('skill.resource-loaded', (event) => {
      loads.push({ path: event.path, mediaType: event.mediaType, byteLength: event.byteLength });
    });

    const client = await clientWith(root, events);
    await client.activate('with-resource');
    client.loadResource('with-resource', 'references/guide.md');

    expect(loads).toEqual([
      { path: 'references/guide.md', mediaType: 'text/markdown', byteLength: 7 },
    ]);
    // The event describes the read; it is not a copy of what was read.
    expect(JSON.stringify(loads)).not.toContain('# Guide');
  });

  it('emits nothing for a resource that does not exist', async () => {
    const root = await scratch();
    await writeSkill(root, 'bare');

    const { events, seen } = recorder();
    const client = await clientWith(root, events);
    await client.activate('bare');
    seen.length = 0;

    client.loadResource('bare', 'references/missing.md');
    expect(seen).toEqual([]);
  });

  it('reports recovery with its refusals, not just its successes', async () => {
    const root = await scratch();
    await writeSkill(root, 'kept', { body: 'Kept.' });
    await writeSkill(root, 'drifted', { body: 'Original.' });

    const first = await clientWith(root, new TypedEventTarget<SkillEventMap>());
    await first.activate('kept');
    await first.activate('drifted');
    const records = first.activationRecords();

    await writeSkill(root, 'drifted', { body: 'Rewritten while away.' });

    const events = new TypedEventTarget<SkillEventMap>();
    const recoveries: { recovered: readonly string[]; refused: readonly string[] }[] = [];
    events.addEventListener('skill.recovered', (event) => {
      recoveries.push({ recovered: event.recovered, refused: event.refused });
    });

    const second = await clientWith(root, events);
    await second.recover(records);

    // A recovery that silently dropped a skill would leave a resumed run quietly less capable than
    // the one it resumed.
    expect(recoveries).toEqual([{ recovered: ['kept'], refused: ['drifted'] }]);
  });

  it('stays silent when no emitter is wired', async () => {
    const root = await scratch();
    await writeSkill(root, 'unobserved');

    const catalog = await discoverSkills({
      sources: [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
      trustPolicy: trustEverything,
      now,
    });
    const client = createSkillClient({
      catalog,
      loadArtifact: createFilesystemArtifactLoader(),
      now,
    });

    // Absent means silence, not a no-op emitter allocated per client.
    expect(await client.activate('unobserved')).toMatchObject({ activated: true });
  });
});
