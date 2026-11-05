import { generateEncryptionKey } from '@lostgradient/cryptography';
import { expect, test } from 'bun:test';
import { createReceiver, SIGNING_SECRET } from '../hooks/hooks.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
const definition = {
  url: 'https://receiver.example/hook',
  events: ['definitions.changed'],
  signingSecret: SIGNING_SECRET,
};
const cases = [
  { operation: 'bureau.hooks.create', parameters: definition, deploymentOnly: false },
  { operation: 'bureau.hooks.update', parameters: { enabled: false }, deploymentOnly: false },
  { operation: 'bureau.hooks.delete', parameters: {}, deploymentOnly: false },
  { operation: 'bureau.hooks.get', parameters: {}, deploymentOnly: false },
  { operation: 'bureau.hooks.list', parameters: {}, deploymentOnly: false },
  { operation: 'bureau.hooks.test', parameters: {}, deploymentOnly: false },
  { operation: 'bureau.hooks.secret.replace', parameters: {}, deploymentOnly: true },
  { operation: 'bureau.hooks.deliveries', parameters: {}, deploymentOnly: true },
] as const;

for (const row of cases) {
  test(`${row.operation} enforces workspace configuration versus deployment authority across six actors`, async () => {
    const receiver = createReceiver(() => new Response('ok'));
    const opened = await openWorkspacePrivacyBureau({
      bureauOptions: {
        hooks: {},
        answerEncryption: { current: await generateEncryptionKey() },
        webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
      },
    });
    try {
      const seed = await workspacePrivacyCall(
        opened,
        'administrator',
        'bureau.hooks.create',
        definition,
      );
      expect(seed.body?.error).toBeUndefined();
      const hookId = seed.body?.result?.['id'];
      for (const actor of actors) {
        const parameters =
          row.operation === 'bureau.hooks.create' || row.operation === 'bureau.hooks.list'
            ? row.parameters
            : { ...row.parameters, hookId };
        const result = await workspacePrivacyCall(opened, actor, row.operation, parameters);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'administrator' && !row.deploymentOnly) {
          expect(result.body?.error).toBeUndefined();
          expect(result.text).not.toContain(SIGNING_SECRET);
          if (row.operation === 'bureau.hooks.list')
            expect(result.text).toContain('"lastDelivery":null');
        } else expect(result.body?.error?.data?.httpStatus).toBe(403);
      }
    } finally {
      await opened.dispose();
    }
  });
}
