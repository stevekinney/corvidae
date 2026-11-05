import { expect, test } from 'bun:test';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const sentinel = 'PRIVATE-SCHEDULE-INPUT-9b34';
const definition = { agentName: 'default', spec: '1h', input: sentinel };
const cases = [
  { operation: 'bureau.schedules.create', parameters: definition, privateExecution: false },
  { operation: 'bureau.schedules.list', parameters: {}, privateExecution: false },
  { operation: 'bureau.schedules.get', parameters: {}, privateExecution: false },
  { operation: 'bureau.schedules.pause', parameters: {}, privateExecution: false },
  { operation: 'bureau.schedules.resume', parameters: {}, privateExecution: false },
  { operation: 'bureau.schedules.cancel', parameters: {}, privateExecution: false },
  { operation: 'bureau.schedules.update', parameters: { spec: '2h' }, privateExecution: false },
  { operation: 'bureau.schedules.skipnext', parameters: {}, privateExecution: false },
  { operation: 'bureau.schedules.runnow', parameters: {}, privateExecution: true },
  { operation: 'bureau.schedules.missed', parameters: {}, privateExecution: true },
] as const;

for (const row of cases) {
  test(`${row.operation} exercises every actor against an independently seeded schedule`, async () => {
    const opened = await openWorkspacePrivacyBureau({
      a2aAgents: ['default'],
      generate: async () => ({ content: 'private schedule output', toolCalls: [] }),
    });
    try {
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const seed = await opened.bureau.schedules.create({
          ...definition,
          principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
        });
        if (seed === undefined) throw new Error('Expected seeded schedule');
        if (row.operation === 'bureau.schedules.resume')
          await opened.bureau.schedules.pause(seed.id);
        const input =
          row.operation === 'bureau.schedules.create' || row.operation === 'bureau.schedules.list'
            ? row.parameters
            : { ...row.parameters, scheduleId: seed.id };
        const result = await workspacePrivacyCall(opened, actor, row.operation, input);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === (row.privateExecution ? 'owner' : 'administrator')) {
          expect(result.body?.error).toBeUndefined();
          if (row.operation === 'bureau.schedules.create') expect(result.text).toContain(sentinel);
          else expect(result.text).not.toContain(sentinel);
          if (row.operation === 'bureau.schedules.get')
            expect(result.body?.result).toMatchObject({
              inputPreview: null,
              lastFireAt: null,
              missedFireCount: null,
              skippedCount: null,
            });
        } else if (row.privateExecution) {
          expect(result.body?.error?.data?.httpStatus).toBe(404);
          const missing = await workspacePrivacyCall(opened, actor, row.operation, {
            ...row.parameters,
            scheduleId: 'unknown-schedule',
          });
          expect(JSON.stringify(result.body?.error).replaceAll(seed.id, '<id>')).toBe(
            JSON.stringify(missing.body?.error).replaceAll('unknown-schedule', '<id>'),
          );
        } else expect(result.body?.error?.data?.httpStatus).toBe(403);
      }
    } finally {
      await opened.dispose();
    }
  });
}
