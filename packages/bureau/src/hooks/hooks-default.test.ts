/**
 * COR-2179 (R8) — default hooks: a plugin declares hooks, and Bureau reconciles them. The table is
 * the outcome matrix `tmp/chef/briefs/reactions-2-matrix.md` (reactions batch 2), one test per row;
 * a row names its matrix line and the issue that owns it (`main` pins what main already did). The
 * hooks are built over the scripted engine of `hooks-reactions.test-support.ts`, so no row waits on
 * a real timer; two harnesses over one `kv` are two processes, and `observed` holds a read or a
 * write at the instant a race needs.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import type { HookDeclaration } from './create-hooks.ts';
import { HOOK_KEY_PREFIX, createHookStore } from './hook-store.ts';
import { HookError } from './hook-types.ts';
import {
  CONFIGURATION,
  START,
  availabilityGate,
  deferred,
  harness,
  outcomes,
  runStarted,
  untilAborted,
  type Harness,
  type Kv,
} from './hooks-reactions.test-support.ts';

const MATRIX = 'reactions-2 matrix';

/** The shape of one row: the matrix line, the issue that owns it, and what it asserts. */
interface Row {
  readonly line: number;
  readonly owner: 'main' | 'COR-2179';
  readonly name: string;
  readonly check: () => Promise<void>;
}

const declaration = (over: Partial<HookDeclaration> = {}): HookDeclaration => ({
  name: 'Post settled runs',
  events: ['run.settled'],
  reaction: 'post-message',
  configuration: { channel: 'ops' },
  ...over,
});

/** The identifier a default hook has: `default-` and 32 hexadecimal digits of SHA-256 over plugin, NUL and name. */
const idOf = (plugin: string, name: string): string =>
  `default-${createHash('sha256').update(`${plugin}\u0000${name}`).digest('hex').slice(0, 32)}`;

const memory = (): Kv => textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });

/** Declares `over` for the plugin `slack` and returns its hook. */
async function declare(h: Harness, over: Partial<HookDeclaration> = {}) {
  const [hook] = await h.hooks.reconcileDeclared('slack', [declaration(over)]);
  expect(hook).toBeDefined();
  return hook!;
}

/** Declares one hook per name for `slack`, and returns them: a reconcile takes the plugin's whole list. */
async function declareNames(h: Harness, ...names: string[]) {
  const hooks = await h.hooks.reconcileDeclared(
    'slack',
    names.map((name) => declaration({ name })),
  );
  expect(hooks).toHaveLength(names.length);
  return hooks;
}

async function refused(work: Promise<unknown>): Promise<HookError> {
  const outcome = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(outcome).toBeInstanceOf(HookError);
  return outcome as HookError;
}

/** The text a hook is stored as, or `null`. */
const rawOf = (kv: Kv, id: string) => kv.get(`${HOOK_KEY_PREFIX}${id}`);

async function recordOf(kv: Kv, id: string) {
  const stored = await createHookStore(kv).getHook(id);
  expect(stored).toBeDefined();
  return stored!.record;
}

