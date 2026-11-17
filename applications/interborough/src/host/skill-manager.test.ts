/**
 * COR-1818: a remote home keeps its configuration in a bucket the host cannot write, so the skill
 * manager refuses a trust change there with the reason `deployment`, writes nothing, and records
 * nothing, while it still reads and lists the skills. The local path is in `host-skills.test.ts`.
 */
import { createManualRuntimeServices } from '@lostgradient/bureau';
import type { SkillCatalogChange } from '@lostgradient/bureau/skills';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHostMutationContext } from './host-mutation-context.ts';

import {
  createSkillManager,
  SkillWriteLockedError,
  type SkillAuditEntry,
  type SkillManager,
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
    // These rows are about trust and the audit trail: nothing here watches the directory.
    watch: false,
    bungalow: {
      mode,
      workspaceId: 'skill-fixture',
      configurationWriteCapability:
        mode === 'remote' ? ('read-only' as const) : ('writable' as const),
      configurationLocation: 's3://bucket/configuration.json',
      readConfiguration: async () => ({
        text,
        revision: text === undefined ? null : Bun.hash(text).toString(),
      }),
      writeConfiguration: async (next, condition) => {
        if (condition.expectedRevision !== (text === undefined ? null : Bun.hash(text).toString()))
          return { outcome: 'conflict' };
        writes.push(next);
        if (failure === undefined) {
          text = next;
          return { outcome: 'committed' };
        }
        // Bungalow renames the file and then syncs the directory, so a throw may follow the replace.
        if (failure.replaces) text = next;
        return failure.replaces ? { outcome: 'unknown' } : { outcome: 'unavailable' };
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
    const routes = skillRoutes(manager, () => undefined, {
      mutation: () => createLocalHostMutationContext(options.bungalow),
    });
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

  test('a trail that is down never stops a source from being revoked, and the revoke says what was asked (COR-1926)', async () => {
    const { options, writes, audited } = await fakeHome('local');
    let down = true;
    let time = 1_000;
    const manager = await createSkillManager({
      ...options,
      now: () => time++,
      audit: async (entry) => {
        if (down) throw new Error('the trail is down');
        audited.push(entry);
      },
    });
    await manager.setTrust({ source: 'workspace', trusted: true }).catch(() => undefined);
    expect(manager.standing().catalog.records[0]?.available).toBe(true);

    const revoke = await manager
      .setTrust({ source: 'workspace', trusted: false })
      .catch((error: unknown) => error);

    expect(revoke).toMatchObject({
      name: 'SkillAuditError',
      sourceId: 'workspace',
      trusted: false,
    });
    expect(writes).toHaveLength(2);
    expect(manager.standing().catalog.records[0]?.available).toBe(false);

    down = false;
    await manager.setTrust({ source: 'workspace', trusted: false });
    // Both are recorded, in order, each with the time of its own change.
    expect(audited.map((entry) => [entry.type, entry.timestampMs])).toEqual([
      ['skill.source.trusted', 1_000],
      ['skill.source.untrusted', 1_001],
    ]);
  });

  test('refreshes standing after an uncertain write without claiming this actor committed it', async () => {
    const error = new Error('the directory could not be synced');
    const { options, audited } = await fakeHome('local', { replaces: true, error });
    const manager = await createSkillManager(options);
    expect(manager.standing().catalog.records[0]?.available).toBe(false);

    const failure = await manager
      .setTrust({ source: 'workspace', trusted: true })
      .catch((caught: unknown) => caught);

    // Current standing is authoritative, but matching content does not identify its writer.
    expect(failure).toMatchObject({
      code: 'unavailable',
    });
    expect(manager.standing().catalog.records[0]?.available).toBe(true);
    expect(audited).toEqual([]);
  });

  test('does not replay or manufacture a success audit after an uncertain write', async () => {
    const error = new Error('the directory could not be synced');
    const { options, audited } = await fakeHome('local', { replaces: true, error });
    let down = true;
    const manager = await createSkillManager({
      ...options,
      audit: async (entry) => {
        if (down) throw new Error('the trail is down');
        audited.push(entry);
      },
    });

    const failure = await manager
      .setTrust({ source: 'workspace', trusted: true })
      .catch((caught: unknown) => caught);

    expect(failure).toMatchObject({
      code: 'unavailable',
    });
    expect(manager.standing().catalog.records[0]?.available).toBe(true);
    down = false;
    await manager.setTrust({ source: 'workspace', trusted: true });
    expect(audited).toEqual([]);
  });

  test('keeps serving the file it read when the write throws without replacing it', async () => {
    const error = new Error('disk full');
    const { options } = await fakeHome('local', { replaces: false, error });
    const manager = await createSkillManager(options);

    const failure = await manager
      .setTrust({ source: 'workspace', trusted: true })
      .catch((caught: unknown) => caught);

    expect(failure).toMatchObject({
      code: 'unavailable',
    });
    expect(manager.standing().catalog.records[0]?.available).toBe(false);
    expect(manager.standing().sources[0]?.trust).toBe('untrusted');
  });
});

describe('skill trust admission', () => {
  test('a writable remote backend accepts an authorized deployment operator', async () => {
    const { options, writes } = await fakeHome('remote');
    const bungalow = { ...options.bungalow, configurationWriteCapability: 'writable' as const };
    const manager = await createSkillManager({ ...options, bungalow });
    const mutation = await createLocalHostMutationContext(bungalow);
    const change = await manager.setTrust({ source: 'workspace', trusted: true }, mutation);
    expect(change.changed).toBe(true);
    expect(writes).toHaveLength(1);
  });

  test('an edit from a stale revision cannot overwrite another configuration change', async () => {
    const { options, writes } = await fakeHome('local');
    const manager = await createSkillManager(options);
    const mutation = await createLocalHostMutationContext(options.bungalow);
    const previous = await options.bungalow.readConfiguration();
    await options.bungalow.writeConfiguration(`${previous.text}\n`, {
      expectedRevision: previous.revision,
    });
    const failure: unknown = await manager
      .setTrust({ source: 'workspace', trusted: true }, mutation)
      .then(
        () => undefined,
        (error) => error,
      );
    expect(failure).toMatchObject({ code: 'conflict' });
    expect(writes).toHaveLength(1);
  });

  test('revocation immediately before publication prevents a configuration write', async () => {
    const { options, writes, audited } = await fakeHome('local');
    const manager = await createSkillManager(options);
    const local = await createLocalHostMutationContext(options.bungalow);
    let evaluations = 0;
    const mutation = {
      ...local,
      async revalidate() {
        const identity = await local.revalidate();
        evaluations += 1;
        return evaluations === 1 ? identity : { ...identity, capabilities: [] };
      },
    };
    const failure: unknown = await manager
      .setTrust({ source: 'workspace', trusted: true }, mutation)
      .then(
        () => undefined,
        (error) => error,
      );
    expect(failure).toMatchObject({ code: 'forbidden' });
    expect(writes).toEqual([]);
    expect(audited).toEqual([]);
  });
});

/** COR-2100 (E4c): what a skill file changing on disk does to the manager's catalog and the feed. */

/** What a skill file holds. */
const skillText = (name: string, description = 'Does things.', body = 'Body.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** A skill file written whole: the file's directory is made, and the text goes in. */
async function putSkill(root: string, directory: string, text: string): Promise<void> {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, directory, 'SKILL.md'), text);
}

