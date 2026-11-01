/** The client for the host's plugin panels: what it asks for, what it reads, and what it throws. */
import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import { getMcpApps, loadPluginApp, pluginToolCaller } from './host-mcp-apps.ts';

type Seen = { path: string; init: RequestInit | undefined };

/** The path a request names, whichever form the client passed it in. */
const pathOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

/** The body a request carried, which these clients always send as text. */
const bodyOf = (seen: Seen | undefined): unknown =>
  JSON.parse(typeof seen?.init?.body === 'string' ? seen.init.body : 'null');

function scripted(answer: (path: string) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    seen.push({ path, init });
    return answer(path);
  };
  return { seen, fetch };
}

const ABORT = { signal: new AbortController().signal };

describe('the panels the host lists', () => {
  test('reads each panel’s plugin, app, title, URI, and the tool it opens from', async () => {
    const apps = [
      {
        plugin: 'inspectors',
        app: 'run-inspector',
        title: 'Run inspector',
        uri: 'ui://bureau/run-inspector/v1',
        opensFromTool: 'bureau.tasks.inspect',
      },
    ];
    const { fetch, seen } = scripted(() => Response.json({ apps }));
    expect(await getMcpApps({ fetch })).toEqual(apps);
    expect(seen[0]?.path).toBe('/host/mcp-apps');
  });

  test.each([
    ['an answer that is not a refusal-free listing', () => Response.json({ nope: true })],
    ['a refusal', () => new Response('no', { status: 403 })],
  ])('throws for %s', async (_name, answer) => {
    const { fetch } = scripted(answer);
    expect(await rejectionOf(getMcpApps({ fetch }))).toBeInstanceOf(Error);
  });
});

describe('a panel’s page', () => {
  test('loads the HTML and the security metadata, naming the panel with its parts escaped', async () => {
    const { fetch, seen } = scripted(() =>
      Response.json({ html: '<div id="root"></div>', ui: { csp: { connectDomains: [] } } }),
    );
    const resource = await loadPluginApp('in/spectors', 'run inspector', { fetch });
    expect(resource).toEqual({
      html: '<div id="root"></div>',
      ui: { csp: { connectDomains: [] } },
    });
    expect(seen[0]?.path).toBe('/host/plugins/in%2Fspectors/apps/run%20inspector');
  });

  test('throws when the host refuses or answers something that is not a page', async () => {
    const refused = scripted(() => new Response('', { status: 404 })).fetch;
    const notAPage = scripted(() => Response.json({})).fetch;
    expect(await rejectionOf(loadPluginApp('a', 'b', { fetch: refused }))).toBeInstanceOf(Error);
    expect(await rejectionOf(loadPluginApp('a', 'b', { fetch: notAPage }))).toBeInstanceOf(Error);
  });
});

describe('a panel’s tool calls', () => {
  test('posts the name and the arguments to the panel’s own route and returns the result as it came', async () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { task: { id: 'run-1' } },
    };
    const { fetch, seen } = scripted(() => Response.json(result));
    const call = pluginToolCaller('inspectors', 'run-inspector', { fetch });
    expect(
      await call({ name: 'bureau.tasks.inspect', arguments: { taskId: 'run-1' } }, ABORT),
    ).toEqual(result);
    expect(seen[0]?.path).toBe('/host/plugins/inspectors/apps/run-inspector/tool-calls');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(bodyOf(seen[0])).toEqual({
      name: 'bureau.tasks.inspect',
      arguments: { taskId: 'run-1' },
    });
  });

  test('sends empty arguments when the panel sent none', async () => {
    const { fetch, seen } = scripted(() => Response.json({ content: [] }));
    await pluginToolCaller('a', 'b', { fetch })({ name: 'bureau.tasks.inspect' }, ABORT);
    expect(bodyOf(seen[0])).toEqual({
      name: 'bureau.tasks.inspect',
      arguments: {},
    });
  });

  test('throws when the host refuses the tool, without repeating what it said', async () => {
    const { fetch } = scripted(() =>
      Response.json({ error: 'forbidden-tool', message: 'secret' }, { status: 403 }),
    );
    const failure = await pluginToolCaller('a', 'b', { fetch })(
      { name: 'bureau.reviews.resolve' },
      ABORT,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('The host answered 403.');
  });
});
