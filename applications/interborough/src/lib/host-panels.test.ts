/** The client for the host's plugin panels: what it asks for, what it reads, and what it throws. */
import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import {
  chatToolsOf,
  getPanels,
  loadPluginApp,
  pluginToolCaller,
  type HostPanel,
} from './host-panels.ts';

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
    const apps: HostPanel[] = [
      {
        plugin: 'inspectors',
        app: 'run-inspector',
        title: 'Run inspector',
        uri: 'ui://inspectors/run-inspector/v1',
        opensFromTool: 'bureau.tasks.inspect',
        placements: [{ kind: 'run' }],
      },
      {
        plugin: 'inspectors',
        app: 'workflow-revision-review',
        title: 'Review workflow revision',
        uri: 'ui://inspectors/workflow-revision-review/v1',
        placements: [
          { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' },
          { kind: 'page', path: 'reviews/queue', sidebar: { group: 'system', icon: 'inbox' } },
        ],
      },
    ];
    const { fetch, seen } = scripted(() => Response.json({ apps }));
    expect(await getPanels({ fetch })).toEqual(apps);
    expect(seen[0]?.path).toBe('/host/panels');
  });

  test('reads the Chat tools a panel opens from out of its chat-tool placements', async () => {
    const [run, review] = await getPanels({
      fetch: scripted(() =>
        Response.json({
          apps: [
            {
              plugin: 'inspectors',
              app: 'run-inspector',
              title: 'Run inspector',
              uri: 'ui://inspectors/run-inspector/v1',
              placements: [{ kind: 'run' }],
            },
            {
              plugin: 'inspectors',
              app: 'workflow-revision-review',
              title: 'Review workflow revision',
              uri: 'ui://inspectors/workflow-revision-review/v1',
              placements: [
                { kind: 'page', path: 'reviews' },
                { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' },
              ],
            },
          ],
        }),
      ).fetch,
    });
    expect(chatToolsOf(run!)).toEqual([]);
    expect(chatToolsOf(review!)).toEqual(['bureau:workflows-propose-update']);
  });

  test.each([
    ['a placement of another kind', [{ kind: 'dock' }]],
    [
      'a page placement in the home group',
      [{ kind: 'page', path: 'reviews', sidebar: { group: 'home' } }],
    ],
    ['a chat-tool placement with no agent tool', [{ kind: 'chat-tool' }]],
  ])('throws for %s', async (_name, placements) => {
    const { fetch } = scripted(() =>
      Response.json({
        apps: [{ plugin: 'a', app: 'b', title: 'B', uri: 'ui://a/b/v1', placements }],
      }),
    );
    expect(await rejectionOf(getPanels({ fetch }))).toBeInstanceOf(Error);
  });

  test('throws for a panel listing with no placements field', async () => {
    const { fetch } = scripted(() =>
      Response.json({ apps: [{ plugin: 'a', app: 'b', title: 'B', uri: 'ui://a/b/v1' }] }),
    );
    expect(await rejectionOf(getPanels({ fetch }))).toBeInstanceOf(Error);
  });

  test.each([
    ['an answer that is not a refusal-free listing', () => Response.json({ nope: true })],
    ['a refusal', () => new Response('no', { status: 403 })],
  ])('throws for %s', async (_name, answer) => {
    const { fetch } = scripted(answer);
    expect(await rejectionOf(getPanels({ fetch }))).toBeInstanceOf(Error);
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
  test('keeps the session write token in the parent request', async () => {
    const { fetch, seen } = scripted((path) =>
      path === '/auth/session'
        ? Response.json({ csrfToken: 'session-proof' })
        : Response.json({ content: [] }),
    );
    await pluginToolCaller('inspectors', 'pending-review', { fetch })(
      { name: 'bureau.reviews.resolve', arguments: { id: 'review', round: 1 } },
      ABORT,
    );
    expect(seen[0]?.path).toBe('/auth/session');
    expect(new Headers(seen[1]?.init?.headers).get('x-csrf-token')).toBe('session-proof');
    expect(bodyOf(seen[1])).toEqual({
      name: 'bureau.reviews.resolve',
      arguments: { id: 'review', round: 1 },
    });
  });
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