/**
 * A skill directory made outside `root` and renamed in, so no scan can read it half written (a scan
 * can land between the creation of a directory and the write of its file).
 */
async function renameSkillIn(
  staging: string,
  root: string,
  directory: string,
  text: string,
): Promise<void> {
  await putSkill(staging, directory, text);
  await rename(join(staging, directory), join(root, directory));
}

/** A native watcher the test controls: it records the path and closes, and fires when told to. */
interface FakeWatcher {
  readonly path: string;
  closed: boolean;
  fire(): void;
}

/**
 * A manager over a real skills directory, run on a manual runtime so its poll is `advance`d, never
 * waited for, with a native watcher the test fires by hand. The configuration is a file the test
 * rewrites; `reads` counts how often the manager read it.
 */
async function watchedManager(
  options: {
    readonly watch?: SkillManagerOptions['watch'];
    readonly trusted?: boolean;
    readonly pluginSources?: SkillManagerOptions['pluginSources'];
    readonly skills?: Readonly<Record<string, string>>;
    readonly refuseWatching?: boolean;
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), 'interborough-skill-watch-'));
  directories.push(base);
  const root = join(base, 'skills');
  const staging = join(base, 'staging');
  await mkdir(root, { recursive: true });
  await mkdir(staging, { recursive: true });
  for (const [directory, text] of Object.entries(options.skills ?? {})) {
    await putSkill(root, directory, text);
  }
  let text = JSON.stringify({
    skills: {
      sources: [{ id: 'workspace', kind: 'project', path: root }],
      trusted: options.trusted === false ? [] : ['workspace'],
    },
  });
  const state = { reads: 0 };
  const changes: SkillCatalogChange[] = [];
  const warnings: string[] = [];
  const watchers: FakeWatcher[] = [];
  const runtime = createManualRuntimeServices({ origin: '2026-11-09T00:00:00.000Z' });
  const home = {
    mode: 'local' as const,
    workspaceId: 'skill-fixture',
    configurationWriteCapability: 'writable' as const,
    configurationLocation: join(base, 'configuration.json'),
    readConfiguration: async () => {
      state.reads += 1;
      return { text, revision: Bun.hash(text).toString() };
    },
    writeConfiguration: async (next: string, condition: { expectedRevision: string | null }) => {
      if (condition.expectedRevision !== Bun.hash(text).toString()) {
        return { outcome: 'conflict' as const };
      }
      text = next;
      return { outcome: 'committed' as const };
    },
  };
  const created: SkillManager[] = [];
  const open = async (more: Partial<SkillManagerOptions> = {}): Promise<SkillManager> => {
    const manager = await createSkillManager({
      bungalow: home,
      audit: async () => undefined,
      runtime,
      ...(options.watch === undefined ? {} : { watch: options.watch }),
      ...(options.pluginSources === undefined ? {} : { pluginSources: options.pluginSources }),
      onChange: (change) => changes.push(change),
      warn: (message) => warnings.push(message),
      openWatcher: (path, listener) => {
        if (options.refuseWatching === true) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${path}'`), {
            code: 'ENOENT',
          });
        }
        const watcher: FakeWatcher = {
          path,
          closed: false,
          fire: () => listener('rename', 'alpha'),
        };
        watchers.push(watcher);
        return {
          close: () => {
            watcher.closed = true;
          },
          on: () => undefined,
        } as unknown as FSWatcher;
      },
      ...more,
    });
    created.push(manager);
    return manager;
  };
  const manager = await open();
  return {
    manager,
    open,
    runtime,
    root,
    staging,
    base,
    state,
    changes,
    warnings,
    watchers,
    /** Replaces the configuration file's text. */
    setConfiguration(next: unknown): void {
      text = typeof next === 'string' ? next : JSON.stringify(next);
    },
    /** One poll interval of the manual runtime. */
    poll: () => runtime.advance(1000),
    /** Every name the events listed under `list`, across all events. */
    names: (list: keyof SkillCatalogChange) => changes.flatMap((change) => change[list]),
    close: () => {
      for (const each of created) each.close();
    },
  };
}