/** Every hook the store holds, by id, as stored. */
async function hooksIn(kv: Kv) {
  const records = await createHookStore(kv).listHooks();
  return records.toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * `kv` seen from outside, with a hold at each of the two instants a race needs: a read of a hook
 * (`beforeRead`) and the write of a hook (`beforeWrite`). `log` lists the hook writes in order,
 * `wrote` or `lost` by the compare-and-swap, so a fence that did its job shows as a `lost`.
 */
function observed(kv: Kv) {
  const log: string[] = [];
  const hold: {
    beforeRead?: ((id: string) => Promise<void>) | undefined;
    beforeWrite?: ((id: string, attempt: number) => Promise<void>) | undefined;
  } = {};
  const writes = new Map<string, number>();
  const wrapped: Kv = {
    ...kv,
    get: async (key) => {
      if (key.startsWith(HOOK_KEY_PREFIX))
        await hold.beforeRead?.(key.slice(HOOK_KEY_PREFIX.length));
      return kv.get(key);
    },
    conditionalBatch: async (conditions, operations) => {
      const keys = operations
        .map((operation) => operation.key)
        .filter((key) => key.startsWith(HOOK_KEY_PREFIX))
        .map((key) => key.slice(HOOK_KEY_PREFIX.length));
      for (const id of keys) {
        const attempt = (writes.get(id) ?? 0) + 1;
        writes.set(id, attempt);
        await hold.beforeWrite?.(id, attempt);
      }
      const won = await kv.conditionalBatch(conditions, operations);
      for (const id of keys) log.push(`${won ? 'wrote' : 'lost'} ${id}`);
      return won;
    },
  };
  return { kv: wrapped, log, hold };
}

/** Holds each party at its first read of a hook until `parties` have arrived, so all see the same record. */
function barrier(parties: number) {
  const gate = deferred();
  let arrived = 0;
  // Only the first read of each party waits: its later reads are the re-reads the race is about.
  return async (): Promise<void> => {
    if (arrived >= parties) return;
    arrived += 1;
    if (arrived >= parties) gate.resolve();
    await gate.promise;
  };
}

const slackAndCalendar = (run: (context: never) => Promise<void>) =>
  [
    {
      plugin: 'slack',
      kind: {
        name: 'post-message',
        description: 'Posts the event to a channel.',
        configuration: CONFIGURATION,
        run: run as never,
      },
    },
    {
      plugin: 'slack',
      kind: {
        name: 'post-thread',
        description: 'Posts the event to a thread.',
        configuration: CONFIGURATION,
        run: run as never,
      },
    },
    {
      plugin: 'calendar',
      kind: {
        name: 'post-message',
        description: 'Posts the event to a calendar.',
        configuration: CONFIGURATION,
        run: run as never,
      },
    },
  ] as const;

/** A harness that registers slack's two kinds and calendar's one. */
const withTwoPlugins = (options: Parameters<typeof harness>[0] = {}) =>
  harness({
    ...options,
    registrations: (run) => slackAndCalendar(run),
  });

const RECORD = {
  version: 3,
  id: 'default-0123',
  owner: 'anonymous:local',
  name: 'Post settled runs',
  action: {
    type: 'plugin',
    plugin: 'slack',
    kind: 'post-message',
    configuration: { channel: 'ops' },
  },
  events: ['run.settled'],
  enabled: true,
  createdAt: START,
  updatedAt: START,
  revision: 1,
  declaredBy: { plugin: 'slack' },
} as const;

/** Writes `record` as the hook `id` is stored, whatever its shape. */
async function planted(kv: Kv, record: Record<string, unknown>): Promise<string> {
  const id = String(record['id']);
  await kv.set(`${HOOK_KEY_PREFIX}${id}`, JSON.stringify(record));
  return id;
}

/** The rows of the persisted shape: version 3, `declaredBy`, and what a release reads. */
const RECORD_ROWS: readonly Row[] = [
  {
    line: 23,
    owner: 'COR-2179',
    name: 'a record with declaredBy is stored as version 3, and the hook view exposes declaredBy',
    check: async () => {
      const h = harness();
      const hook = await declare(h);
      expect(hook.declaredBy).toEqual({ plugin: 'slack' });
      expect(await h.hooks.get(hook.id)).toEqual(hook);
      const raw = JSON.parse((await rawOf(h.kv, hook.id))!) as Record<string, unknown>;
      expect(raw['version']).toBe(3);
      expect(raw['declaredBy']).toEqual({ plugin: 'slack' });
      // Scope does not matter: a default hook with a scope is also version 3.
      const scoped = await declare(h, {
        name: 'Scoped',
        scope: { kind: 'agent', id: 'helper' },
      });
      const scopedRaw = JSON.parse((await rawOf(h.kv, scoped.id))!) as Record<string, unknown>;
      expect(scopedRaw['version']).toBe(3);
    },
  },
  {
    line: 24,
    owner: 'COR-2179',
    name: 'a version 3 record with a valid declaredBy is read as a default hook',
    check: async () => {
      const kv = memory();
      const id = await planted(kv, {
        ...RECORD,
        declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: true },
      });
      const record = await recordOf(kv, id);
      expect(record.declaredBy).toEqual({ plugin: 'slack', ownerDisabled: true, withdrawn: true });
      expect(record.version).toBe(3);
      const bare = await planted(kv, { ...RECORD, id: 'default-bare' });
      const bareRecord = await recordOf(kv, bare);
      expect(bareRecord.declaredBy).toEqual({ plugin: 'slack' });
    },
  },
  {
    line: 25,
    owner: 'COR-2179',
    name: 'a version 3 record without a valid declaredBy is still refused',
    check: async () => {
      const kv = memory();
      const { declaredBy: _removed, ...withoutDeclaredBy } = RECORD;
      const bad: Record<string, unknown>[] = [
        { ...withoutDeclaredBy, id: 'v3-none' },
        { ...RECORD, id: 'v3-null', declaredBy: null },
        { ...RECORD, id: 'v3-string', declaredBy: 'slack' },
        { ...RECORD, id: 'v3-array', declaredBy: ['slack'] },
        { ...RECORD, id: 'v3-no-plugin', declaredBy: {} },
        { ...RECORD, id: 'v3-empty-plugin', declaredBy: { plugin: '' } },
        { ...RECORD, id: 'v3-number-plugin', declaredBy: { plugin: 3 } },
        { ...RECORD, id: 'v3-false', declaredBy: { plugin: 'slack', ownerDisabled: false } },
        { ...RECORD, id: 'v3-withdrawn-text', declaredBy: { plugin: 'slack', withdrawn: 'yes' } },
      ];
      for (const record of bad) {
        const id = await planted(kv, record);
        expect(await createHookStore(kv).getHook(id)).toBeUndefined();
      }
      expect(await createHookStore(kv).listHooks()).toEqual([]);
    },
  },
  {
    line: 26,
    owner: 'COR-2179',
    name: 'any other version (0, 2 with a bad shape, 4, a string, none) is refused',
    check: async () => {
      const kv = memory();
      const { version: _removed, ...withoutVersion } = RECORD;
      for (const version of [0, 4, '3', null, 3.5]) {
        const id = await planted(kv, { ...RECORD, id: `version-${String(version)}`, version });
        expect(await createHookStore(kv).getHook(id)).toBeUndefined();
      }
      const none = await planted(kv, { ...withoutVersion, id: 'version-none' });
      expect(await createHookStore(kv).getHook(none)).toBeUndefined();
    },
  },
  {
    line: 27,
    owner: 'COR-2179',
    name: 'a version 1 or 2 record that carries declaredBy is refused; one without it still parses and delivers',
    check: async () => {
      const kv = memory();
      for (const version of [1, 2]) {
        const id = await planted(kv, { ...RECORD, id: `old-${version}`, version });
        expect(await createHookStore(kv).getHook(id)).toBeUndefined();
      }
      // The same records without it read as they always did, and deliver.
      const { declaredBy: _removed, ...owner } = RECORD;
      const v1 = await planted(kv, { ...owner, id: 'owner-1', version: 1 });
      const v2 = await planted(kv, {
        ...owner,
        id: 'owner-2',
        version: 2,
        scope: { kind: 'agent', id: 'helper' },
      });
      const [first, second] = [await recordOf(kv, v1), await recordOf(kv, v2)];
      expect([first?.version, second?.version]).toEqual([1, 2]);
      const h = harness({
        kv,
        subjects: {
          run: () => Promise.resolve({ agent: 'helper', workflows: [], schedules: [] }),
          agentOfSchedule: () => Promise.resolve(undefined),
          agentOfGoal: () => Promise.resolve(undefined),
        },
      });
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.statuses(v1)).toEqual(['delivered']);
      expect(await h.statuses(v2)).toEqual(['delivered']);
    },
  },
  {
    line: 28,
    owner: 'COR-2179',
    name: 'a release that does not know version 3 skips the hook and deletes each pending delivery at its first pass (stood in for by a version this release refuses)',
    check: async () => {
      const kv = memory();
      // A delivery is written and left pending: its plugin needs setup, so it makes no attempt.
      const gate = availabilityGate(false);
      const first = harness({ kv, gate });
      const hook = await declare(first);
      await first.open();
      first.dispatch();
      await first.drain();
      const pending = await createHookStore(kv).listDeliveries();
      expect(pending.map((delivery) => [delivery.hookId, delivery.status])).toEqual([
        [hook.id, 'pending'],
      ]);
      const stored = await createHookStore(kv).getHook(hook.id);
      // Version 4 is what this release would make of a record from a later one.
      await kv.set(
        `${HOOK_KEY_PREFIX}${hook.id}`,
        stored!.raw.replace('"version":3', '"version":4'),
      );
      expect(await createHookStore(kv).getHook(hook.id)).toBeUndefined();
      const second = harness({ kv });
      await second.open();
      await second.drain();
      expect(await createHookStore(kv).listDeliveries()).toEqual([]);
      expect(second.calls).toHaveLength(0);
    },
  },
];

