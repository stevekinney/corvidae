/**
 * COR-2226 — a hook lists a kind a running plugin declares. The outcome matrix, one `describe` per
 * operation (create, update, dispatch, default-hook reconcile) and one test per cell, over five kinds:
 *
 * - a core kind (`run.settled`);
 * - a declared kind of a running plugin (`reports:digest-ready`, at 1.0.0);
 * - a declared kind whose plugin is gone, or is loaded at another version (a pin that is `missing`);
 * - an undeclared `<plugin>:<name>` (`nobody:thing`);
 * - another plugin's kind of the same name (`other:digest-ready`, at 2.0.0);
 * - the reaction's own plugin's kind (`slack:posted`, at 1.0.0), which a plugin action can never
 *   fire on (the source guard in dispatch, COR-2173), so it is refused where it is written.
 *
 * The hooks run the `slack` plugin's reaction; what the running plugins declare is a list the test
 * changes, read each time the hooks ask.
 */
import { describe, expect, it } from 'bun:test';

import type { DeclaredHookEventKind } from './hook-event-kinds.ts';
import { createHookStore } from './hook-store.ts';
import { HookError, type HookRecord } from './hook-types.ts';
import { reconcilePluginHooks } from './reconcile-plugin-hooks.ts';
import { workspaceHookEvents } from './workspace-hook-events.ts';
import {
  ACTION,
  START,
  harness,
  runStarted,
  type Harness,
} from './hooks-reactions.test-support.ts';

const REPORTS = 'reports:digest-ready';
const OTHER = 'other:digest-ready';
const PINNED = `${REPORTS}@1.0.0`;
/** A kind the `slack` plugin declares, whose reaction every plugin hook here runs. */
const OWN = 'slack:posted';

/** The harness, with `declared` as what the running plugins declare now; change it to load or unload one. */
function plugins(initial: readonly DeclaredHookEventKind[] = defaultDeclared()) {
  const declared: { list: readonly DeclaredHookEventKind[] } = { list: initial };
  const h = harness({ declaredEvents: () => declared.list });
  return { h, declared };
}

function defaultDeclared(): DeclaredHookEventKind[] {
  return [
    { kind: REPORTS, version: '1.0.0' },
    { kind: OTHER, version: '2.0.0' },
    { kind: OWN, version: '1.0.0' },
  ];
}

/** The refusal of a plugin action on its own plugin's kind, which says why. */
function expectOwnKindRefusal(refused: HookError, path: readonly string[]): void {
  expect(refused.code).toBe('invalid');
  expect(refused.issues[0]?.path).toEqual([...path]);
  expect(refused.issues[0]?.message).toContain(
    "A plugin's reaction cannot run on that plugin's own events",
  );
}

async function refusal(work: Promise<unknown>): Promise<HookError> {
  const outcome = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(outcome).toBeInstanceOf(HookError);
  return outcome as HookError;
}

async function storedEvents(h: Harness, hookId: string): Promise<readonly string[]> {
  const stored = await createHookStore(h.kv).getHook(hookId);
  expect(stored).toBeDefined();
  return stored!.record.events;
}

/** Dispatches one event of `kind` from `source` and waits for whatever deliveries it made. */
async function fire(h: Harness, kind: string, source?: string): Promise<void> {
  h.dispatch({
    kind,
    payload: { runId: 'r1' },
    ...(source === undefined ? {} : { source }),
  });
  await h.drain();
}

async function problemsOf(h: Harness, hookId: string) {
  const listed = await h.hooks.list();
  return listed.find((hook) => hook.id === hookId)?.problems;
}

