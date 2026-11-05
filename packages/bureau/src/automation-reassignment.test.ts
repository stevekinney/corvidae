import { createAgent } from '@lostgradient/operative';
import { decode, KEYS } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { expect, it } from 'bun:test';
import { createBureau } from './create-bureau.ts';
import type { WorkspaceMembership } from './http/workspace-principal.ts';
import { createSqliteStorageFixture } from './test/storage-fixtures.ts';

it('reassigns future authority atomically, preserves ownership, records actors, and refuses stale or unprivileged writes', async () => {
  await using database = createSqliteStorageFixture();
  const members = new Map<string, WorkspaceMembership>(
    ['alice', 'bob', 'administrator'].map((owner) => [
      owner,
      {
        version: 1,
        workspaceId: 'workspace-a',
        actorId: `actor-${owner}`,
        actorKind: 'user',
        owner,
        membershipRevision: 'revision-1',
        capabilities:
          owner === 'administrator' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
      },
    ]),
  );
  const bureau = await createBureau({
    agents: {
      worker: createAgent({
        generate: async () => ({ content: 'done', toolCalls: [] }),
        toolbox: createToolbox([]),
      }),
    },
    storage: database.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    maintenance: 'manual',
    workspace: {
      workspaceId: 'workspace-a',
      resolveMembership: async () => null,
      resolveOwnerMembership: async (owner) => members.get(owner) ?? null,
    },
  });
  try {
    await bureau.recovery();
    const schedule = await bureau.schedules.create({
      agentName: 'worker',
      input: 'shared automation input',
      spec: '24h',
      principal: 'alice',
    });
    if (schedule === undefined) throw new Error('Schedule missing');
    const attempt = (
      administrator: string,
      targetOwner: string,
      expectedRevision = schedule.revision,
    ) =>
      bureau.schedules.reassign(schedule.id, { administrator, targetOwner, expectedRevision }).then(
        () => null,
        (error: unknown) => error,
      );
    expect(await attempt('alice', 'bob')).toBeInstanceOf(Error);
    expect(await attempt('administrator', 'removed')).toBeInstanceOf(Error);
    expect(await attempt('administrator', 'bob')).toBeNull();
    expect(await bureau.schedules.get(schedule.id)).toMatchObject({
      status: 'paused',
      revision: schedule.revision + 1,
    });
    expect(await bureau.ownerOf({ kind: 'schedule', id: schedule.id })).toBe('alice');
    const stored = decode((await database.storage.get(KEYS.schedule(schedule.id)))!);
    expect(stored).toMatchObject({
      input: {
        principal: 'alice',
        workspaceAuthority: { actorId: 'actor-bob', authorizingOwner: 'bob' },
      },
    });
    expect(await attempt('administrator', 'alice')).toBeInstanceOf(Error);
    const audit = await bureau.internals.auditTrail!.query({ runId: `schedule:${schedule.id}` });
    expect(audit.filter((record) => record.type === 'schedule.reassigned')).toHaveLength(1);
    expect(audit.find((record) => record.type === 'schedule.reassigned')?.detail).toMatchObject({
      previousActor: 'actor-alice',
      nextActor: 'actor-bob',
      administrator: 'actor-administrator',
    });
    await bureau.schedules.resume(schedule.id);
    expect(await bureau.schedules.get(schedule.id)).toMatchObject({
      status: 'active',
      revision: schedule.revision + 2,
    });
    const resumed = decode((await database.storage.get(KEYS.schedule(schedule.id)))!) as {
      input: { authorityHold?: string };
    };
    expect(resumed.input.authorityHold).toBeUndefined();
    await bureau.schedules.pause(schedule.id);
    members.delete('bob');
    const resume = await bureau.schedules.resume(schedule.id).then(
      () => null,
      (error: unknown) => error,
    );
    expect(resume).toBeInstanceOf(Error);
    expect(await bureau.schedules.get(schedule.id)).toMatchObject({ status: 'paused' });
  } finally {
    await bureau.dispose();
  }
});

it('pauses removed authority through maintenance and keeps the hold after restart and membership restoration', async () => {
  await using database = createSqliteStorageFixture();
  let present = true;
  let effects = 0;
  const open = () =>
    createBureau({
      agents: {
        worker: createAgent({
          generate: async () => {
            effects++;
            return { content: 'done', toolCalls: [] };
          },
          toolbox: createToolbox([]),
        }),
      },
      storage: database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      maintenance: 'manual',
      workspace: {
        workspaceId: 'workspace-a',
        resolveMembership: async () => null,
        resolveOwnerMembership: async (owner) =>
          present
            ? {
                version: 1,
                workspaceId: 'workspace-a',
                actorId: 'actor-alice',
                actorKind: 'user',
                owner,
                membershipRevision: 'r1',
                capabilities: ['workspace:use'],
              }
            : null,
      },
    });
  const first = await open();
  let scheduleId: string;
  try {
    await first.recovery();
    const schedule = await first.schedules.create({
      agentName: 'worker',
      input: 'automation',
      spec: '24h',
      principal: 'alice',
    });
    if (schedule === undefined) throw new Error('Schedule missing');
    scheduleId = schedule.id;
    present = false;
    await first.maintain();
    expect(await first.schedules.get(scheduleId)).toMatchObject({ status: 'paused' });
  } finally {
    await first.dispose();
  }
  present = true;
  const recovered = await open();
  try {
    await recovered.recovery();
    await recovered.maintain();
    expect(await recovered.schedules.get(scheduleId)).toMatchObject({ status: 'paused' });
    expect(await recovered.ownerOf({ kind: 'schedule', id: scheduleId })).toBe('alice');
    expect(effects).toBe(0);
    const stored = decode((await database.storage.get(KEYS.schedule(scheduleId)))!);
    expect(stored).toMatchObject({
      input: { authorityHold: 'revoked', workspaceAuthority: { actorId: 'actor-alice' } },
    });
  } finally {
    await recovered.dispose();
  }
});