/** The rows of `reconcileDeclared`'s input checks and of what a missing, equal or changed hook becomes. */
const RECONCILE_ROWS: readonly Row[] = [
  {
    line: 29,
    owner: 'COR-2179',
    name: 'a repeated name is refused at [index, name] before anything is written',
    check: async () => {
      const h = harness();
      const error = await refused(
        h.hooks.reconcileDeclared('slack', [
          declaration(),
          declaration({ name: 'Other' }),
          declaration(),
        ]),
      );
      expect(error.code).toBe('invalid');
      expect(error.issues.map((issue) => issue.path)).toEqual([['2', 'name']]);
      expect(await hooksIn(h.kv)).toEqual([]);
      expect(h.audits).toEqual([]);
    },
  },
  {
    line: 30,
    owner: 'COR-2179',
    name: 'a declaration create would refuse is refused at [index, field], and nothing is written for any declaration',
    check: async () => {
      const bad: Array<{ readonly input: Partial<HookDeclaration>; readonly path: string[] }> = [
        { input: { reaction: 'no-such-kind' }, path: ['1', 'reaction'] },
        { input: { events: [] }, path: ['1', 'events'] },
        { input: { events: ['not.an.event'] }, path: ['1', 'events'] },
        { input: { name: '' }, path: ['1', 'name'] },
        { input: { name: 'x'.repeat(101) }, path: ['1', 'name'] },
        {
          input: { scope: { kind: 'planet' as never, id: 'earth' } },
          path: ['1', 'scope', 'kind'],
        },
        { input: { scope: { kind: 'agent', id: '' } }, path: ['1', 'scope', 'id'] },
        { input: { configuration: { channel: 7 } }, path: ['1', 'configuration'] },
        { input: { configuration: () => 'not json' }, path: ['1', 'configuration'] },
        // A scope a listed kind cannot be told by would silently never fire.
        {
          input: { scope: { kind: 'agent', id: 'a' }, events: ['bureau.disposed'] },
          path: ['1', 'scope'],
        },
      ];
      for (const { input, path } of bad) {
        const h = harness();
        const error = await refused(
          h.hooks.reconcileDeclared('slack', [
            declaration({ name: 'Fine' }),
            declaration({ name: 'Bad', ...input }),
          ]),
        );
        expect(error.code).toBe('invalid');
        expect(error.issues[0]?.path.slice(0, path.length)).toEqual(path);
        expect(await hooksIn(h.kv)).toEqual([]);
        expect(h.audits).toEqual([]);
      }
    },
  },
  {
    line: 31,
    owner: 'COR-2179',
    name: 'a missing hook is created as create creates one: deterministic id, owner of record, enabled, revision 1, audited without a principal, cache forgotten',
    check: async () => {
      const h = harness();
      await h.open();
      // A dispatch before the hook exists caches an empty list, which a created hook must drop.
      h.dispatch();
      await h.drain();
      const [hook] = await h.hooks.reconcileDeclared('slack', [declaration()]);
      expect(hook).toMatchObject({
        id: idOf('slack', 'Post settled runs'),
        owner: 'anonymous:local',
        name: 'Post settled runs',
        enabled: true,
        revision: 1,
        events: ['run.settled'],
        action: {
          type: 'plugin',
          plugin: 'slack',
          kind: 'post-message',
          configuration: { channel: 'ops' },
        },
        declaredBy: { plugin: 'slack' },
        createdAt: START,
      });
      const created = h.auditEntries.filter((entry) => entry.type === 'hook.created');
      expect(created).toHaveLength(1);
      expect(created[0]?.detail).toEqual({ hookId: hook!.id, owner: 'anonymous:local' });
      expect(created[0]?.runId).toBe(`hook:${hook!.id}`);
      expect('principal' in created[0]!).toBe(false);
      h.dispatch();
      await h.drain();
      expect(await h.statuses(hook!.id)).toEqual(['delivered']);
    },
  },
  {
    line: 32,
    owner: 'COR-2179',
    name: 'when the owner’s workspace authority cannot be captured, the call throws and the hooks it already wrote stay',
    check: async () => {
      let resolved = 0;
      const h = harness({
        workspace: {
          workspaceId: 'workspace-a',
          resolveOwnerMembership: (owner) => {
            resolved += 1;
            return Promise.resolve(
              resolved === 1
                ? {
                    version: 1,
                    workspaceId: 'workspace-a',
                    actorId: 'local-owner',
                    actorKind: 'local',
                    owner,
                    membershipRevision: 'r1',
                    capabilities: ['workspace:use', 'workspace:manage'],
                  }
                : null,
            );
          },
        },
      });
      const error = await h.hooks
        .reconcileDeclared('slack', [
          declaration({ name: 'First' }),
          declaration({ name: 'Second' }),
        ])
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Workspace authority unavailable.');
      const stored = await hooksIn(h.kv);
      expect(stored.map((record) => record.name)).toEqual(['First']);
      expect(stored[0]?.workspaceAuthority).toMatchObject({ workspaceId: 'workspace-a' });
    },
  },
  {
    line: 33,
    owner: 'COR-2179',
    name: 'an unchanged declaration writes nothing: no revision, no audit, no abort, however its fields are ordered, and whether or not the owner disabled it',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await declare(h, {
        events: ['run.settled', 'run.completed'],
        configuration: { channel: 'ops', urgent: true },
      });
      await h.open();
      h.dispatch();
      await runStarted(h);
      const before = await rawOf(h.kv, hook.id);
      const audited = h.audits.length;
      const again = await h.hooks.reconcileDeclared('slack', [
        declaration({
          events: ['run.completed', 'run.settled'],
          configuration: { urgent: true, channel: 'ops' },
        }),
      ]);
      expect(again[0]?.revision).toBe(1);
      expect(await rawOf(h.kv, hook.id)).toBe(before);
      expect(h.audits).toHaveLength(audited);
      // The delivery in flight was not aborted.
      expect(h.calls[0]?.signal.aborted).toBe(false);
      // Owner disabled: the same.
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      const disabled = await rawOf(h.kv, hook.id);
      await h.hooks.reconcileDeclared('slack', [
        declaration({
          events: ['run.completed', 'run.settled'],
          configuration: { urgent: true, channel: 'ops' },
        }),
      ]);
      expect(await rawOf(h.kv, hook.id)).toBe(disabled);
    },
  },
  {
    line: 34,
    owner: 'COR-2179',
    name: 'a changed declaration (events, kind, configuration or scope) replaces the hook in place: same id and createdAt, revision + 1, deliveries kept, audited as updated',
    check: async () => {
      const changes: Array<Partial<HookDeclaration>> = [
        { events: ['run.settled', 'run.completed'] },
        { reaction: 'post-thread' },
        { configuration: { channel: 'dev' } },
        { scope: { kind: 'agent', id: 'helper' } },
      ];
      for (const change of changes) {
        const h = withTwoPlugins();
        const hook = await declare(h);
        await h.open();
        h.dispatch();
        await h.drain();
        h.clock.milliseconds += 1_000;
        const [replaced] = await h.hooks.reconcileDeclared('slack', [declaration(change)]);
        expect(replaced).toMatchObject({
          id: hook.id,
          createdAt: hook.createdAt,
          revision: 2,
          enabled: true,
          updatedAt: START + 1_000,
          declaredBy: { plugin: 'slack' },
        });
        const stored = await recordOf(h.kv, hook.id);
        expect(stored.version).toBe(3);
        expect(await h.statuses(hook.id)).toEqual(['delivered']);
        const updated = h.auditEntries.filter((entry) => entry.type === 'hook.updated');
        expect(updated).toHaveLength(1);
        expect(updated[0]?.detail).toEqual({ hookId: hook.id, owner: 'anonymous:local' });
        expect(await hooksIn(h.kv)).toHaveLength(1);
      }
    },
  },
  {
    line: 35,
    owner: 'COR-2179',
    name: 'a changed declaration of a hook the owner disabled stays disabled and keeps ownerDisabled',
    check: async () => {
      const h = harness();
      const hook = await declare(h);
      await h.hooks.update(hook.id, { enabled: false });
      const [replaced] = await h.hooks.reconcileDeclared('slack', [
        declaration({ configuration: { channel: 'dev' } }),
      ]);
      expect(replaced).toMatchObject({
        enabled: false,
        revision: 3,
        declaredBy: { plugin: 'slack', ownerDisabled: true },
      });
      expect((replaced!.action as { configuration: unknown }).configuration).toEqual({
        channel: 'dev',
      });
    },
  },
  {
    line: 36,
    owner: 'main',
    name: 'an unchanged declaration after an upgrade writes no hook, and a delivery pinned to the old version fails',
    check: async () => {
      const kv = memory();
      const first: Harness = harness({
        kv,
        version: '1.0.0',
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const hook = await declare(first);
      await first.open();
      first.dispatch();
      await first.drain();
      const upgraded = harness({ kv, version: '2.0.0' });
      const before = await rawOf(kv, hook.id);
      await upgraded.hooks.reconcileDeclared('slack', [declaration()]);
      expect(await rawOf(kv, hook.id)).toBe(before);
      await upgraded.open();
      await upgraded.drain();
      const delivery = await upgraded.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(delivery.attempts.at(-1)?.error).toContain('version-mismatch');
    },
  },
  {
    line: 37,
    owner: 'main',
    name: 'a replace while a delivery is pending leaves it its own work and version pin: it runs the configuration it was made with',
    check: async () => {
      const kv = memory();
      const first: Harness = harness({
        kv,
        version: '1.0.0',
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const hook = await declare(first);
      await first.open();
      first.dispatch();
      await first.drain();
      const second = harness({ kv, version: '1.0.0' });
      const [replaced] = await second.hooks.reconcileDeclared('slack', [
        declaration({ configuration: { channel: 'dev' } }),
      ]);
      expect(replaced?.revision).toBe(2);
      await second.open();
      await second.drain();
      expect(await second.status(hook.id)).toBe('delivered');
      expect(second.calls.map((call) => call.configuration)).toEqual([
        { channel: 'ops', urgent: false },
      ]);
    },
  },
  {
    line: 38,
    owner: 'COR-2179',
    name: 'a renamed hook withdraws the old one (ownerDisabled kept, no override carried) and creates the new one enabled',
    check: async () => {
      const h = harness();
      const old = await declare(h, { name: 'Old name' });
      await h.hooks.update(old.id, { enabled: false });
      const [created] = await h.hooks.reconcileDeclared('slack', [
        declaration({ name: 'New name' }),
      ]);
      expect(created).toMatchObject({
        id: idOf('slack', 'New name'),
        enabled: true,
        declaredBy: { plugin: 'slack' },
      });
      expect(created!.declaredBy).toEqual({ plugin: 'slack' });
      const withdrawn = await h.hooks.get(old.id);
      expect(withdrawn).toMatchObject({
        enabled: false,
        revision: 3,
        declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: true },
      });
    },
  },
  {
    line: 39,
    owner: 'COR-2179',
    name: 'a hook no longer declared is withdrawn and kept, audited as updated, and its attempt in flight is aborted after the commit',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      const result = await h.hooks.reconcileDeclared('slack', [declaration({ name: 'Another' })]);
      expect(result.map((entry) => entry.name)).toEqual(['Another']);
      await h.drain();
      expect(await h.hooks.get(hook.id)).toMatchObject({
        enabled: false,
        revision: 2,
        declaredBy: { plugin: 'slack', withdrawn: true },
      });
      expect(h.calls[0]?.signal.aborted).toBe(true);
      expect(await h.status(hook.id)).toBe('aborted');
      expect(
        h.auditEntries
          .filter((entry) => entry.type === 'hook.updated')
          .map((entry) => entry.detail),
      ).toEqual([{ hookId: hook.id, owner: 'anonymous:local' }]);
    },
  },
  {
    line: 40,
    owner: 'COR-2179',
    name: 'a hook already withdrawn is not written again',
    check: async () => {
      const h = harness();
      const hook = await declare(h);
      await h.hooks.reconcileDeclared('slack', []);
      const before = await rawOf(h.kv, hook.id);
      const audited = h.audits.length;
      await h.hooks.reconcileDeclared('slack', []);
      expect(await rawOf(h.kv, hook.id)).toBe(before);
      expect(h.audits).toHaveLength(audited);
    },
  },
  {
    line: 41,
    owner: 'COR-2179',
    name: 'one reconcile validates all, creates and replaces in declaration order, then withdraws by createdAt; a crash between leaves the next reconcile only the withdraws',
    check: async () => {
      const base = memory();
      const setup = harness({ kv: base });
      // Written one after the other, so they differ in createdAt, and the first written is "Old b".
      await declareNames(setup, 'Old b');
      setup.clock.milliseconds += 10;
      await declareNames(setup, 'Old b', 'Old a');
      setup.clock.milliseconds += 10;
      await declareNames(setup, 'Old b', 'Old a', 'Keep');
      const watch = observed(base);
      const h = harness({ kv: watch.kv, clock: setup.clock });
      const declared = [
        declaration({ name: 'Zeta' }),
        declaration({ name: 'Keep', configuration: { channel: 'dev' } }),
        declaration({ name: 'Alpha' }),
      ];
      // A crash on the first withdraw, after every create and replace.
      let armed = true;
      watch.hold.beforeWrite = (id) => {
        if (armed && (id === idOf('slack', 'Old b') || id === idOf('slack', 'Old a'))) {
          return Promise.reject(new Error('the process crashed'));
        }
        return Promise.resolve();
      };
      const crashed = await h.hooks.reconcileDeclared('slack', declared).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect((crashed as Error).message).toBe('the process crashed');
      expect(watch.log).toEqual([
        `wrote ${idOf('slack', 'Zeta')}`,
        `wrote ${idOf('slack', 'Keep')}`,
        `wrote ${idOf('slack', 'Alpha')}`,
      ]);
      // After the crash both old hooks still fire; none is missing.
      const afterCrash = await hooksIn(base);
      expect(afterCrash.filter((record) => record.declaredBy?.withdrawn !== true)).toHaveLength(5);
      armed = false;
      watch.log.length = 0;
      await h.hooks.reconcileDeclared('slack', declared);
      // Withdrawn in createdAt order: Old b was created first.
      expect(watch.log).toEqual([
        `wrote ${idOf('slack', 'Old b')}`,
        `wrote ${idOf('slack', 'Old a')}`,
      ]);
    },
  },
  {
    line: 42,
    owner: 'COR-2179',
    name: 'an empty declaration list withdraws every default hook of the plugin, deletes none and keeps their deliveries',
    check: async () => {
      const h = harness();
      const [first, second] = await declareNames(h, 'One', 'Two');
      await h.open();
      h.dispatch();
      await h.drain();
      expect(await h.hooks.reconcileDeclared('slack', [])).toEqual([]);
      for (const hook of [first!, second!]) {
        expect(await h.hooks.get(hook.id)).toMatchObject({
          enabled: false,
          declaredBy: { plugin: 'slack', withdrawn: true },
        });
        expect(await h.statuses(hook.id)).toEqual(['delivered']);
      }
    },
  },
  {
    line: 43,
    owner: 'COR-2179',
    name: 'a withdrawn hook declared again is replaced even with equal fields: withdrawn cleared, enabled = not ownerDisabled, revision + 1, aborted deliveries stay aborted',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.reconcileDeclared('slack', []);
      await h.drain();
      expect(await h.statuses(hook.id)).toEqual(['aborted']);
      const [again] = await h.hooks.reconcileDeclared('slack', [declaration()]);
      expect(again).toMatchObject({
        id: hook.id,
        enabled: true,
        revision: 3,
        declaredBy: { plugin: 'slack' },
      });
      expect(again!.declaredBy).toEqual({ plugin: 'slack' });
      expect(await h.statuses(hook.id)).toEqual(['aborted']);
      // The owner's override survives a withdrawal and a return.
      await h.hooks.update(hook.id, { enabled: false });
      await h.hooks.reconcileDeclared('slack', []);
      const [stillOff] = await h.hooks.reconcileDeclared('slack', [declaration()]);
      expect(stillOff).toMatchObject({
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: true },
      });
    },
  },
  {
    line: 44,
    owner: 'COR-2179',
    name: 'an owner hook with the same name and action is not a candidate: it is left as it is',
    check: async () => {
      const h = harness();
      const mine = await h.hooks.create({
        events: ['run.settled'],
        name: 'Post settled runs',
        action: {
          type: 'plugin',
          plugin: 'slack',
          kind: 'post-message',
          configuration: { channel: 'ops' },
        },
      });
      const before = await rawOf(h.kv, mine.id);
      const [declared] = await h.hooks.reconcileDeclared('slack', [declaration()]);
      expect(declared!.id).not.toBe(mine.id);
      expect(await rawOf(h.kv, mine.id)).toBe(before);
      // And a reconcile that declares nothing leaves it enabled.
      await h.hooks.reconcileDeclared('slack', []);
      expect(await rawOf(h.kv, mine.id)).toBe(before);
    },
  },
  {
    line: 45,
    owner: 'COR-2179',
    name: 'another plugin’s default hook with the same name is untouched, by a declaration or by an empty list',
    check: async () => {
      const h = withTwoPlugins();
      const [theirs] = await h.hooks.reconcileDeclared('calendar', [
        declaration({ configuration: { channel: 'cal' } }),
      ]);
      const before = await rawOf(h.kv, theirs!.id);
      const [mine] = await h.hooks.reconcileDeclared('slack', [declaration()]);
      expect(mine!.id).not.toBe(theirs!.id);
      await h.hooks.reconcileDeclared('slack', []);
      expect(await rawOf(h.kv, theirs!.id)).toBe(before);
      expect(await h.hooks.get(mine!.id)).toMatchObject({
        declaredBy: { plugin: 'slack', withdrawn: true },
      });
    },
  },
  {
    line: 46,
    owner: 'COR-2179',
    name: 'called for a plugin whose kinds are not registered (disabled, or failed setup), a declaration is refused at [0, reaction] and nothing changes',
    check: async () => {
      const kv = memory();
      const first = harness({ kv });
      const hook = await declare(first);
      const off = harness({ kv, registrations: () => [] });
      const before = await rawOf(kv, hook.id);
      const error = await refused(off.hooks.reconcileDeclared('slack', [declaration()]));
      expect(error.issues[0]?.path).toEqual(['0', 'reaction']);
      expect(await rawOf(kv, hook.id)).toBe(before);
    },
  },
];