describe('create', () => {
  it('stores a core kind as it is', async () => {
    const { h } = plugins();
    const hook = await h.hook(['run.settled']);
    expect(await storedEvents(h, hook.id)).toEqual(['run.settled']);
  });

  it('stores a declared kind of a running plugin as written plus @version, and answers it so (AC5)', async () => {
    const { h } = plugins();
    const hook = await h.hook([REPORTS, 'run.settled']);
    expect(hook.events).toEqual([PINNED, 'run.settled']);
    expect(await storedEvents(h, hook.id)).toEqual([PINNED, 'run.settled']);
  });

  it('stores a kind given pinned at the version loaded now as it is, and lists each kind once', async () => {
    const { h } = plugins();
    const hook = await h.hook([PINNED, REPORTS]);
    expect(await storedEvents(h, hook.id)).toEqual([PINNED]);
  });

  it('refuses a pinned kind whose plugin is gone, or that is pinned to a version not loaded, at events', async () => {
    const { h } = plugins([{ kind: REPORTS, version: '1.1.0' }]);
    const stale = await refusal(h.hook([PINNED]));
    expect(stale.code).toBe('invalid');
    expect(stale.issues[0]?.path).toEqual(['events']);
    const gone = await refusal(h.hook([`${OTHER}@2.0.0`]));
    expect(gone.issues[0]?.path).toEqual(['events']);
  });

  it('refuses an undeclared <plugin>:<name> at events', async () => {
    const { h } = plugins();
    const refused = await refusal(h.hook(['nobody:thing']));
    expect(refused.issues[0]?.path).toEqual(['events']);
    expect(await h.hooks.list()).toEqual([]);
  });

  it('pins another plugin’s kind of the same name to that plugin’s version, a kind of its own', async () => {
    const { h } = plugins();
    const hook = await h.hook([REPORTS, OTHER]);
    expect(await storedEvents(h, hook.id)).toEqual([PINNED, `${OTHER}@2.0.0`]);
  });

  it('refuses a plugin kind for a start-workflow hook and for a scoped hook, which no plugin kind can serve', async () => {
    const { h } = plugins();
    const workflow = await refusal(
      h.hooks.create({ events: [REPORTS], action: { type: 'start-workflow', workflowId: 'w' } }),
    );
    expect(workflow.issues[0]?.path).toEqual(['events']);
    const scoped = await refusal(
      h.hooks.create({ events: [REPORTS], action: ACTION, scope: { kind: 'agent', id: 'scout' } }),
    );
    expect(scoped.issues[0]?.path).toEqual(['scope']);
  });

  it('refuses a plugin action on its own plugin’s kind at events, bare or pinned, and writes nothing', async () => {
    const { h } = plugins();
    expectOwnKindRefusal(await refusal(h.hook([OWN])), ['events']);
    expectOwnKindRefusal(await refusal(h.hook(['run.settled', `${OWN}@1.0.0`])), ['events']);
    expect(await h.hooks.list()).toEqual([]);
  });

  it('refuses an entry that is not a string, saying each event kind must be a string', async () => {
    const { h } = plugins();
    const refused = await refusal(h.hook([7 as unknown as string]));
    expect(refused.issues[0]).toEqual({
      path: ['events'],
      message: 'Each event kind must be a string',
    });
  });

  it('refuses an entry longer than the 256 characters the wire allows, given or once pinned, at events', async () => {
    // 254 characters bare, 260 once pinned.
    const long = `reports:${'x'.repeat(246)}`;
    const { h } = plugins([{ kind: long, version: '1.0.0' }]);
    const given = await refusal(h.hook([`run.settled${'x'.repeat(250)}`]));
    expect(given.issues[0]?.path).toEqual(['events']);
    expect(given.issues[0]?.message).toContain('at most 256 characters');
    const pinned = await refusal(h.hooks.create({ events: [long], action: { type: 'notify' } }));
    expect(long.length).toBeLessThanOrEqual(256);
    expect(pinned.issues[0]?.path).toEqual(['events']);
    expect(pinned.issues[0]?.message).toContain('longer than 256 characters');
    expect(await h.hooks.list()).toEqual([]);
  });

  it('accepts a notify hook on a plugin’s kind, and a plugin action on another plugin’s kind', async () => {
    const { h } = plugins();
    const notify = await h.hooks.create({ events: [OWN], action: { type: 'notify' } });
    expect(notify.events).toEqual([`${OWN}@1.0.0`]);
    const foreign = await h.hook([REPORTS]);
    expect(foreign.events).toEqual([PINNED]);
  });

  it('copies a hook with its pins on duplicate, and refuses the copy of a hook whose kind is missing, as create does', async () => {
    const { h, declared } = plugins();
    const hook = await h.hook([REPORTS, 'run.settled']);
    const copy = await h.hooks.duplicate(hook.id);
    expect(copy?.events).toEqual([PINNED, 'run.settled']);
    declared.list = [];
    const refused = await refusal(h.hooks.duplicate(hook.id));
    expect(refused.issues[0]?.path).toEqual(['events']);
  });
});