const NOT_YET = { added: [], changed: [], removed: [], rejected: [] } as const;

describe('a skill manager that watches its sources (COR-2100)', () => {
  test('[matrix 111, 112] discovers what is on disk at start and announces nothing, now or after a restart', async () => {
    const run = await watchedManager({ skills: { alpha: skillText('alpha') } });
    expect(run.manager.standing().catalog.records.map((record) => record.name)).toEqual(['alpha']);
    await run.poll();
    await quietFor(50);
    expect(run.changes).toEqual([]);
    // A change made while the host was down is not announced: the next manager baselines on it.
    run.manager.close();
    await putSkill(run.root, 'beta', skillText('beta'));
    const restarted = await run.open();
    expect(restarted.standing().catalog.records.map((record) => record.name)).toEqual([
      'alpha',
      'beta',
    ]);
    await run.poll();
    await quietFor(50);
    expect(run.changes).toEqual([]);
    run.close();
  });

  test('[matrix 87, 119] arms one recursive native watcher per local source under true, none under poll or false, and closes them', async () => {
    const watched = await watchedManager({ watch: true });
    expect(watched.watchers.map((watcher) => [watcher.path, watcher.closed])).toEqual([
      [watched.root, false],
    ]);
    watched.manager.close();
    expect(watched.watchers.every((watcher) => watcher.closed)).toBe(true);
    for (const watch of ['poll', false] as const) {
      const quiet = await watchedManager({ watch });
      expect(quiet.watchers).toEqual([]);
      quiet.close();
    }
  });

  test('[matrix 87, 129] a native event is only a trigger: it scans, and a poll finds the same change without one', async () => {
    const run = await watchedManager({ watch: true });
    await putSkill(run.root, 'alpha', skillText('alpha'));
    run.watchers[0]!.fire();
    await waitUntil(() => run.names('added').includes('alpha'), { message: 'the native trigger' });
    await putSkill(run.root, 'beta', skillText('beta'));
    await run.poll();
    await waitUntil(() => run.names('added').includes('beta'), { message: 'the poll' });
    expect(run.names('added')).toEqual(['alpha', 'beta']);
    run.close();
  });

  test('[matrix 87] under false nothing but refresh() finds a change', async () => {
    const run = await watchedManager({ watch: false });
    await putSkill(run.root, 'alpha', skillText('alpha'));
    await run.poll();
    await quietFor(50);
    expect(run.changes).toEqual([]);
    await run.manager.refresh();
    expect(run.changes).toEqual([{ ...NOT_YET, added: ['alpha'] }]);
    run.close();
  });

  test('[matrix 88, 89, 90, 91, 120] adding, changing, resourcing and removing a skill each publish the right list, found by the poll on a manual runtime', async () => {
    const run = await watchedManager({ watch: 'poll' });
    await renameSkillIn(run.staging, run.root, 'alpha', skillText('alpha'));
    await run.poll();
    await waitUntil(() => run.names('added').includes('alpha'), { message: 'the added skill' });
    expect(run.changes.at(-1)).toEqual({ ...NOT_YET, added: ['alpha'] });

    await putSkill(run.root, 'alpha', skillText('alpha', 'Does more.'));
    await run.poll();
    await waitUntil(() => run.names('changed').includes('alpha'), { message: 'the changed skill' });
    expect(run.changes.at(-1)).toEqual({ ...NOT_YET, changed: ['alpha'] });

    await mkdir(join(run.root, 'alpha', 'references'), { recursive: true });
    await writeFile(join(run.root, 'alpha', 'references', 'notes.md'), 'Notes.\n');
    await run.poll();
    await waitUntil(() => run.names('changed').length === 2, { message: 'the resource file' });
    expect(run.changes.at(-1)).toEqual({ ...NOT_YET, changed: ['alpha'] });

    await rm(join(run.root, 'alpha'), { recursive: true });
    await run.poll();
    await waitUntil(() => run.names('removed').includes('alpha'), { message: 'the removal' });
    expect(run.changes.at(-1)).toEqual({ ...NOT_YET, removed: ['alpha'] });
    run.close();
  });

  test('[matrix 92] a SKILL.md without a description is added and rejected', async () => {
    const run = await watchedManager({ watch: 'poll' });
    await renameSkillIn(run.staging, run.root, 'alpha', '---\nname: alpha\n---\n\nBody.\n');
    await run.poll();
    await waitUntil(() => run.names('added').includes('alpha'), { message: 'the malformed skill' });
    expect(run.changes.at(-1)).toEqual({ ...NOT_YET, added: ['alpha'], rejected: ['alpha'] });
    run.close();
  });

  test('[matrix 93, 96, 127] a skill that becomes unparseable is changed and rejected, once, and the full write after it is changed without rejected', async () => {
    const run = await watchedManager({
      watch: 'poll',
      skills: { alpha: skillText('alpha') },
    });
    await putSkill(run.root, 'alpha', '---\nname: alpha\ndescr');
    await run.poll();
    await waitUntil(() => run.changes.length === 1, { message: 'the cut-off frontmatter' });
    expect(run.changes[0]).toEqual({ ...NOT_YET, changed: ['alpha'], rejected: ['alpha'] });
    // The same diagnostic again, on later polls, is not reported again.
    await run.poll();
    await run.poll();
    await quietFor(50);
    expect(run.changes).toHaveLength(1);
    await putSkill(run.root, 'alpha', skillText('alpha'));
    await run.poll();
    await waitUntil(() => run.changes.length === 2, { message: 'the full write' });
    expect(run.changes[1]).toEqual({ ...NOT_YET, changed: ['alpha'] });
    run.close();
  });

  test('[matrix 96, 97, 128] a directory made and then refreshed, then written: rejected first, then changed without rejected', async () => {
    const run = await watchedManager({ watch: false });
    // Frontmatter cut off stands in for the bare `mkdir`, which discovery does not see at all.
    await mkdir(join(run.root, 'alpha'));
    await run.manager.refresh();
    expect(run.changes).toEqual([]);
    await putSkill(run.root, 'alpha', '---\nname: alpha\ndescr');
    await run.manager.refresh();
    expect(run.changes).toEqual([{ ...NOT_YET, added: ['alpha'], rejected: ['alpha'] }]);
    await putSkill(run.root, 'alpha', skillText('alpha'));
    await run.manager.refresh();
    expect(run.changes.at(-1)).toEqual({ ...NOT_YET, changed: ['alpha'] });
    run.close();
  });

  test('[matrix 98, 100, 115] a touch, a directory rename and an unchanged rescan publish nothing and keep the revision', async () => {
    const run = await watchedManager({ watch: 'poll', skills: { alpha: skillText('alpha') } });
    const revision = run.manager.standing().catalog.revision;
    await utimes(join(run.root, 'alpha', 'SKILL.md'), new Date(), new Date(1));
    await run.poll();
    await run.poll();
    await quietFor(50);
    expect(run.changes).toEqual([]);
    // The same catalog: the revision is the one it had.
    expect(run.manager.standing().catalog.revision).toBe(revision);
    // A directory renamed that declares the same name changes the revision's digest, and no skill.
    await rename(join(run.root, 'alpha'), join(run.root, 'alpha-two'));
    await run.poll();
    await quietFor(50);
    expect(run.changes).toEqual([]);
    run.close();
  });

  test('[matrix 101, 102, 103, 104, 105] a rename of the declared name, a shadowing copy and a conflicting directory are reported by name', async () => {
    const run = await watchedManager({ watch: 'poll', skills: { alpha: skillText('alpha') } });
    await putSkill(run.root, 'alpha', skillText('beta'));
    await run.poll();
    await waitUntil(() => run.changes.length === 1, { message: 'the renamed skill' });
    expect(run.changes[0]).toEqual({ ...NOT_YET, removed: ['alpha'], added: ['beta'] });
    await putSkill(run.root, 'gamma', skillText('beta', 'The other.'));
    await run.poll();
    await waitUntil(() => run.changes.length === 2, { message: 'the second directory' });
    expect(run.changes[1]).toEqual({ ...NOT_YET, changed: ['beta'] });
    run.close();
  });

  test('[matrix 99] a skill written twice within one poll interval is reported as the bytes its scan read: one event, the last', async () => {
    const run = await watchedManager({ watch: 'poll', skills: { alpha: skillText('alpha') } });
    await putSkill(run.root, 'alpha', skillText('alpha', 'First edit.'));
    await putSkill(run.root, 'alpha', skillText('alpha', 'Second edit.'));
    await run.poll();
    await waitUntil(() => run.changes.length === 1, { message: 'the one scan after both writes' });
    await quietFor(50);
    expect(run.changes).toEqual([{ ...NOT_YET, changed: ['alpha'] }]);
    expect(run.manager.standing().catalog.records[0]?.description).toBe('Second edit.');
    run.close();
  });

  test('[matrix 106, 107, 129] a skill directory renamed in is added, and one removed is removed, each found by a trigger that is only a trigger', async () => {
    const run = await watchedManager({ watch: true });
    await renameSkillIn(run.staging, run.root, 'beta', skillText('beta'));
    run.watchers[0]!.fire();
    await waitUntil(() => run.names('added').includes('beta'), { message: 'the renamed skill' });
    await rm(join(run.root, 'beta'), { recursive: true });
    run.watchers[0]!.fire();
    await waitUntil(() => run.names('removed').includes('beta'), { message: 'the removed skill' });
    run.close();
  });

  test('[matrix 108, 109] a source root removed is found by the poll, and one missing when armed gets no watcher until it exists', async () => {
    const run = await watchedManager({ watch: true, skills: { alpha: skillText('alpha') } });
    await rm(run.root, { recursive: true });
    await run.poll();
    await waitUntil(() => run.names('removed').includes('alpha'), { message: 'the root removed' });
    // The re-arm after that discovery finds no root to watch; it opens one once it exists again.
    const opened = run.watchers.length;
    await mkdir(run.root, { recursive: true });
    await putSkill(run.root, 'alpha', skillText('alpha'));
    await run.poll();
    await waitUntil(() => run.names('added').includes('alpha'), { message: 'the root made again' });
    expect(run.watchers.length).toBeGreaterThan(opened);
    run.close();

    // A native watcher that cannot be opened (the real one throws ENOENT) leaves no watcher and no error.
    const refused = await watchedManager({ watch: true, refuseWatching: true });
    expect(refused.watchers).toEqual([]);
    await putSkill(refused.root, 'beta', skillText('beta'));
    await refused.poll();
    await waitUntil(() => refused.names('added').includes('beta'), { message: 'the poll alone' });
    refused.close();
  });

  test('[matrix 109] the real native watcher on a missing directory is refused quietly', async () => {
    const base = await mkdtemp(join(tmpdir(), 'interborough-skill-missing-'));
    directories.push(base);
    const warnings: string[] = [];
    const manager = await createSkillManager({
      bungalow: {
        mode: 'local',
        workspaceId: 'skill-fixture',
        configurationWriteCapability: 'writable',
        configurationLocation: join(base, 'configuration.json'),
        readConfiguration: async () => ({
          text: JSON.stringify({
            skills: { sources: [{ id: 'workspace', kind: 'project', path: join(base, 'absent') }] },
          }),
          revision: '1',
        }),
        writeConfiguration: async () => ({ outcome: 'conflict' as const }),
      },
      audit: async () => undefined,
      runtime: createManualRuntimeServices({ origin: '2026-11-09T00:00:00.000Z' }),
      watch: true,
      warn: (message) => warnings.push(message),
    });
    expect(manager.standing().catalog.records).toEqual([]);
    manager.close();
    expect(warnings).toEqual([]);
  });

  test('[matrix 110, 128] a burst of skills at once is reported whole: the events’ names add up to the set', async () => {
    const run = await watchedManager({ watch: 'poll' });
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    for (const name of names) await renameSkillIn(run.staging, run.root, name, skillText(name));
    await run.poll();
    await waitUntil(() => run.names('added').length === names.length, { message: 'the burst' });
    expect(run.names('added').toSorted()).toEqual(names);
    run.close();
  });

  test('[matrix 113] a trust change is announced as changed for each skill it moves, and numbers the revision as before', async () => {
    const run = await watchedManager({
      watch: false,
      trusted: false,
      skills: { alpha: skillText('alpha'), beta: skillText('beta') },
    });
    const revision = run.manager.standing().catalog.revision;
    const result = await run.manager.setTrust({ source: 'workspace', trusted: true });
    expect(result.revision).toBe(revision + 1);
    expect(run.changes).toEqual([{ ...NOT_YET, changed: ['alpha', 'beta'] }]);
    run.close();
  });

  test('[matrix 114] an explicit refresh publishes a non-empty diff and numbers the revision, and publishes nothing for an empty one', async () => {
    const run = await watchedManager({ watch: false });
    const revision = run.manager.standing().catalog.revision;
    await putSkill(run.root, 'alpha', skillText('alpha'));
    const first = await run.manager.refresh();
    expect(first.revision).toBe(revision + 1);
    expect(run.changes).toEqual([{ ...NOT_YET, added: ['alpha'] }]);
    const second = await run.manager.refresh();
    expect(second.revision).toBe(revision + 2);
    expect(run.changes).toHaveLength(1);
    run.close();
  });

  test('[matrix 125] the catalog is replaced before the change is published, so a listener already sees it', async () => {
    const seen: string[][] = [];
    const run = await watchedManager({ watch: false });
    const manager = await run.open({
      onChange: () => {
        seen.push(manager.standing().catalog.records.map((record) => record.name));
      },
    });
    await putSkill(run.root, 'alpha', skillText('alpha'));
    await manager.refresh();
    expect(seen).toEqual([['alpha']]);
    run.close();
  });

  test('[matrix 116] a rescan that fails is caught, a configuration error is warned once per message until a rescan succeeds, and nothing is warned after close', async () => {
    const run = await watchedManager({ watch: 'poll' });
    const good = JSON.stringify({
      skills: { sources: [{ id: 'workspace', kind: 'project', path: run.root }], trusted: [] },
    });
    run.setConfiguration('{ not json');
    await run.poll();
    await waitUntil(() => run.warnings.length === 1, { message: 'the first warning' });
    await run.poll();
    await run.poll();
    await quietFor(50);
    expect(run.warnings).toHaveLength(1);
    expect(run.warnings[0]).not.toContain('{ not json');
    run.setConfiguration(good);
    await run.poll();
    await quietFor(50);
    run.setConfiguration('{ not json');
    await run.poll();
    await waitUntil(() => run.warnings.length === 2, { message: 'the warning after a success' });
    run.manager.close();
    run.setConfiguration('{ still not json');
    await run.poll();
    await quietFor(50);
    expect(run.warnings).toHaveLength(2);
  });

  test('[matrix 117] each rescan reads the configuration again, so a hand edit of skills.trusted is applied within a poll', async () => {
    const run = await watchedManager({
      watch: 'poll',
      trusted: false,
      skills: { alpha: skillText('alpha') },
    });
    expect(run.manager.standing().catalog.records[0]?.available).toBe(false);
    run.setConfiguration({
      skills: {
        sources: [{ id: 'workspace', kind: 'project', path: run.root }],
        trusted: ['workspace'],
      },
    });
    await run.poll();
    await waitUntil(() => run.names('changed').includes('alpha'), { message: 'the hand edit' });
    expect(run.manager.standing().catalog.records[0]?.available).toBe(true);
    run.close();
  });

  test('[matrix 118] a plugin that starts is read at the next poll: its skills are added and its directory is watched', async () => {
    const base = await mkdtemp(join(tmpdir(), 'interborough-skill-plugin-'));
    directories.push(base);
    const shipped = join(base, 'skills');
    await putSkill(shipped, 'shipped', skillText('shipped'));
    let running = false;
    const run = await watchedManager({
      watch: true,
      pluginSources: () =>
        running
          ? [
              {
                id: 'plugin:demo',
                kind: 'plugin',
                location: shipped,
                precedence: 35,
                plugin: 'demo',
              },
            ]
          : [],
    });
    expect(run.watchers.map((watcher) => watcher.path)).toEqual([run.root]);
    running = true;
    await run.poll();
    await waitUntil(() => run.names('added').includes('shipped'), {
      message: 'the plugin’s skill',
    });
    expect(run.watchers.map((watcher) => watcher.path).toSorted()).toEqual(
      [run.root, shipped].toSorted(),
    );
    running = false;
    await run.poll();
    await waitUntil(() => run.names('removed').includes('shipped'), {
      message: 'the plugin stops',
    });
    run.close();
  });

  test('[matrix 119] close() stops the timer: a later poll scans nothing and publishes nothing', async () => {
    const run = await watchedManager({ watch: 'poll' });
    const reads = run.state.reads;
    run.manager.close();
    await putSkill(run.root, 'alpha', skillText('alpha'));
    await run.poll();
    await quietFor(50);
    expect(run.state.reads).toBe(reads);
    expect(run.changes).toEqual([]);
  });
});
