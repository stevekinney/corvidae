/**
 * COR-1894: a plugin's panel against the real host. The inspectors plugin's run inspector
 * is served, and its tool calls reach the real Bureau handler in process as the local owner, over
 * a run that has finished. The refusals of `panel-routes.test.ts` are repeated here only where
 * the host's own wiring matters: the guard in front of the real listener and the Bureau's handler
 * behind it.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES } from '@lostgradient/bureau';
import { AUTHORIZATION_SCOPES, principalFromApiKey } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin-home.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(authenticated = false): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-panels-'));
  directories.push(home);
  await enableDemoPlugin(home);
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  const workspaceId = bungalow.workspaceId;
  await bungalow.close();
  const member = (subject: string | undefined) =>
    subject === undefined || subject === 'removed'
      ? null
      : {
          version: 1 as const,
          workspaceId: subject === 'foreign' ? 'another-workspace' : workspaceId,
          actorId: subject,
          actorKind: 'user' as const,
          owner: `owner-${subject}`,
          membershipRevision: '1',
          capabilities:
            subject === 'administrator'
              ? ['workspace:use' as const, 'workspace:manage' as const]
              : ['workspace:use' as const],
        };
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    ...(authenticated
      ? {
          workspaceAuthentication: {
            authentication: {
              resolveApiKeyPrincipal: async (key: string) =>
                ['alice', 'bob', 'administrator', 'foreign', 'removed'].includes(key)
                  ? principalFromApiKey({
                      subject: key,
                      scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
                    })
                  : null,
            },
            workspace: {
              workspaceId,
              resolveMembership: async ({ subject }: { subject: string | undefined }) =>
                member(subject),
              resolveOwnerMembership: async (owner: string) => member(owner.replace(/^owner-/, '')),
            },
          },
        }
      : {}),
  });
  hosts.push(host);
  return host;
}

const PAGE = '/host/plugins/inspectors/apps/run-inspector';

function toolCall(
  host: Host,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL(`${PAGE}/tool-calls`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('the run inspector’s panel', () => {
  test('authenticated panels read only the invoking member’s private task', async () => {
    const host = await start(true);
    const run = await host.bureau.tasks.start('demo:assistant', 'private-input-sentinel', {
      principal: 'owner-alice',
    });
    await run.result();
    const owner = await toolCall(
      host,
      { name: 'bureau.tasks.inspect', arguments: { taskId: run.id } },
      { 'x-api-key': 'alice' },
    );
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ structuredContent: { task: { id: run.id } } });
    for (const actor of ['bob', 'administrator']) {
      const denied = await toolCall(
        host,
        { name: 'bureau.tasks.inspect', arguments: { taskId: run.id } },
        { 'x-api-key': actor, 'x-actor-id': 'alice', 'x-workspace-owner': 'owner-alice' },
      );
      const body = await denied.json();
      expect(body).toMatchObject({ isError: true });
      expect(JSON.stringify(body)).not.toContain('private-input-sentinel');
    }
    for (const actor of ['foreign', 'removed', 'attacker']) {
      const denied = await toolCall(
        host,
        { name: 'bureau.tasks.cancel', arguments: { taskId: run.id } },
        { 'x-api-key': actor },
      );
      expect([401, 403]).toContain(denied.status);
    }
  });

  test('lists the panels the plugin contributes, and serves the page of one as JSON', async () => {
    const host = await start();
    const listing = await fetch(new URL('/host/panels', host.url));
    const listed = (await listing.json()) as {
      apps: { plugin: string; app: string; opensFromTool: string }[];
    };
    expect(listed.apps).toContainEqual(
      expect.objectContaining({
        plugin: 'inspectors',
        app: 'run-inspector',
        opensFromTool: 'bureau.tasks.inspect',
      }),
    );
    const page = await fetch(new URL(PAGE, host.url));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('application/json');
    const body = (await page.json()) as { html: string; ui: unknown };
    expect(body.html).toContain('<div id="root">');
    expect(body.ui).toMatchObject({ csp: { connectDomains: [] } });
  });

  test('reads a finished run through bureau.tasks.inspect, as the local owner', async () => {
    const host = await start();
    const run = await host.bureau.tasks.start('demo:assistant', 'Who am I?');
    await run.result();
    const response = await toolCall(host, {
      name: 'bureau.tasks.inspect',
      arguments: { taskId: run.id },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      isError?: boolean;
      structuredContent?: { task: { id: string; status: string }; children: unknown[] };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.task.id).toBe(run.id);
    expect(result.structuredContent?.task.status).toBe('completed');
  });

  test('refuses a Bureau tool the app did not declare, and a toolbox tool', async () => {
    const host = await start();
    const run = await host.bureau.tasks.start('demo:assistant', 'Who am I?');
    await run.result();
    // The refusals that run nothing are asserted against a double in `panel-routes.test.ts`.
    for (const name of ['bureau.reviews.resolve', 'bureau.agents.list', 'read_file']) {
      const response = await toolCall(host, { name, arguments: { taskId: run.id } });
      expect(response.status).toBe(403);
    }
  });

  test('gives a request from another origin no HTML and runs no tool', async () => {
    const host = await start();
    const hostile = { origin: 'http://attacker.example' };
    const page = await fetch(new URL(PAGE, host.url), { headers: hostile });
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain('<div id="root">');
    const run = await host.bureau.tasks.start('demo:assistant', 'Who am I?');
    await run.result();
    const call = await toolCall(
      host,
      { name: 'bureau.tasks.cancel', arguments: { taskId: run.id } },
      hostile,
    );
    expect(call.status).toBe(403);
    expect(await call.text()).not.toContain('structuredContent');
  });

  test('answers 404 for a plugin or an app the host does not serve', async () => {
    const host = await start();
    for (const path of [
      '/host/plugins/nobody/apps/run-inspector',
      '/host/plugins/inspectors/apps/nothing',
    ]) {
      const response = await fetch(new URL(path, host.url));
      expect(response.status).toBe(404);
    }
  });
});