/** The rows of dispatch: what an event does to a default hook. */
const DISPATCH_ROWS: readonly Row[] = [
  {
    line: 47,
    owner: 'COR-2179',
    name: 'an event for a default hook whose plugin has no registered kind makes no delivery record and no attempt',
    check: async () => {
      const kv = memory();
      const first = harness({ kv });
      const hook = await declare(first);
      const off = harness({ kv, registrations: () => [] });
      await off.open();
      off.dispatch();
      await off.drain();
      expect(await off.deliveries(hook.id)).toEqual([]);
      expect(await createHookStore(kv).listStoredDeliveries()).toEqual([]);
      expect(off.calls).toHaveLength(0);
    },
  },
  {
    line: 48,
    owner: 'main',
    name: 'an event for an owner hook of an unregistered plugin still writes a delivery that fails',
    check: async () => {
      const kv = memory();
      const first = harness({ kv });
      const hook = await first.hook();
      const off = harness({ kv, registrations: () => [] });
      await off.open();
      off.dispatch();
      await off.drain();
      const delivery = await off.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(outcomes(delivery)).toEqual(['rejected']);
    },
  },
  {
    line: 49,
    owner: 'main',
    name: 'a pending delivery of a default hook whose plugin was disabled meanwhile fails at its first pass',
    check: async () => {
      const kv = memory();
      const first: Harness = harness({
        kv,
        run: () => {
          first.shutdown();
          return Promise.reject(new Error('the process is stopping'));
        },
      });
      const hook = await declare(first);
      await first.open();
      first.dispatch();
      await first.drain();
      const off = harness({ kv, registrations: () => [] });
      await off.open();
      await off.drain();
      const delivery = await off.only(hook.id);
      expect(delivery.status).toBe('failed');
      expect(off.calls).toHaveLength(0);
    },
  },
  {
    line: 50,
    owner: 'main',
    name: 'a default hook whose plugin needs setup is not skipped: its delivery waits, released and pending',
    check: async () => {
      const gate = availabilityGate(false);
      const h = harness({ gate });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('pending');
      expect(record.leaseUntil).toBe(0);
      expect(record.attempts).toEqual([]);
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    line: 51,
    owner: 'COR-2179',
    name: 'the loop guard applies to a default hook: an event from its own plugin writes nothing and says so once',
    check: async () => {
      const h = harness();
      const hook = await declare(h);
      await h.open();
      h.dispatch({ source: 'slack' });
      h.dispatch({ source: 'calendar' });
      await h.drain();
      expect(await h.statuses(hook.id)).toEqual(['delivered']);
      expect(h.calls.map((call) => call.event.source)).toEqual(['calendar']);
      expect(h.notices).toEqual([
        `[bureau] Hook ${hook.id} did not run its plugin action: Skipped: run.settled came from plugin slack, and a plugin's reaction does not fire on its own plugin's events`,
      ]);
    },
  },
  {
    line: 52,
    owner: 'main',
    name: 'a default hook the owner disabled, or that is withdrawn, fires for no event',
    check: async () => {
      const h = harness();
      const [disabled, withdrawn] = await declareNames(h, 'Disabled', 'Withdrawn');
      await h.open();
      await h.hooks.update(disabled!.id, { enabled: false });
      await declareNames(h, 'Disabled');
      h.dispatch();
      await h.drain();
      expect(await h.deliveries(disabled!.id)).toEqual([]);
      expect(await h.deliveries(withdrawn!.id)).toEqual([]);
      expect(await h.hooks.get(withdrawn!.id)).toMatchObject({
        enabled: false,
        declaredBy: { plugin: 'slack', withdrawn: true },
      });
      expect(h.calls).toHaveLength(0);
    },
  },
];

/** The rows of `update`, `delete` and `duplicate` on a default hook. */
const OWNER_ROWS: readonly Row[] = [
  {
    line: 53,
    owner: 'COR-2179',
    name: 'update of a default hook naming action, url, events, scope, name or signingSecret is refused at that field, with no write',
    check: async () => {
      const inputs = {
        action: {
          action: {
            type: 'plugin',
            plugin: 'slack',
            kind: 'post-message',
            configuration: { channel: 'dev' },
          },
        },
        url: { url: 'https://example.com/hook' },
        events: { events: ['run.completed'] },
        scope: { scope: { kind: 'agent', id: 'helper' } },
        name: { name: 'Renamed' },
        signingSecret: { signingSecret: 'a-signing-secret-long-enough' },
      } as const;
      const h = harness();
      const hook = await declare(h);
      const before = await rawOf(h.kv, hook.id);
      const audited = h.audits.length;
      for (const [field, input] of Object.entries(inputs)) {
        const error = await refused(h.hooks.update(hook.id, input));
        expect(error.code).toBe('invalid');
        expect(error.issues.map((issue) => issue.path[0])).toEqual([field]);
        // A change alongside `enabled` is refused whole.
        await refused(h.hooks.update(hook.id, { ...input, enabled: false }));
      }
      expect(await rawOf(h.kv, hook.id)).toBe(before);
      expect(h.audits).toHaveLength(audited);
    },
  },
  {
    line: 54,
    owner: 'COR-2179',
    name: 'update of a default hook with expectedRevision and principal is accepted, and expectedRevision still fences',
    check: async () => {
      const h = harness();
      const hook = await declare(h);
      const updated = await h.hooks.update(hook.id, {
        enabled: false,
        expectedRevision: 1,
        principal: 'api-key:alice',
      });
      expect(updated).toMatchObject({
        revision: 2,
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: true },
      });
      const audit = h.auditEntries.filter((entry) => entry.type === 'hook.updated').at(-1);
      expect(audit?.principal).toBe('api-key:alice');
      expect(audit?.detail).toEqual({ hookId: hook.id, owner: 'anonymous:local' });
      const stale = await refused(h.hooks.update(hook.id, { enabled: true, expectedRevision: 1 }));
      expect(stale.code).toBe('stale-revision');
      expect(stale.currentRevision).toBe(2);
      const bare = await h.hooks.update(hook.id, { expectedRevision: 2 });
      expect(bare).toMatchObject({
        revision: 3,
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: true },
      });
    },
  },
  {
    line: 55,
    owner: 'COR-2179',
    name: 'enabled: false sets ownerDisabled and aborts the attempt in flight after the commit; one whose compare-and-swap is lost to another writer is refused as stale and aborts nothing',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      expect(await h.status(hook.id)).toBe('aborted');
      const disabled = await recordOf(h.kv, hook.id);
      expect(disabled.declaredBy).toEqual({ plugin: 'slack', ownerDisabled: true });

      // A real lost swap: another process's reconcile commits between the update's read and its
      // write (no `expectedRevision` is given, so only the compare-and-swap can refuse it).
      const base = memory();
      const watch = observed(base);
      const answer = deferred();
      const lost = harness({
        kv: watch.kv,
        run: (_context, call) => (call === 1 ? answer.promise : Promise.resolve()),
      });
      const other = await declare(lost);
      await lost.open();
      lost.dispatch();
      await runStarted(lost);
      const elsewhere = harness({ kv: base });
      let raced = false;
      watch.hold.beforeWrite = async () => {
        if (raced) return;
        raced = true;
        await elsewhere.hooks.reconcileDeclared('slack', [
          declaration({ configuration: { channel: 'dev' } }),
        ]);
      };
      watch.log.length = 0;
      const stale = await refused(lost.hooks.update(other.id, { enabled: false }));
      expect(stale.code).toBe('stale-revision');
      expect(stale.currentRevision).toBe(2);
      expect(watch.log).toEqual([`lost ${other.id}`]);
      const survivor = await recordOf(base, other.id);
      expect(survivor.enabled).toBe(true);
      expect(survivor.declaredBy).toEqual({ plugin: 'slack' });
      expect(lost.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await lost.drain();
      expect(await lost.status(other.id)).toBe('delivered');
    },
  },
  {
    line: 56,
    owner: 'COR-2179',
    name: 'enabled: true on a hook that is not withdrawn clears ownerDisabled; deliveries aborted earlier stay aborted',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      const enabled = await h.hooks.update(hook.id, { enabled: true });
      expect(enabled).toMatchObject({ enabled: true, declaredBy: { plugin: 'slack' } });
      expect(enabled!.declaredBy).toEqual({ plugin: 'slack' });
      const reenabled = await recordOf(h.kv, hook.id);
      expect(reenabled.declaredBy).toEqual({ plugin: 'slack' });
      expect(await h.statuses(hook.id)).toEqual(['aborted']);
    },
  },
  {
    line: 57,
    owner: 'COR-2179',
    name: 'enabled: true on a withdrawn hook is refused at enabled, with no write',
    check: async () => {
      const h = harness();
      const hook = await declare(h);
      await h.hooks.reconcileDeclared('slack', []);
      const before = await rawOf(h.kv, hook.id);
      const error = await refused(h.hooks.update(hook.id, { enabled: true }));
      expect(error.code).toBe('invalid');
      expect(error.issues.map((issue) => issue.path)).toEqual([['enabled']]);
      expect(await rawOf(h.kv, hook.id)).toBe(before);
      // A disable of a withdrawn hook is the owner's too, and is not refused.
      const disabled = await h.hooks.update(hook.id, { enabled: false });
      expect(disabled).toMatchObject({
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: true },
      });
    },
  },
  {
    line: 58,
    owner: 'COR-2179',
    name: 'delete of a default hook is refused at declaredBy: nothing written, nothing aborted, nothing audited; an unknown id still answers false',
    check: async () => {
      const answer = deferred();
      const h = harness({ run: () => answer.promise });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      const before = await rawOf(h.kv, hook.id);
      const audited = h.audits.length;
      const error = await refused(h.hooks.delete(hook.id));
      expect(error.code).toBe('invalid');
      expect(error.issues.map((issue) => issue.path)).toEqual([['declaredBy']]);
      expect(await rawOf(h.kv, hook.id)).toBe(before);
      expect(h.audits).toHaveLength(audited);
      expect(h.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
      expect(await h.hooks.delete('no-such-hook')).toBe(false);
    },
  },
  {
    line: 59,
    owner: 'COR-2179',
    name: 'duplicate makes an owner hook with the source’s action, events, scope and name, disabled, with no declaredBy; the source is untouched',
    check: async () => {
      const h = harness();
      const source = await declare(h, { scope: { kind: 'agent', id: 'helper' } });
      const before = await rawOf(h.kv, source.id);
      const copy = await h.hooks.duplicate(source.id, { principal: 'api-key:alice' });
      expect(copy).toBeDefined();
      expect(copy!.id).not.toBe(source.id);
      expect(copy).toMatchObject({
        action: source.action,
        events: source.events,
        scope: source.scope,
        name: source.name,
        enabled: false,
        revision: 1,
      });
      expect('declaredBy' in copy!).toBe(false);
      const stored = JSON.parse((await rawOf(h.kv, copy!.id))!) as Record<string, unknown>;
      expect(stored['version']).toBe(2);
      expect('declaredBy' in stored).toBe(false);
      expect(await rawOf(h.kv, source.id)).toBe(before);
      const unscoped = await declare(h, { name: 'Unscoped' });
      const second = await h.hooks.duplicate(unscoped.id);
      expect(
        (JSON.parse((await rawOf(h.kv, second!.id))!) as Record<string, unknown>)['version'],
      ).toBe(1);
    },
  },
  {
    line: 60,
    owner: 'COR-2179',
    name: 'duplicate of a withdrawn hook whose kind is no longer registered is refused at [action, kind], with nothing written',
    check: async () => {
      const kv = memory();
      const first = harness({ kv });
      const source = await declare(first);
      await first.hooks.reconcileDeclared('slack', []);
      const off = harness({ kv, registrations: () => [] });
      const stored = await hooksIn(kv);
      const before = stored.length;
      const error = await refused(off.hooks.duplicate(source.id));
      expect(error.issues.map((issue) => issue.path)).toEqual([['action', 'kind']]);
      expect(await hooksIn(kv)).toHaveLength(before);
    },
  },
  {
    line: 61,
    owner: 'COR-2179',
    name: 'duplicate of an unknown id resolves undefined',
    check: async () => {
      const h = harness();
      expect(await h.hooks.duplicate('no-such-hook')).toBeUndefined();
    },
  },
];