describe('update', () => {
  it('replaces the list with a core kind as it is', async () => {
    const { h } = plugins();
    const hook = await h.hook([REPORTS]);
    await h.hooks.update(hook.id, { events: ['run.registered'] });
    expect(await storedEvents(h, hook.id)).toEqual(['run.registered']);
  });

  it('pins a declared kind of a running plugin as it writes', async () => {
    const { h } = plugins();
    const hook = await h.hook(['run.settled']);
    const updated = await h.hooks.update(hook.id, { events: ['run.settled', REPORTS] });
    expect(updated?.events).toEqual(['run.settled', PINNED]);
    expect(await storedEvents(h, hook.id)).toEqual(['run.settled', PINNED]);
  });

  it('keeps a missing kind the hook already lists, so the hook still saves, and refuses a missing kind it does not', async () => {
    const { h, declared } = plugins();
    const hook = await h.hook([PINNED, 'run.settled']);
    declared.list = [];
    const renamed = await h.hooks.update(hook.id, {
      name: 'Digest',
      events: [PINNED, 'run.settled'],
    });
    expect(renamed?.events).toEqual([PINNED, 'run.settled']);
    const added = await refusal(
      h.hooks.update(hook.id, { events: [PINNED, `${OTHER}@2.0.0`, 'run.settled'] }),
    );
    expect(added.issues[0]?.path).toEqual(['events']);
    expect(await storedEvents(h, hook.id)).toEqual([PINNED, 'run.settled']);
  });

  it('re-pins a kind named bare to the version loaded now, in place of a missing pin of the same kind', async () => {
    const { h, declared } = plugins();
    const hook = await h.hook([REPORTS]);
    declared.list = [{ kind: REPORTS, version: '1.1.0' }];
    const updated = await h.hooks.update(hook.id, { events: [PINNED, REPORTS] });
    expect(updated?.events).toEqual([`${REPORTS}@1.1.0`]);
  });

  it('refuses an undeclared <plugin>:<name> and writes nothing', async () => {
    const { h } = plugins();
    const hook = await h.hook([REPORTS]);
    const refused = await refusal(h.hooks.update(hook.id, { events: ['nobody:thing'] }));
    expect(refused.issues[0]?.path).toEqual(['events']);
    expect(await storedEvents(h, hook.id)).toEqual([PINNED]);
  });

  it('pins another plugin’s kind of the same name to its own version', async () => {
    const { h } = plugins();
    const hook = await h.hook([REPORTS]);
    await h.hooks.update(hook.id, { events: [OTHER] });
    expect(await storedEvents(h, hook.id)).toEqual([`${OTHER}@2.0.0`]);
  });

  it('refuses events that list the plugin action’s own plugin’s kind, and writes nothing', async () => {
    const { h } = plugins();
    const hook = await h.hook(['run.settled']);
    expectOwnKindRefusal(await refusal(h.hooks.update(hook.id, { events: ['run.settled', OWN] })), [
      'events',
    ]);
    expect(await storedEvents(h, hook.id)).toEqual(['run.settled']);
  });

  it('still renames or turns off a hook written on its own plugin’s kind before the refusal', async () => {
    const { h } = plugins();
    const record = ownKindRecord('hook-predating');
    expect(await createHookStore(h.kv).createHook(record)).toBe(true);
    const renamed = await h.hooks.update(record.id, { name: 'Posted', enabled: false });
    expect(renamed?.name).toBe('Posted');
    expect(renamed?.enabled).toBe(false);
  });
});

/** A plugin hook on its own plugin's kind, as a record written before such a hook was refused. */
function ownKindRecord(id: string): HookRecord {
  return {
    version: 1,
    id,
    owner: 'anonymous:local',
    action: ACTION,
    events: [`${OWN}@1.0.0`, 'run.settled'],
    enabled: true,
    createdAt: START,
    updatedAt: START,
    revision: 1,
  };
}

