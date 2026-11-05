import { expect, test } from 'bun:test';
import { principalFromApiKey, type AuthenticatedPrincipal } from '../principal.ts';
import { createWorkspaceRevalidation, guardWorkspaceResponse } from './workspace-release.ts';

function principal(): AuthenticatedPrincipal {
  return {
    ...principalFromApiKey({ subject: 'credential', scopes: ['workflows:read'] }),
    workspace: {
      version: 1,
      workspaceId: 'workspace-a',
      actorId: 'actor-a',
      actorKind: 'user',
      owner: 'opaque-owner-a',
      membershipRevision: 'revision-1',
      capabilities: ['workspace:use'],
    },
  };
}

test('workspace revalidation pins identity but accepts a new current membership revision', async () => {
  const original = principal();
  let current = original;
  const check = createWorkspaceRevalidation(
    async () => ({ method: 'api-key', principal: current }),
    new Request('http://localhost/stream'),
    original,
  );
  expect(await check?.()).toBe(true);
  current = { ...current, workspace: { ...original.workspace!, membershipRevision: 'revision-2' } };
  expect(await check?.()).toBe(true);
  current = { ...current, workspace: { ...original.workspace!, actorId: 'actor-b' } };
  expect(await check?.()).toBe(false);
});

test('a buffered private frame is discarded when membership is removed before release', async () => {
  let current = true;
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = await guardWorkspaceResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          source = controller;
        },
      }),
    ),
    async () => current,
  );
  const pending = response.text();
  current = false;
  source!.enqueue(new TextEncoder().encode('PRIVATE-FRAME-MUST-NOT-LEAK'));
  expect(await pending).toBe('');
});

test('authority loss after a handler settles refuses the response body', async () => {
  const response = await guardWorkspaceResponse(new Response('PRIVATE-RESULT'), async () => false);
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('PRIVATE-RESULT');
});
