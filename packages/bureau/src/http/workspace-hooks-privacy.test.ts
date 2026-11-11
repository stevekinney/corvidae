import { generateEncryptionKey } from '@lostgradient/cryptography';
import { expect, test } from 'bun:test';
import { workspaceConformanceLedger } from './workspace-conformance-ledger.test-support.ts';
import { createReceiver, SIGNING_SECRET } from '../hooks/hooks.test-support.ts';
import { HOOK_SIGNATURE_HEADER } from '../hooks/hook-signature.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
const witnesses = workspaceConformanceLedger('workspace-hooks-privacy.test.ts');
const neighbor = 'PRIVATE-HOOK-NEIGHBOR-a44b';
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
  {
    operation: 'bureau.hooks.deliveries.retry',
    parameters: { deliveryId: 'delivery-missing' },
    deploymentOnly: true,
  },
  {
    operation: 'bureau.hooks.draft.test',
    parameters: { url: definition.url },
    deploymentOnly: true,
  },
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
      const task = await opened.bureau.tasks.start('default', neighbor, {
        principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
      });
      const owner = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.get', {
        contextId: task.contextId,
      });
      expect(owner.text).toContain(neighbor);
      if (!row.deploymentOnly) witnesses.confirmPrivateSource(row.operation, owner);
      const seed = await workspacePrivacyCall(
        opened,
        'administrator',
        'bureau.hooks.create',
        definition,
      );
      expect(seed.body?.error).toBeUndefined();
      const hookId = seed.body?.result?.['id'];
      for (const actor of actors) {
        // A draft names no hook: it is tested before one exists.
        const parameters =
          row.operation === 'bureau.hooks.create' ||
          row.operation === 'bureau.hooks.list' ||
          row.operation === 'bureau.hooks.draft.test'
            ? row.parameters
            : { ...row.parameters, hookId };
        const result = await workspacePrivacyCall(opened, actor, row.operation, parameters);
        expect(result.text).not.toContain(neighbor);
        witnesses.observeWire(row.operation, actor, result);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'administrator' && !row.deploymentOnly) {
          expect(result.body?.error).toBeUndefined();
          expect(result.text).not.toContain(SIGNING_SECRET);
          if (row.operation === 'bureau.hooks.test') {
            const signature = receiver.calls.at(-1)?.headers.get(HOOK_SIGNATURE_HEADER);
            expect(signature).toBeTruthy();
            expect(result.text).not.toContain(signature!);
            expect(result.text.toLowerCase()).not.toContain(HOOK_SIGNATURE_HEADER.toLowerCase());
          }
          if (row.operation === 'bureau.hooks.list')
            expect(result.text).toContain('"lastDelivery":null');
        } else expect(result.body?.error?.data?.httpStatus).toBe(403);
      }
    } finally {
      await opened.dispose();
    }
  });
}

test('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