describe('dispatch', () => {
  it('fires a hook on a core kind it lists', async () => {
    const { h } = plugins();
    await h.open();
    const hook = await h.hook(['run.settled', REPORTS]);
    await fire(h, 'run.settled');
    expect(await h.statuses(hook.id)).toEqual(['delivered']);
  });

  it('fires a hook on its plugin’s published event while the pinned version is loaded (AC2)', async () => {
    const { h } = plugins();
    await h.open();
    const hook = await h.hook([REPORTS]);
    await fire(h, REPORTS, 'reports');
    await runStarted(h);
    const [delivery] = await h.deliveries(hook.id);
    expect(delivery?.kind).toBe(REPORTS);
    expect(delivery?.status).toBe('delivered');
    expect(await problemsOf(h, hook.id)).toEqual([]);
  });

  it('reads a kind whose plugin is not loaded as missing, fires nothing for it, and still fires the others (AC3)', async () => {
    const { h, declared } = plugins();
    await h.open();
    const hook = await h.hook([REPORTS, 'run.settled']);
    declared.list = [];
    await fire(h, REPORTS, 'reports');
    expect(await h.deliveries(hook.id)).toEqual([]);
    expect(await problemsOf(h, hook.id)).toEqual([{ code: 'event-missing', kind: PINNED }]);
    await fire(h, 'run.settled');
    expect(await h.statuses(hook.id)).toEqual(['delivered']);
    const stillOn = await h.hooks.get(hook.id);
    expect(stillOn?.enabled).toBe(true);
  });

  it('reads a pin to a version other than the one loaded as missing, with the loaded version, and fires nothing (AC6)', async () => {
    const { h, declared } = plugins();
    await h.open();
    const hook = await h.hook([REPORTS]);
    expect(await storedEvents(h, hook.id)).toEqual([PINNED]);
    declared.list = [{ kind: REPORTS, version: '1.1.0' }];
    await fire(h, REPORTS, 'reports');
    expect(await h.deliveries(hook.id)).toEqual([]);
    expect(await problemsOf(h, hook.id)).toEqual([
      { code: 'event-missing', kind: PINNED, loadedVersion: '1.1.0' },
    ]);
  });

  it('never fires an undeclared <plugin>:<name> a record lists bare, and reads it as missing', async () => {
    const { h } = plugins([{ kind: 'nobody:thing', version: '1.0.0' }]);
    await h.open();
    const record: HookRecord = {
      version: 1,
      id: 'hook-seeded',
      owner: 'anonymous:local',
      action: ACTION,
      events: ['nobody:thing'],
      enabled: true,
      createdAt: START,
      updatedAt: START,
      revision: 1,
    };
    expect(await createHookStore(h.kv).createHook(record)).toBe(true);
    await fire(h, 'nobody:thing', 'nobody');
    expect(await h.deliveries(record.id)).toEqual([]);
    expect(await problemsOf(h, record.id)).toEqual([
      { code: 'event-missing', kind: 'nobody:thing', loadedVersion: '1.0.0' },
    ]);
  });

  it('lists no event-missing for a Bureau kind a record holds that this release does not publish', async () => {
    const { h } = plugins([]);
    const record: HookRecord = {
      version: 1,
      id: 'hook-retired',
      owner: 'anonymous:local',
      action: ACTION,
      events: ['run.retired', `${REPORTS}@1.0.0`],
      enabled: true,
      createdAt: START,
      updatedAt: START,
      revision: 1,
    };
    expect(await createHookStore(h.kv).createHook(record)).toBe(true);
    expect(await problemsOf(h, record.id)).toEqual([{ code: 'event-missing', kind: PINNED }]);
  });

  it('never fires a hook on another plugin’s kind of the same name, though both plugins run (AC4)', async () => {
    const { h } = plugins();
    await h.open();
    const hook = await h.hook([REPORTS]);
    await fire(h, OTHER, 'other');
    expect(await h.deliveries(hook.id)).toEqual([]);
    await fire(h, REPORTS, 'reports');
    const delivered = await h.deliveries(hook.id);
    expect(delivered.map((delivery) => delivery.kind)).toEqual([REPORTS]);
  });

  it('never runs a record written on its own plugin’s kind before the refusal: the source guard skips it with a notice', async () => {
    const { h } = plugins();
    await h.open();
    const record = ownKindRecord('hook-predating');
    expect(await createHookStore(h.kv).createHook(record)).toBe(true);
    // The event as `host.publish` gives it: from the plugin that declares the kind.
    await fire(h, OWN, 'slack');
    expect(await h.deliveries(record.id)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.notices).toContainEqual(
      expect.stringContaining(`Skipped: ${OWN} came from plugin slack`),
    );
    // Its other kinds still fire.
    await fire(h, 'run.settled');
    await runStarted(h);
    expect(await h.statuses(record.id)).toEqual(['delivered']);
  });

  it('under a workspace authority accepts and pins a plugin kind, but delivers nothing for it and lists no problem', async () => {
    const membership = (owner: string) => ({
      version: 1 as const,
      workspaceId: 'workspace-a',
      actorId: owner,
      actorKind: 'user' as const,
      owner,
      membershipRevision: 'membership-1',
      capabilities: ['workspace:use' as const, 'workspace:manage' as const],
    });
    const workspace = {
      workspaceId: 'workspace-a',
      resolveMembership: async ({ subject }: { readonly subject?: string }) =>
        membership(`api-key:${subject}`),
      resolveOwnerMembership: async (owner: string) => membership(owner),
    };
    const h = harness({
      declaredEvents: defaultDeclared,
      // The run the event names is the owner's, so only the plugin kind keeps it out.
      eventForHookOwner: workspaceHookEvents(workspace, async () => 'anonymous:local'),
    });
    await h.open();
    const hook = await h.hooks.create({ events: [REPORTS], action: { type: 'notify' } });
    expect(hook.events).toEqual([PINNED]);
    await fire(h, REPORTS, 'reports');
    expect(await h.deliveries(hook.id)).toEqual([]);
    expect(await problemsOf(h, hook.id)).toEqual([]);
  });

  it('never fires a pin whose plugin is gone on an event of the same name another plugin publishes', async () => {
    const { h, declared } = plugins();
    await h.open();
    const hook = await h.hook([REPORTS]);
    declared.list = [{ kind: OTHER, version: '1.0.0' }];
    await fire(h, OTHER, 'other');
    expect(await h.deliveries(hook.id)).toEqual([]);
    expect(await problemsOf(h, hook.id)).toEqual([{ code: 'event-missing', kind: PINNED }]);
  });
});

