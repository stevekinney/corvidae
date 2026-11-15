import { expect, test } from 'bun:test';
import { workspaceConformanceLedger } from './workspace-conformance-ledger.test-support.ts';
import { readFrames, subscribeRequest } from './management/management-fixtures.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const witnesses = workspaceConformanceLedger('workspace-settings-privacy.test.ts');
const sentinel = 'PRIVATE-SETTINGS-NEIGHBOR-a81c';
const cases = [
  { operation: 'bureau.settings.get', input: {} },
  { operation: 'bureau.settings.schema', input: {} },
  { operation: 'bureau.decisions.models', input: {} },
  {
    operation: 'bureau.settings.update',
    input: { patch: { 'tools.wakeup': false }, expectedRevision: 0 },
  },
] as const;

for (const row of cases) {
  test(`${row.operation} requires current workspace administration for all six actors`, async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const task = await opened.bureau.tasks.start('default', sentinel, {
        principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
      });
      const owner = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.get', {
        contextId: task.contextId,
      });
      expect(owner.text).toContain(sentinel);
      witnesses.confirmPrivateSource(row.operation, owner);
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const result = await workspacePrivacyCall(opened, actor, row.operation, row.input);
        expect(result.text).not.toContain(sentinel);
        witnesses.observeWire(row.operation, actor, result);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'administrator') expect(result.body?.error).toBeUndefined();
        else expect(result.body?.error?.data?.httpStatus).toBe(403);
      }
      const snapshot = await opened.bureau.settings.get();
      expect(snapshot.revision).toBe(row.operation === 'bureau.settings.update' ? 1 : 0);
    } finally {
      await opened.dispose();
    }
  });
}

test('bureau.settings.events exposes configuration change events only to the administrator', async () => {
  const opened = await openWorkspacePrivacyBureau();
  try {
    const task = await opened.bureau.tasks.start('default', sentinel, {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    const owner = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.get', {
      contextId: task.contextId,
    });
    expect(owner.text).toContain(sentinel);
    witnesses.confirmEventPrivateSource('bureau.settings.events', owner);
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const response = await opened.handler(
        subscribeRequest('bureau.settings.events', {}, WORKSPACE_PRIVACY_ACTORS[actor].key),
      );
      await witnesses.observeStream('bureau.settings.events', actor, response);
      if (actor !== 'administrator') expect(response.status).toBe(403);
      else {
        expect(response.status).toBe(200);
        await opened.bureau.settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
        const frames = await readFrames(response, { stop: (seen) => seen.length > 0 });
        witnesses.observeEventFrames('bureau.settings.events', actor, frames);
        expect(frames.length).toBeGreaterThan(0);
        expect(JSON.stringify(frames)).toContain('revision');
        expect(JSON.stringify(frames)).not.toContain(sentinel);
      }
    }
  } finally {
    await opened.dispose();
  }
});

test('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