/** The rows of two writers: processes, and the owner, racing a reconcile. */
const RACE_ROWS: readonly Row[] = [
  {
    line: 62,
    owner: 'COR-2179',
    name: 'two processes reconcile one plugin at once: exactly one hook per plugin and name (fence: createHook’s expectedValue null on the deterministic id)',
    check: async () => {
      const watch = observed(memory());
      watch.hold.beforeRead = barrier(2);
      const a = harness({ kv: watch.kv });
      const b = harness({ kv: watch.kv });
      const [first, second] = await Promise.all([
        a.hooks.reconcileDeclared('slack', [declaration()]),
        b.hooks.reconcileDeclared('slack', [declaration()]),
      ]);
      expect(first[0]?.id).toBe(idOf('slack', 'Post settled runs'));
      expect(second[0]?.id).toBe(first[0]!.id);
      expect(await hooksIn(watch.kv)).toHaveLength(1);
      expect(watch.log.filter((entry) => entry.startsWith('lost'))).toHaveLength(1);
      const created = await recordOf(watch.kv, first[0]!.id);
      expect(created.revision).toBe(1);
    },
  },
  {
    line: 63,
    owner: 'COR-2179',
    name: 'two processes reconcile a changed declaration: the winner writes, the loser re-reads, finds it unchanged and writes nothing (fence: replaceHook compares raw)',
    check: async () => {
      const base = memory();
      const setup = harness({ kv: base });
      const hook = await declare(setup);
      const watch = observed(base);
      watch.hold.beforeRead = barrier(2);
      const a = harness({ kv: watch.kv });
      const b = harness({ kv: watch.kv });
      const changed = declaration({ configuration: { channel: 'dev' } });
      await Promise.all([
        a.hooks.reconcileDeclared('slack', [changed]),
        b.hooks.reconcileDeclared('slack', [changed]),
      ]);
      const replaced = await recordOf(base, hook.id);
      expect(replaced.revision).toBe(2);
      expect(watch.log.filter((entry) => entry.startsWith('wrote'))).toHaveLength(1);
      expect(watch.log.filter((entry) => entry.startsWith('lost'))).toHaveLength(1);
    },
  },
  {
    line: 64,
    owner: 'COR-2179',
    name: 'an owner update and a reconcile of one hook in one process are serialized: ownerDisabled survives either order',
    check: async () => {
      for (const reconcileFirst of [true, false]) {
        const h = harness();
        const hook = await declare(h);
        const change = declaration({ configuration: { channel: 'dev' } });
        const reconciling = () => h.hooks.reconcileDeclared('slack', [change]);
        const disabling = () => h.hooks.update(hook.id, { enabled: false });
        await (reconcileFirst
          ? Promise.all([reconciling(), disabling()])
          : Promise.all([disabling(), reconciling()]));
        const record = await recordOf(h.kv, hook.id);
        expect(record.enabled).toBe(false);
        expect(record.declaredBy).toEqual({ plugin: 'slack', ownerDisabled: true });
        expect((record.action as { configuration: unknown }).configuration).toEqual({
          channel: 'dev',
        });
        expect(record.revision).toBe(3);
      }
    },
  },
  {
    line: 65,
    owner: 'COR-2179',
    name: 'an owner disable in another process that wins before the reconcile writes: the reconcile re-reads and recomputes, keeping ownerDisabled (fence: replaceHook compares raw)',
    check: async () => {
      const base = memory();
      const setup = harness({ kv: base });
      const hook = await declare(setup);
      const watch = observed(base);
      const reconciling = harness({ kv: watch.kv });
      const owner = harness({ kv: base });
      watch.hold.beforeWrite = async (_id, attempt) => {
        if (attempt === 1) await owner.hooks.update(hook.id, { enabled: false });
      };
      const [result] = await reconciling.hooks.reconcileDeclared('slack', [
        declaration({ configuration: { channel: 'dev' } }),
      ]);
      expect(watch.log).toEqual([`lost ${hook.id}`, `wrote ${hook.id}`]);
      expect(result).toMatchObject({
        enabled: false,
        revision: 3,
        declaredBy: { plugin: 'slack', ownerDisabled: true },
      });
      const stored = await recordOf(base, hook.id);
      expect((stored.action as { configuration: unknown }).configuration).toEqual({
        channel: 'dev',
      });
    },
  },
  {
    line: 39,
    owner: 'COR-2179',
    name: 'a withdrawal that loses its compare-and-swap aborts nothing: it re-reads, writes against what the owner left, and aborts only if its own write turned the hook off (fence: replaceHook compares raw)',
    check: async () => {
      const base = memory();
      const watch = observed(base);
      const answer = deferred();
      const h = harness({
        kv: watch.kv,
        run: (_context, call) => (call === 1 ? answer.promise : Promise.resolve()),
      });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      // Another process's owner disable commits between the withdrawal's read and its write.
      const owner = harness({ kv: base });
      let raced = false;
      watch.hold.beforeWrite = async () => {
        if (raced) return;
        raced = true;
        await owner.hooks.update(hook.id, { enabled: false });
      };
      watch.log.length = 0;
      await h.hooks.reconcileDeclared('slack', []);
      expect(watch.log).toEqual([`lost ${hook.id}`, `wrote ${hook.id}`]);
      const stored = await recordOf(base, hook.id);
      expect(stored).toMatchObject({ enabled: false, revision: 3 });
      expect(stored.declaredBy).toEqual({ plugin: 'slack', ownerDisabled: true, withdrawn: true });
      // The write that won was the owner's; this process's own write found the hook already off.
      expect(h.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await h.drain();
      expect(await h.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 66,
    owner: 'COR-2179',
    name: 'a reconcile interrupted after k of n writes is finished by the next: it writes only what remains, written hooks compare unchanged, no duplicates',
    check: async () => {
      const base = memory();
      const watch = observed(base);
      const a = harness({ kv: watch.kv });
      const declared = ['One', 'Two', 'Three'].map((name) => declaration({ name }));
      watch.hold.beforeWrite = (id) =>
        id === idOf('slack', 'Three')
          ? Promise.reject(new Error('the process crashed'))
          : Promise.resolve();
      const crashed = await a.hooks.reconcileDeclared('slack', declared).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect((crashed as Error).message).toBe('the process crashed');
      expect(await hooksIn(base)).toHaveLength(2);
      watch.hold.beforeWrite = undefined;
      watch.log.length = 0;
      const b = harness({ kv: base });
      const result = await b.hooks.reconcileDeclared('slack', declared);
      expect(result.map((hook) => hook.name)).toEqual(['One', 'Two', 'Three']);
      expect(await hooksIn(base)).toHaveLength(3);
      const finished = await hooksIn(base);
      expect(finished.map((record) => record.revision)).toEqual([1, 1, 1]);
    },
  },
];

/** The rows of what a withdrawal does to the deliveries of the hook. */
const WITHDRAWAL_ROWS: readonly Row[] = [
  {
    line: 67,
    owner: 'main',
    name: 'a withdrawal while a delivery waits out a backoff aborts it at the next pass, and the finish drops nextAttemptAt',
    check: async () => {
      const h = harness({ backoff: 1_000, run: () => Promise.reject(new Error('Slack is down')) });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await waitUntil(() => h.held.length === 1, { message: 'the backoff wait' });
      const waiting = await h.record(hook.id);
      expect(waiting.nextAttemptAt).toBeDefined();
      await h.hooks.reconcileDeclared('slack', []);
      expect(await h.status(hook.id)).toBe('pending');
      h.releaseWaits();
      await h.drain();
      const record = await h.record(hook.id);
      expect(record.status).toBe('aborted');
      expect(record.nextAttemptAt).toBeUndefined();
      expect(outcomes(record)).toEqual(['error']);
      expect(h.calls).toHaveLength(1);
    },
  },
  {
    line: 68,
    owner: 'main',
    name: 'a withdrawal while a delivery is pending with a released lease aborts it when it is next driven',
    check: async () => {
      const gate = availabilityGate(false);
      const h = harness({ gate });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await h.drain();
      const released = await h.record(hook.id);
      expect(released.leaseUntil).toBe(0);
      await h.hooks.reconcileDeclared('slack', []);
      gate.set(true);
      await h.drain();
      await waitUntil(
        async () => {
          const statuses = await h.statuses(hook.id);
          return statuses[0] === 'aborted';
        },
        { message: 'the delivery to abort' },
      );
      expect(h.calls).toHaveLength(0);
    },
  },
  {
    line: 69,
    owner: 'COR-2179',
    name: 'a withdrawal while a plugin attempt is in flight here aborts it after the commit: aborted, with no exhaustion audit',
    check: async () => {
      const h = harness({ maxAttempts: 1, run: untilAborted });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.reconcileDeclared('slack', []);
      await h.drain();
      expect(await h.status(hook.id)).toBe('aborted');
      expect(h.audits).not.toContain('hook.delivery.exhausted');
    },
  },
  {
    line: 70,
    owner: 'main',
    name: 'a withdrawal in another process lets the attempt in flight here complete; it is seen at the next pass',
    check: async () => {
      const kv = memory();
      const answer = deferred();
      const here = harness({ kv, run: () => answer.promise });
      const hook = await declare(here);
      await here.open();
      here.dispatch();
      await runStarted(here);
      const there = harness({ kv });
      await there.hooks.reconcileDeclared('slack', []);
      expect(here.calls[0]?.signal.aborted).toBe(false);
      answer.resolve();
      await here.drain();
      expect(await here.status(hook.id)).toBe('delivered');
    },
  },
  {
    line: 71,
    owner: 'main',
    name: 'a withdrawal another process committed, while this process still holds its 5-second copy: the delivery is written, then aborted with no attempt',
    check: async () => {
      const kv = memory();
      const here = harness({ kv });
      const hook = await declare(here);
      await here.open();
      here.dispatch();
      await here.drain();
      const there = harness({ kv });
      await there.hooks.reconcileDeclared('slack', []);
      here.dispatch();
      await here.drain();
      const deliveries = await here.deliveries(hook.id);
      expect(deliveries.map((delivery) => delivery.status)).toEqual(['delivered', 'aborted']);
      expect(deliveries[1]?.attempts).toEqual([]);
      expect(here.calls).toHaveLength(1);
    },
  },
  {
    line: 72,
    owner: 'COR-2179',
    name: 'a withdrawal of a hook the owner already disabled writes withdrawn and keeps ownerDisabled; nothing is left in flight to abort',
    check: async () => {
      const h = harness({ run: untilAborted });
      const hook = await declare(h);
      await h.open();
      h.dispatch();
      await runStarted(h);
      await h.hooks.update(hook.id, { enabled: false });
      await h.drain();
      const before = h.calls.length;
      await h.hooks.reconcileDeclared('slack', []);
      expect(await h.hooks.get(hook.id)).toMatchObject({
        enabled: false,
        revision: 3,
        declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: true },
      });
      expect(h.calls).toHaveLength(before);
      expect(await h.statuses(hook.id)).toEqual(['aborted']);
    },
  },
];

const ROWS: readonly Row[] = [
  ...RECORD_ROWS,
  ...RECONCILE_ROWS,
  ...DISPATCH_ROWS,
  ...OWNER_ROWS,
  ...RACE_ROWS,
  ...WITHDRAWAL_ROWS,
];

describe('the outcome matrix of default hooks', () => {
  for (const row of ROWS) {
    it(`[${row.owner}, ${MATRIX} line ${row.line}] ${row.name}`, row.check);
  }
});
