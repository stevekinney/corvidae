import { afterEach, expect, test } from 'bun:test';
import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { waitForCondition } from '../../test';
import { serveWorkflows } from './workflows-fixtures.test-support.ts';
import {
  workspacePrivacyAuthentication,
  workspacePrivacyCall,
  workspacePrivacyDirectory,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from '../workspace-privacy-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const definition = {
  agent: 'writer',
  trigger: { kind: 'signal', name: 'workspace-go' },
  steps: [AGENT_STEP],
};
const cases = [
  ['bureau.workflows.create', 'administrator'],
  ['bureau.workflows.update', 'administrator'],
  ['bureau.workflows.validate', 'administrator'],
  ['bureau.workflows.pause', 'administrator'],
  ['bureau.workflows.resume', 'administrator'],
  ['bureau.workflows.delete', 'administrator'],
  ['bureau.workflows.get', 'shared'],
  ['bureau.workflows.list', 'shared'],
  ['bureau.workflows.revisions', 'shared'],
  ['bureau.workflows.history', 'shared'],
  ['bureau.workflows.impact', 'shared'],
  ['bureau.workflows.start', 'shared'],
  ['bureau.workflows.signal', 'shared'],
  ['bureau.workflows.runs.list', 'private-list'],
  ['bureau.workflows.runs.get', 'private-get'],
] as const;

for (const [operation, access] of cases) {
  test(`${operation} executes all six authenticated actor cases`, async () => {
    const served = await serveWorkflows(cleanups, {
      workspace: workspacePrivacyDirectory(),
      authentication: workspacePrivacyAuthentication,
    });
    const fixture = { handler: served.keyed };
    const created = await served.bureau.workflows!.create('workspace-flow', definition);
    const started = await workspacePrivacyCall(fixture, 'owner', 'bureau.workflows.start', {
      id: 'workspace-flow',
      input: { secret: 'PRIVATE-WORKFLOW-INPUT-d24a' },
    });
    expect(started.body?.error).toBeUndefined();
    const runId = started.body?.result?.['runId'];
    if (typeof runId !== 'string') throw new Error('Expected seeded run');
    await waitForCondition(
      async () => (await served.bureau.workflows!.getRun(runId)) !== undefined,
      'seeded run visible',
    );
    const input: Record<string, unknown> =
      operation === 'bureau.workflows.list' || operation === 'bureau.workflows.runs.list'
        ? {}
        : operation === 'bureau.workflows.runs.get'
          ? { runId }
          : operation === 'bureau.workflows.signal'
            ? { name: 'workspace-go', payload: { caller: 'new private run' } }
            : operation === 'bureau.workflows.create'
              ? { id: 'new-workspace-flow', definition }
              : operation === 'bureau.workflows.update' || operation === 'bureau.workflows.validate'
                ? { id: 'workspace-flow', expectedHash: created.hash, definition }
                : operation === 'bureau.workflows.impact'
                  ? { id: 'workspace-flow', definition }
                  : [
                        'bureau.workflows.pause',
                        'bureau.workflows.resume',
                        'bureau.workflows.delete',
                      ].includes(operation)
                    ? { id: 'workspace-flow', expectedHash: created.hash }
                    : { id: 'workspace-flow' };
    const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
    for (const actor of [
      ...actors.filter((value) => value !== 'administrator'),
      'administrator',
    ] as WorkspacePrivacyActor[]) {
      const result = await workspacePrivacyCall(fixture, actor, operation, input);
      if (actor === 'foreign' || actor === 'removed') {
        expect(result.status).toBe(403);
        continue;
      }
      if (access === 'administrator' && actor !== 'administrator') {
        expect(result.body?.error?.data?.httpStatus).toBe(403);
        continue;
      }
      if (access === 'private-get' && actor !== 'owner') {
        expect(result.body?.error?.data?.httpStatus).toBe(404);
        const unknown = await workspacePrivacyCall(fixture, actor, operation, {
          runId: 'unknown-run',
        });
        expect(JSON.stringify(result.body?.error).replaceAll(runId, '<id>')).toBe(
          JSON.stringify(unknown.body?.error).replaceAll('unknown-run', '<id>'),
        );
        continue;
      }
      expect(result.body?.error).toBeUndefined();
      if (access === 'private-list' && actor !== 'owner')
        expect(result.body?.result?.['runs']).toEqual([]);
      if (operation === 'bureau.workflows.revisions' && actor !== 'owner')
        expect(result.body?.result?.['revisions']).toEqual([]);
      if (operation === 'bureau.workflows.start') {
        const ownRun = result.body?.result?.['runId'];
        expect(typeof ownRun).toBe('string');
        expect(await served.bureau.ownerOf({ kind: 'run', id: String(ownRun) })).toBe(
          WORKSPACE_PRIVACY_ACTORS[actor].owner,
        );
      }
      if (operation === 'bureau.workflows.signal') {
        const ownRuns = result.body?.result?.['started'] as string[];
        expect(ownRuns).toHaveLength(1);
        expect(await served.bureau.ownerOf({ kind: 'run', id: ownRuns[0]! })).toBe(
          WORKSPACE_PRIVACY_ACTORS[actor].owner,
        );
      }
      if (actor !== 'owner') expect(result.text).not.toContain('PRIVATE-WORKFLOW-INPUT-d24a');
    }
  });
}