describe('default-hook reconcile', () => {
  const declaration = (events: readonly string[]) => ({
    name: 'Digest',
    events: [...events],
    reaction: 'post-message',
    configuration: { channel: 'ops' },
  });

  it('keeps a core kind as it is', async () => {
    const { h } = plugins();
    const [hook] = await h.hooks.reconcileDeclared('slack', [declaration(['run.settled'])]);
    expect(hook?.events).toEqual(['run.settled']);
  });

  it('pins a declared kind of a running plugin, writes nothing when it is unchanged, and re-pins in place on an upgrade', async () => {
    const { h, declared } = plugins();
    const [first] = await h.hooks.reconcileDeclared('slack', [declaration([REPORTS])]);
    expect(first?.events).toEqual([PINNED]);
    const [again] = await h.hooks.reconcileDeclared('slack', [declaration([REPORTS])]);
    expect(again?.revision).toBe(first?.revision);
    declared.list = [{ kind: REPORTS, version: '1.1.0' }];
    const [upgraded] = await h.hooks.reconcileDeclared('slack', [declaration([REPORTS])]);
    expect(upgraded?.id).toBe(first?.id);
    expect(upgraded?.events).toEqual([`${REPORTS}@1.1.0`]);
    expect(await storedEvents(h, first!.id)).toEqual([`${REPORTS}@1.1.0`]);
  });

  it('refuses a declaration whose kind’s plugin is gone, at [index, events], and writes nothing', async () => {
    const { h } = plugins([]);
    const refused = await refusal(h.hooks.reconcileDeclared('slack', [declaration([PINNED])]));
    expect(refused.issues[0]?.path).toEqual(['0', 'events']);
    expect(await h.hooks.list()).toEqual([]);
  });

  it('refuses an undeclared <plugin>:<name> at [index, events]', async () => {
    const { h } = plugins();
    const refused = await refusal(
      h.hooks.reconcileDeclared('slack', [declaration(['nobody:thing'])]),
    );
    expect(refused.issues[0]?.path).toEqual(['0', 'events']);
  });

  it('pins another plugin’s kind of the same name to that plugin’s version', async () => {
    const { h } = plugins();
    const [hook] = await h.hooks.reconcileDeclared('slack', [declaration([OTHER])]);
    expect(hook?.events).toEqual([`${OTHER}@2.0.0`]);
  });

  it('refuses a default hook on its own plugin’s kind at [index, events]', async () => {
    const { h } = plugins();
    expectOwnKindRefusal(await refusal(h.hooks.reconcileDeclared('slack', [declaration([OWN])])), [
      '0',
      'events',
    ]);
    expect(await h.hooks.list()).toEqual([]);
  });

  it('leaves a default hook on its own plugin’s kind out alone, as hook-invalid at events, and reconciles the rest', async () => {
    const { h } = plugins();
    const reported = new Map<string, readonly unknown[]>();
    await reconcilePluginHooks({
      hooks: h,
      plugins: {
        declaredHooks: () => [
          {
            plugin: 'slack',
            hooks: [{ ...declaration([OWN]), name: 'Own posts' }, declaration([OTHER])],
          },
        ],
        knownPlugins: () => new Set(['slack']),
        reportHookProblems: (plugin, problems) => void reported.set(plugin, [...problems]),
      },
      diagnose: () => undefined,
    });
    expect(reported.get('slack')).toEqual([{ hook: 'Own posts', path: 'events' }]);
    const listed = await h.hooks.list();
    expect(listed.map(({ name, events }) => [name, events])).toEqual([
      ['Digest', [`${OTHER}@2.0.0`]],
    ]);
  });
});
