import { describe, expect, test } from 'bun:test';

import { executeCli, parseCliArguments } from './cli-client.ts';

function response(data: unknown): Response {
  return Response.json(data);
}

describe('CLI configuration commands', () => {
  test('parses the complete configuration command surface', () => {
    for (const command of [
      'providers',
      'models',
      'tools',
      'tool-sources',
      'plugins',
      'skills',
      'settings',
    ]) {
      const parsed = parseCliArguments([command, '--help']);
      expect(parsed).toMatchObject({ exitCode: 0 });
    }
  });

  test('routes read commands through host APIs and Bureau operations', async () => {
    const calls: string[] = [];
    const result = async (arguments_: string[]) =>
      executeCli(arguments_, {
        fetch: async (url, init) => {
          calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
          if (new URL(url).pathname === '/bureau/jsonrpc') {
            const body = JSON.parse(
              typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
            ) as { method: string };
            const data =
              body.method === 'bureau.agents.catalog'
                ? { models: [{ model: 'anthropic/sonnet' }], tools: [{ name: 'lookup' }] }
                : body.method === 'bureau.skills.list'
                  ? { skills: [] }
                  : body.method === 'bureau.settings.get'
                    ? { values: {}, revision: 4 }
                    : { schema: {} };
            return response({ result: data });
          }
          return response({ configurationRevision: 'r1', providers: [], models: [], tools: [] });
        },
      });
    const providerResult = await result(['providers', 'list']);
    const modelsResult = await result(['models', 'list']);
    const toolsResult = await result(['tools', 'list']);
    const sourcesResult = await result(['tool-sources', 'list']);
    const pluginsResult = await result(['plugins', 'list']);
    const skillsResult = await result(['skills', 'list']);
    const settingsResult = await result(['settings', 'get']);
    expect(providerResult.exitCode).toBe(0);
    expect(modelsResult.exitCode).toBe(0);
    expect(toolsResult.exitCode).toBe(0);
    expect(sourcesResult.exitCode).toBe(0);
    expect(pluginsResult.exitCode).toBe(0);
    expect(skillsResult.exitCode).toBe(0);
    expect(settingsResult.exitCode).toBe(0);
    expect(calls).toEqual([
      'GET /host/providers',
      'POST /bureau/jsonrpc',
      'POST /bureau/jsonrpc',
      'GET /host/tool-sources',
      'GET /host/plugins',
      'POST /bureau/jsonrpc',
      'POST /bureau/jsonrpc',
    ]);
  });

  test('uses protected secret input and sends one revisioned provider mutation', async () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const result = await executeCli(['providers', 'connect', 'anthropic', '--secret-stdin'], {
      stdin: async () => 'not-an-argument-secret\n',
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method ?? 'GET', path, body });
        return path === '/host/providers'
          ? response({ configurationRevision: 'r1', providers: [] })
          : response({ providers: [], revision: 'r2' });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/host/providers/anthropic' });
    expect(calls[1]?.body).toMatchObject({
      operationId: expect.any(String),
      expectedRevision: 'r1',
    });
    expect(JSON.stringify(result)).not.toContain('not-an-argument-secret');
  });

  test('never opens OAuth when no-open is requested and reports settings restart state', async () => {
    let opened = false;
    const calls: string[] = [];
    const result = await executeCli(['tool-sources', 'authorize', 'github', '--no-open'], {
      open: () => {
        opened = true;
      },
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        return path === '/host/tool-sources'
          ? response({ configurationRevision: 'r1' })
          : response({ authorized: false, authorizationUrl: 'https://auth.invalid/' });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(opened).toBe(false);
    expect(calls).toEqual(['GET /host/tool-sources', 'POST /host/tool-sources/github/authorize']);
  });

  test('settings set reads the current revision before updating', async () => {
    const methods: string[] = [];
    const result = await executeCli(['settings', 'set', '--input', '{"tools.wakeup":false}'], {
      fetch: async (_url, init) => {
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
        ) as {
          method: string;
          params: Record<string, unknown>;
        };
        methods.push(body.method);
        return response(
          body.method.endsWith('.get')
            ? { result: { revision: 3 } }
            : { result: { revision: 4, pendingRestart: [] } },
        );
      },
    });
    expect(result.exitCode).toBe(0);
    expect(methods).toEqual(['bureau.settings.get', 'bureau.settings.update']);
  });

  test('treats an aborted DELETE as an unknown mutation outcome', async () => {
    const result = await executeCli(['providers', 'disconnect', 'anthropic'], {
      fetch: async (_url, init) => {
        if (init?.method === 'DELETE') throw new DOMException('aborted', 'AbortError');
        return response({ configurationRevision: 'r1' });
      },
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('The mutation outcome is unknown.');
  });
});
