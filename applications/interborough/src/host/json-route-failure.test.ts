import { describe, expect, test } from 'bun:test';

import type { HostAuthority } from './host-authority.ts';
import type { HostMutationContext } from './host-mutation-context.ts';
import { HOST_PLUGINS_ROUTE, pluginRoutes } from './plugin-routes.ts';
import { HOST_PROVIDERS_ROUTE, providerRoutes } from './provider-routes.ts';
import { HOST_SKILLS_REFRESH_ROUTE, skillRoutes } from './skill-routes.ts';
import { HOST_TOOL_SOURCES_ROUTE, toolSourceRoutes } from './tool-source-routes.ts';

const refuse = () => undefined;
const authority: Pick<HostAuthority, 'mutation'> = {
  mutation: async () => ({}) as HostMutationContext,
};

function failureLog() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

async function assertFailure(
  response: Response,
  lines: string[],
  message: string,
  method: string,
  route: string,
) {
  expect(response.status).toBe(500);
  const body = (await response.json()) as { error: string; message: string; requestId: string };
  expect(body).toEqual({ error: 'failed', message, requestId: expect.any(String) });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({
    event: 'host.json.failure',
    requestId: body.requestId,
    method,
    route,
  });
  expect(lines[0]).not.toContain('secret');
  expect(lines[0]).not.toContain('/private');
}

describe('unexpected host JSON route failures', () => {
  test('correlates provider failures without exposing the exception', async () => {
    const { lines, log } = failureLog();
    const routes = providerRoutes(
      {
        snapshot: async () => {
          throw new Error('secret /private/provider.json');
        },
      } as never,
      refuse,
      authority,
      log,
    );
    await assertFailure(
      await routes[HOST_PROVIDERS_ROUTE].GET(new Request('http://host/host/providers')),
      lines,
      'The provider configuration could not be changed.',
      'GET',
      HOST_PROVIDERS_ROUTE,
    );
  });

  test('correlates plugin failures without exposing the exception', async () => {
    const { lines, log } = failureLog();
    const routes = pluginRoutes(
      {
        snapshot: async () => {
          throw new Error('secret /private/plugin.json');
        },
      } as never,
      refuse,
      authority,
      log,
    );
    await assertFailure(
      await routes[HOST_PLUGINS_ROUTE].GET(new Request('http://host/host/plugins')),
      lines,
      'The plugin settings could not be changed.',
      'GET',
      HOST_PLUGINS_ROUTE,
    );
  });

  test('correlates skill failures without exposing the exception', async () => {
    const { lines, log } = failureLog();
    const routes = skillRoutes(
      {
        refresh: async () => {
          throw new Error('secret /private/skills.json');
        },
      } as never,
      refuse,
      authority,
      log,
    );
    await assertFailure(
      await routes[HOST_SKILLS_REFRESH_ROUTE].POST(new Request('http://host/host/skills/refresh')),
      lines,
      'The skill configuration could not be changed.',
      'POST',
      HOST_SKILLS_REFRESH_ROUTE,
    );
  });

  test('correlates tool-source failures without exposing the exception', async () => {
    const { lines, log } = failureLog();
    const routes = toolSourceRoutes(
      {
        snapshot: async () => {
          throw new Error('secret /private/source.json');
        },
      } as never,
      refuse,
      { mutation: authority.mutation },
      log,
    );
    await assertFailure(
      await routes[HOST_TOOL_SOURCES_ROUTE].GET(new Request('http://host/host/tool-sources')),
      lines,
      'The tool source configuration could not be changed.',
      'GET',
      HOST_TOOL_SOURCES_ROUTE,
    );
  });
});
