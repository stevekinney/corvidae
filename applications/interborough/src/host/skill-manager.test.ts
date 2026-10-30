/**
 * COR-1818: a remote home keeps its configuration in a bucket the host cannot write, so the skill
 * manager refuses a trust change there with the reason `deployment`, writes nothing, and records
 * nothing, while it still reads and lists the skills. The local path is in `host-skills.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSkillManager,
  SkillWriteLockedError,
  type SkillAuditEntry,
  type SkillManagerOptions,
} from './skill-manager.ts';
import { HOST_SKILL_TRUST_ROUTE, skillRoutes } from './skill-routes.ts';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A home in `mode` whose configuration is `text`, recording what it is asked to write. */
async function fakeHome(
  mode: 'local' | 'remote',
  failure?: { readonly replaces: boolean; readonly error: Error },
) {
  const skills = await mkdtemp(join(tmpdir(), 'interborough-skill-manager-'));
  directories.push(skills);
  await mkdir(join(skills, 'deploy'));
  await writeFile(
    join(skills, 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploys.\n---\n\nBody.\n',
  );
  let text: string | undefined = JSON.stringify({
    skills: { sources: [{ id: 'workspace', kind: 'project', path: skills }] },
  });
  const writes: string[] = [];
  const audited: SkillAuditEntry[] = [];
  const options: SkillManagerOptions = {
    bungalow: {
      mode,
      configurationLocation: 's3://bucket/configuration.json',
      readConfiguration: async () => text,
      writeConfiguration: (next: string) => {
        writes.push(next);
        if (failure === undefined) {
          text = next;
          return;
        }
        // Bungalow renames the file and then syncs the directory, so a throw may follow the replace.
        if (failure.replaces) text = next;
        throw failure.error;
      },
    },
    audit: async (entry) => {
      audited.push(entry);
    },
  };
  return { options, writes, audited };
}

describe('a remote home', () => {
  test('lists the skills, reports why trust is locked, and refuses a change with the reason deployment', async () => {
    const { options, writes, audited } = await fakeHome('remote');
    const manager = await createSkillManager(options);

    expect(manager.lockReason()).toBe('deployment');
    expect(manager.standing().trustLocked).toBe('deployment');
    expect(manager.standing().catalog.records.map((record) => record.name)).toEqual(['deploy']);
    const failure = await manager.setTrust({ source: 'workspace', trusted: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SkillWriteLockedError);
    expect((failure as SkillWriteLockedError).reason).toBe('deployment');
    expect(writes).toEqual([]);
    expect(audited).toEqual([]);
    expect(manager.standing().catalog.records[0]?.available).toBe(false);
  });

  test('answers the route with 403 and the reason', async () => {
    const { options } = await fakeHome('remote');
    const manager = await createSkillManager(options);
    const routes = skillRoutes(manager, () => undefined);
    const request = Object.assign(
      new Request('http://127.0.0.1/host/skills/sources/workspace/trust', {
        method: 'PUT',
        body: JSON.stringify({ trusted: true }),
      }),
      { params: { id: 'workspace' } },
    ) as Bun.BunRequest<typeof HOST_SKILL_TRUST_ROUTE>;

    const response = await routes[HOST_SKILL_TRUST_ROUTE].PUT(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'locked', reason: 'deployment' });
  });
});

describe('a local home', () => {
  test('reports no lock, and a failed audit write leaves the change applied and says so', async () => {
    const { options, writes } = await fakeHome('local');
    const manager = await createSkillManager({
      ...options,
      audit: async () => {
        throw new Error('the trail is down');
      },
    });
    expect(manager.standing().trustLocked).toBeUndefined();

    const failure = await manager.setTrust({ source: 'workspace', trusted: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).name).toBe('SkillAuditError');
    expect(writes).toHaveLength(1);
    expect(manager.standing().catalog.records[0]?.available).toBe(true);
  });

  test('records a change that could not be recorded when the same request is made again (COR-1926)', async () => {
    const { options, audited } = await fakeHome('local');
    let down = true;
    const manager = await createSkillManager({
      ...options,
      audit: async (entry) => {
        if (down) throw new Error('the trail is down');
        audited.push(entry);
      },
    });

    const failures = [
      await manager
        .setTrust({ source: 'workspace', trusted: true })
        .catch((error: unknown) => error),
      await manager
        .setTrust({ source: 'workspace', trusted: true })
        .catch((error: unknown) => error),
    ];
    expect(failures.map((failure) => (failure as Error).name)).toEqual([
      'SkillAuditError',
      'SkillAuditError',
    ]);
    expect(audited).toEqual([]);

    down = false;
    const retried = await manager.setTrust({ source: 'workspace', trusted: true });

    expect(retried).toMatchObject({ source: 'workspace', trusted: true, changed: false });
    expect(audited.map((entry) => entry.type)).toEqual(['skill.source.trusted']);
    // Recorded once: a further request owes nothing.
    await manager.setTrust({ source: 'workspace', trusted: true });
    expect(audited).toHaveLength(1);
  });

  test('records the owed change before the opposite change, so the trail keeps its order', async () => {
    const { options, audited } = await fakeHome('local');
    let down = true;
    const manager = await createSkillManager({
      ...options,
      audit: async (entry) => {
        if (down) throw new Error('the trail is down');
        audited.push(entry);
      },
    });
    await manager.setTrust({ source: 'workspace', trusted: true }).catch(() => undefined);

    down = false;
    const revoked = await manager.setTrust({ source: 'workspace', trusted: false });

    expect(revoked.changed).toBe(true);
    expect(audited.map((entry) => entry.type)).toEqual([
      'skill.source.trusted',
      'skill.source.untrusted',
    ]);
  });

  test('reads the file back when the write throws after replacing it, and reports the write', async () => {
    const error = new Error('the directory could not be synced');
    const { options, audited } = await fakeHome('local', { replaces: true, error });
    const manager = await createSkillManager(options);
    expect(manager.standing().catalog.records[0]?.available).toBe(false);

    const failure = await manager
      .setTrust({ source: 'workspace', trusted: true })
      .catch((caught: unknown) => caught);

    expect(failure).toBe(error);
    // The file says trusted, so the host serves trusted, with a new revision.
    expect(manager.standing().catalog.records[0]?.available).toBe(true);
    expect(manager.standing().sources[0]?.trust).toBe('trusted');
    expect(audited).toEqual([]);
  });

  test('keeps serving the file it read when the write throws without replacing it', async () => {
    const error = new Error('disk full');
    const { options } = await fakeHome('local', { replaces: false, error });
    const manager = await createSkillManager(options);

    const failure = await manager
      .setTrust({ source: 'workspace', trusted: true })
      .catch((caught: unknown) => caught);

    expect(failure).toBe(error);
    expect(manager.standing().catalog.records[0]?.available).toBe(false);
    expect(manager.standing().sources[0]?.trust).toBe('untrusted');
  });
});
