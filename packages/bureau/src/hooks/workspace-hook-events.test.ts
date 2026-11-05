import { expect, test } from 'bun:test';
import { workspaceHookEvents } from './workspace-hook-events.ts';
import type { HookEventToDeliver } from './hook-delivery.ts';

const workspace = {
  workspaceId: 'workspace-a',
  resolveMembership: async ({ subject }: { readonly subject?: string }) => ({
    version: 1 as const,
    workspaceId: 'workspace-a',
    actorId: subject,
    actorKind: 'user' as const,
    owner: `api-key:${subject}`,
    membershipRevision: 'membership-1',
    capabilities: ['workspace:use' as const, 'workspace:manage' as const],
  }),
  resolveOwnerMembership: async (owner: string) => ({
    version: 1 as const,
    workspaceId: 'workspace-a',
    actorId: owner,
    actorKind: 'user' as const,
    owner,
    membershipRevision: 'membership-1',
    capabilities: ['workspace:use' as const, 'workspace:manage' as const],
  }),
};
const event = (kind: string, payload: Record<string, unknown>): HookEventToDeliver => ({
  kind,
  payload,
  bureauId: 'bureau-a',
  emittedAtMs: 1,
});

test('hook privacy rejects foreign and unknown event owners regardless of administration', async () => {
  const project = workspaceHookEvents(workspace, async ({ kind, ...resource }) =>
    kind === 'run' && 'id' in resource && resource.id === 'run-a' ? 'owner-a' : undefined,
  );
  const privateEvent = event('run.settled', { runId: 'run-a', result: 'PRIVATE-SENTINEL' });
  expect(await project('owner-a', privateEvent)).toEqual(privateEvent);
  expect(await project('owner-b', privateEvent)).toBeUndefined();
  expect(
    await project('owner-a', event('run.settled', { runId: 'missing', owner: 'owner-a' })),
  ).toBeUndefined();
  expect(await project('owner-a', event('invented', { runId: 'run-a' }))).toBeUndefined();
});

test('shared configuration hook events copy only their explicit metadata fields', async () => {
  const project = workspaceHookEvents(workspace, async () => undefined);
  const created = await project(
    'owner-b',
    event('schedule.created', {
      scheduleId: 'schedule-a',
      agentName: 'writer',
      sessionId: 'PRIVATE-SENTINEL',
      input: 'PRIVATE-SENTINEL',
    }),
  );
  expect(created?.payload).toEqual({ scheduleId: 'schedule-a', agentName: 'writer' });
  expect(JSON.stringify(created)).not.toContain('PRIVATE-SENTINEL');
  expect(
    await project('owner-b', event('schedule.missed', { scheduleId: 'missing' })),
  ).toBeUndefined();
});
