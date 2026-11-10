import { describe, expect, test } from 'bun:test';

import { parseCliArguments } from './cli-client.ts';

async function commandRunner(
  ...arguments_: Parameters<(typeof import('./cli-client.ts'))['executeCli']>
) {
  const { executeCli } = await import('./cli-client.ts');
  return executeCli(...arguments_);
}

function response(data: unknown): Response {
  return Response.json(data);
}

function pathname(url: RequestInfo | URL): string {
  return new URL(typeof url === 'string' || url instanceof URL ? url : url.url).pathname;
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
      commandRunner(arguments_, {
        fetch: async (url, init) => {
          calls.push(`${init?.method ?? 'GET'} ${pathname(url)}`);
          if (pathname(url) === '/bureau/jsonrpc') {
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
    const result = await commandRunner(['providers', 'connect', 'anthropic', '--secret-stdin'], {
      stdin: async () => 'not-an-argument-secret\n',
      fetch: async (url, init) => {
        const path = pathname(url);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method ?? 'GET', path, body });
        if (path === '/bureau/jsonrpc')
          return response({
            result: {
              providers: [
                { plugin: 'anthropic', name: 'anthropic', configuration: { type: 'object' } },
              ],
            },
          });
        return path === '/host/providers'
          ? response({ configurationRevision: 'r1', providers: [] })
          : response({ providers: [], revision: 'r2' });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ method: 'PUT', path: '/host/providers/anthropic' });
    expect(calls[2]?.body).toMatchObject({
      operationId: expect.any(String),
      expectedRevision: 'r1',
    });
    expect(JSON.stringify(result)).not.toContain('not-an-argument-secret');
  });

  test('writes provider plugin configuration through its schema-bearing plugin route', async () => {
    const calls: string[] = [];
    const inputPath = '/tmp/cor2061-provider.json';
    await Bun.write(
      inputPath,
      JSON.stringify({
        apiKey: 'provider-secret',
        configuration: { baseURL: 'https://api.invalid' },
      }),
    );
    const result = await commandRunner(
      ['providers', 'connect', 'openai', '--input-file', inputPath],
      {
        fetch: async (url, init) => {
          const path = pathname(url);
          calls.push(`${init?.method ?? 'GET'} ${path}`);
          if (path === '/bureau/jsonrpc')
            return response({
              result: {
                providers: [
                  {
                    plugin: 'openai',
                    name: 'openai',
                    configuration: { type: 'object', properties: { baseURL: { type: 'string' } } },
                  },
                ],
              },
            });
          if (path === '/host/plugins') return response({ configurationRevision: 'p1' });
          if (path === '/host/providers') return response({ configurationRevision: 'r1' });
          return response({ configurationRevision: 'p2', providers: [] });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      'POST /bureau/jsonrpc',
      'GET /host/plugins',
      'PUT /host/plugins/openai',
      'GET /host/providers',
      'PUT /host/providers/openai',
    ]);
  });

  test('rejects unknown and schema-invalid providers before any durable write', async () => {
    const mutations: string[] = [];
    const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = pathname(url);
      if (init?.method === 'PUT' || init?.method === 'DELETE')
        mutations.push(`${init.method} ${path}`);
      return path === '/bureau/jsonrpc'
        ? response({
            result: {
              providers: [
                {
                  plugin: 'openai',
                  name: 'openai',
                  configuration: {
                    type: 'object',
                    properties: { baseURL: { type: 'string', format: 'uri' } },
                    required: ['baseURL'],
                  },
                },
              ],
            },
          })
        : response({ configurationRevision: 'r1' });
    };
    const unknown = await commandRunner(['providers', 'connect', 'typo', '--secret-stdin'], {
      stdin: async () => 'secret',
      fetch,
    });
    await Bun.write(
      '/tmp/cor2061-invalid-provider.json',
      JSON.stringify({ apiKey: 'secret', configuration: { baseURL: 'not a uri' } }),
    );
    const invalid = await commandRunner(
      ['providers', 'connect', 'openai', '--input-file', '/tmp/cor2061-invalid-provider.json'],
      { fetch },
    );
    expect(unknown.exitCode).toBe(2);
    expect(invalid.exitCode).toBe(2);
    expect(mutations).toEqual([]);
  });

  test('never opens OAuth when no-open is requested and reports settings restart state', async () => {
    let opened = false;
    const calls: string[] = [];
    const result = await commandRunner(['tool-sources', 'authorize', 'github', '--no-open'], {
      open: () => {
        opened = true;
      },
      fetch: async (url, init) => {
        const path = pathname(url);
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

  test('never opens OAuth in non-interactive mode and rejects inline credential input', async () => {
    let opened = false;
    const noInput = await commandRunner(['tool-sources', 'authorize', 'github', '--no-input'], {
      open: () => {
        opened = true;
      },
      fetch: async (url) =>
        pathname(url) === '/host/tool-sources'
          ? response({ configurationRevision: 'r1' })
          : response({ authorized: false, authorizationUrl: 'https://auth.invalid/' }),
    });
    const inline = await commandRunner(
      ['providers', 'connect', 'openai', '--input', '{"apiKey":"x"}'],
      {
        fetch: async () => response({ configurationRevision: 'r1' }),
      },
    );
    expect(noInput.exitCode).toBe(0);
    expect(opened).toBe(false);
    expect(inline.exitCode).toBe(2);
    expect(inline.stderr).toContain('never --input');
  });

  test('settings set reads the current revision before updating', async () => {
    const methods: string[] = [];
    const result = await commandRunner(['settings', 'set', '--input', '{"tools.wakeup":false}'], {
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

  test('rejects a nonnumeric settings revision before the mutation request', async () => {
    const methods: string[] = [];
    const result = await commandRunner(
      ['settings', 'set', '--expected-revision', 'not-a-number', '--input', '{}'],
      {
        fetch: async (_url, init) => {
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body),
          ) as { method: string };
          methods.push(body.method);
          return response({ result: { revision: 3 } });
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(methods).toEqual(['bureau.settings.get']);
  });

  test('treats an aborted DELETE as an unknown mutation outcome', async () => {
    const result = await commandRunner(['providers', 'disconnect', 'anthropic'], {
      fetch: async (_url, init) => {
        if (init?.method === 'DELETE') throw new DOMException('aborted', 'AbortError');
        return response({ configurationRevision: 'r1' });
      },
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('The mutation outcome is unknown.');
  });
});
