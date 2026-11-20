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

test('a plugin’s event reaches no workspace hook, though its payload names a run the owner owns: no delivery and no leak (COR-2226)', async () => {
  const project = workspaceHookEvents(workspace, async ({ kind, ...resource }) =>
    kind === 'run' && 'id' in resource && resource.id === 'run-a' ? 'owner-a' : undefined,
  );
  const published: HookEventToDeliver = {
    ...event('reports:digest-ready', { runId: 'run-a', digest: 'PRIVATE-SENTINEL' }),
    source: 'reports',
  };
  for (const owner of ['owner-a', 'owner-b']) {
    expect(await project(owner, published)).toBeUndefined();
  }
});

test('the run outcome kinds are in the catalog, so a workspace hook gets its own run’s and no other’s (COR-2095)', async () => {
  const project = workspaceHookEvents(workspace, async ({ kind, ...resource }) =>
    kind === 'run' && 'id' in resource && resource.id === 'run-a' ? 'owner-a' : undefined,
  );
  for (const kind of ['run.completed', 'run.error', 'run.aborted', 'run.settled']) {
    const outcome = event(kind, { runId: 'run-a', finishReason: 'error' });
    expect(await project('owner-a', outcome)).toEqual(outcome);
    expect(await project('owner-b', outcome)).toBeUndefined();
  }
});

test('a workspace hook gets the child, handoff, hook-plan and steering events of its own runs and sessions only (COR-2097)', async () => {
  const project = workspaceHookEvents(workspace, async ({ kind, ...resource }) => {
    if (!('id' in resource)) return undefined;
    if (kind === 'run' && resource.id === 'run-a') return 'owner-a';
    if (kind === 'session' && resource.id === 'session-a') return 'owner-a';
    return undefined;
  });
  const ofRun = [
    event('multiagent.child-workflow.started', {
      parentRunId: 'run-a',
      childRunId: 'child-1',
      childAgentName: 'worker',
    }),
    event('multiagent.child-workflow.completed', { parentRunId: 'run-a', childRunId: 'child-1' }),
    event('multiagent.child-workflow.failed', {
      parentRunId: 'run-a',
      childRunId: 'child-1',
      finishReason: 'error',
    }),
    event('multiagent.child-workflow.aborted', { parentRunId: 'run-a', childRunId: 'child-1' }),
    event('multiagent.handoff.occurred', { runId: 'run-a', sourceAgentName: 'a' }),
    event('hook-plan.failed', { runId: 'run-a', hookId: 'h', errorCode: 'INTERNAL_ERROR' }),
  ];
  const ofSession = [
    'steering.applied',
    'steering.rejected',
    'steering.superseded',
    'steering.failed',
  ].map((kind) => event(kind, { sessionId: 'session-a', failureReason: 'policy-denied' }));
  for (const delivered of [...ofRun, ...ofSession]) {
    expect(await project('owner-a', delivered)).toEqual(delivered);
    expect(await project('owner-b', delivered)).toBeUndefined();
  }
  // A child whose parent is not a run the hook's owner can read is not delivered.
  expect(
    await project(
      'owner-a',
      event('multiagent.child-workflow.started', { parentRunId: 'run-b', childRunId: 'child-2' }),
    ),
  ).toBeUndefined();
});

test('a workspace hook is never given a version mismatch, which names no run, session or owner (COR-2097)', async () => {
  const project = workspaceHookEvents(workspace, async () => 'owner-a');
  const mismatch = event('workflow.version-mismatch', {
    workflowId: 'run-a',
    storedVersion: 'v1',
    registeredVersion: 'v2',
  });

  expect(await project('owner-a', mismatch)).toBeUndefined();
});

test('[COR-2100, matrix 122] a skills definitions.changed passes its five fields to every member’s hook', async () => {
  const project = workspaceHookEvents(workspace, async () => undefined);
  const changed = await project(
    'owner-b',
    event('definitions.changed', {
      catalog: 'skills',
      added: ['alpha'],
      changed: ['beta'],
      removed: ['gamma'],
      rejected: ['alpha'],
      sessionId: 'PRIVATE-SENTINEL',
    }),
  );
  expect(changed?.payload).toEqual({
    catalog: 'skills',
    added: ['alpha'],
    changed: ['beta'],
    removed: ['gamma'],
    rejected: ['alpha'],
  });
});

test('shared configuration hook events copy only their explicit metadata fields', async () => {
  const project = workspaceHookEvents(workspace, async () => undefined);
  const created = await project(
    'owner-b',
    event('schedule.created', {
      scheduleId: 'schedule-a',
      agentName: 'writer',
      target: { kind: 'agent', agentName: 'writer' },
      sessionId: 'PRIVATE-SENTINEL',
      input: 'PRIVATE-SENTINEL',
    }),
  );
  expect(created?.payload).toEqual({
    scheduleId: 'schedule-a',
    agentName: 'writer',
    target: { kind: 'agent', agentName: 'writer' },
  });
  expect(JSON.stringify(created)).not.toContain('PRIVATE-SENTINEL');
  expect(
    await project('owner-b', event('schedule.missed', { scheduleId: 'missing' })),
  ).toBeUndefined();
});
