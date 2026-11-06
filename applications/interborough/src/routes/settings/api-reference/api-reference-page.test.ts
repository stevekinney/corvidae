/**
 * `/settings/api-reference` (board PageSettingsSections, "API reference"; rows 50n to 50t, 50y and
 * 51e): one Cinder tabs row that holds the Operations, Discovery documents, Your scopes and Workflow
 * sources tabs, each filled from what the running server answers. The Bureau is a stub and the
 * server's OpenAPI description is served by a `fetch` this test installs over it.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { API_REFERENCE_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { STUB_A2A_DIRECTORY_URL, type BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';
import type { OpenApiDocumentLike } from './api-operations.ts';

const DOCUMENT: OpenApiDocumentLike = {
  components: {
    schemas: {
      StartInput: {
        type: 'object',
        required: ['workflow', 'input'],
        properties: {
          workflow: { type: 'string' },
          input: {
            type: 'object',
            properties: { order: { type: 'integer' } },
            required: ['order'],
          },
        },
      },
      Started: {
        type: 'object',
        required: ['run', 'status'],
        properties: { run: { type: 'string' }, status: { enum: ['running'] } },
      },
    },
  },
  paths: {
    '/api/runs': {
      get: {
        operationId: 'weft.workflows.list',
        summary: 'List runs',
        tags: ['Runs'],
        'x-weft-access': { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['workflows:read'] } },
        responses: { '200': {} },
      },
      post: {
        operationId: 'weft.workflows.start',
        summary: 'Start a run',
        tags: ['Runs'],
        'x-weft-access': { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['workflows:write'] } },
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/StartInput' } } },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Started' } } },
          },
        },
      },
    },
    '/api/schedules': {
      get: {
        operationId: 'weft.schedules.list',
        summary: 'List schedules',
        tags: ['Schedules'],
        'x-weft-access': { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['schedules:read'] } },
        responses: { '200': {} },
      },
    },
  },
};

const FILE = {
  state: 'ready',
  owner: 'anonymous:local',
  hash: 'h',
  description: null,
  agent: null,
  paused: false,
  inputSchema: null,
  outputSchema: null,
  version: null,
  problem: null,
  runs: null,
};

const FILES = [
  { ...FILE, id: 'order-refund', trigger: { kind: 'signal', name: 'refund' } },
  { ...FILE, id: 'release-notes', trigger: { kind: 'schedule', spec: '0 9 * * 1' } },
  { ...FILE, id: 'triage-inbox', trigger: null },
];

let stub: BureauStub | undefined;
let restoreFetch: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restoreFetch?.();
  restoreFetch = undefined;
  stub?.restore();
  stub = undefined;
});

type Open = { path?: string; openapi?: 'fail' | 'hang' | OpenApiDocumentLike; files?: 'fail' };

function open({ path = '/settings/api-reference', openapi = DOCUMENT, files }: Open = {}) {
  stub = installSettingsBureau(servedSettings(), {
    'bureau.workflows.list': () => {
      if (files === 'fail') throw new Error('The Bureau is down.');
      return { workflows: FILES, nextOffset: null };
    },
  });
  const delegate = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, 'http://localhost').pathname !== '/openapi.json') return delegate(input, init);
    if (openapi === 'hang') return new Promise<Response>(() => undefined);
    if (openapi === 'fail') return new Response('nope', { status: 500 });
    return Response.json(openapi);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = delegate;
  };
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const tabNamed = (view: ReturnType<typeof open>, name: string) => view.getByRole('tab', { name });

describe('Settings › API reference', () => {
  test('is the heading and the intro over one tabs row of four tabs, not a navigation column', async () => {
    const view = open();

    expect(await view.findByRole('heading', { level: 1, name: 'API reference' })).not.toBeNull();
    expect(view.getByText(API_REFERENCE_COPY.intro)).not.toBeNull();
    const tablist = await view.findByRole('tablist', { name: 'API reference' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(['Operations', 'Discovery documents', 'Your scopes', 'Workflow sources']);
    expect(tabNamed(view, 'Operations').getAttribute('aria-selected')).toBe('true');
    expect(view.queryByRole('navigation', { name: 'API reference groups' })).toBeNull();
    // The one navigation of the page is the Settings section list.
    expect(view.container.textContent).not.toContain('API keys');
  });

  test('Operations has a group select, a count and a table of method, path, what it does and scope', async () => {
    const view = open();

    const table = await view.findByRole('table', { name: 'Operations' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent?.trim())
        .slice(0, 4),
    ).toEqual(['Method', 'Path', 'What it does', 'Scope']);
    expect(view.getByTestId('api-operations-count').textContent).toBe('3 operations');
    expect(view.getByRole('combobox', { name: 'Group' }).textContent).toContain('All groups');
    const row = table.querySelector('[data-operation="weft.workflows.start"]');
    expect(row?.textContent).toContain('POST');
    expect(row?.textContent).toContain('/api/runs');
    expect(row?.textContent).toContain('Start a run');
    expect(row?.textContent).toContain('workflows:write');
  });

  test('choosing a group narrows the table and the count', async () => {
    const view = open();
    await view.findByRole('table', { name: 'Operations' });

    const select = view.container.querySelector('select');
    if (select === null) throw new Error('expected the group select to be native');
    await fireEvent.change(select, { target: { value: 'Schedules' } });

    await waitFor(() =>
      expect(view.getByTestId('api-operations-count').textContent).toBe('1 operation'),
    );
    expect(view.container.querySelector('[data-operation="weft.workflows.start"]')).toBeNull();
    expect(view.container.querySelector('[data-operation="weft.schedules.list"]')).not.toBeNull();
  });

  test('opening an operation shows its request body and its response in code blocks', async () => {
    const view = open();
    const table = await view.findByRole('table', { name: 'Operations' });

    const toggle = within(table).getByRole('button', {
      name: 'Request and response for POST /api/runs',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const request = await view.findByRole('region', { name: 'Request body' });
    expect(request.textContent?.replace(/\s+/g, ' ')).toContain('"workflow": "string"');
    const response = view.getByRole('region', { name: 'Response, 201' });
    expect(response.textContent?.replace(/\s+/g, ' ')).toContain('"status": "running"');
  });

  test('Discovery documents lists three documents, each with its address and a Copy button named for it', async () => {
    const view = open({ path: '/settings/api-reference?group=discovery' });

    const list = await view.findByTestId('api-discovery');
    const entries = [
      [
        'openapi',
        'OpenAPI description',
        'Every operation, for generating a client.',
        '/openapi.json',
      ],
      [
        'agent-card',
        'Agent card',
        'How other agents discover yours (A2A).',
        STUB_A2A_DIRECTORY_URL,
      ],
      ['tools', 'Tool server', 'The same tools, over MCP.', '/mcp'],
    ] as const;
    for (const [id, title, description, address] of entries) {
      const row = list.querySelector<HTMLElement>(`[data-document="${id}"]`);
      expect(row?.textContent).toContain(title);
      expect(row?.textContent).toContain(description);
      await waitFor(() => expect(row?.querySelector('code')?.textContent).toContain(address));
      expect(within(row!).getByRole('button', { name: `Copy ${title}` })).not.toBeNull();
    }
  });

  test('Your scopes opens with the single-user sentence and lists the scopes this session holds', async () => {
    const view = open({ path: '/settings/api-reference?group=scopes' });

    const panel = await view.findByTestId('api-scopes');
    expect(panel.textContent).toContain(API_REFERENCE_COPY.scopes.intro);
    const names = [...panel.querySelectorAll('li code')].map((code) => code.textContent);
    expect(names).toContain('workflows:read');
    expect(names).toContain('schedules:write');
    expect(names.length).toBeGreaterThan(5);
  });

  test('Workflow sources lists each workflow file with what it holds, and offers no Open file', async () => {
    const view = open({ path: '/settings/api-reference?group=sources' });

    const panel = await view.findByTestId('api-sources');
    await waitFor(() =>
      expect(panel.querySelector('[data-workflow-file="order-refund"]')).not.toBeNull(),
    );
    expect(panel.textContent).toContain(API_REFERENCE_COPY.sources.intro);
    const text = (id: string) =>
      panel.querySelector(`[data-workflow-file="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    expect(text('order-refund')).toBe('workflows/order-refund.json 1 workflow · Order refund');
    expect(text('release-notes')).toBe(
      'workflows/release-notes.json 1 workflow · Release notes, 1 schedule',
    );
    expect(text('triage-inbox')).toBe('workflows/triage-inbox.json 1 workflow · Triage inbox');
    expect(within(panel).queryByRole('button', { name: /open file/i })).toBeNull();
  });

  test('the tab in the address is the tab that opens, and choosing a tab changes the address', async () => {
    const view = open({ path: '/settings/api-reference?group=scopes' });

    await view.findByTestId('api-scopes');
    expect(tabNamed(view, 'Your scopes').getAttribute('aria-selected')).toBe('true');

    await fireEvent.click(tabNamed(view, 'Discovery documents'));
    await view.findByTestId('api-discovery');
    expect(window.location.search).toBe('?group=discovery');
  });

  test('while the server has not answered the tab row is live and the rows are placeholders', async () => {
    const view = open({ openapi: 'hang' });

    expect(await view.findByRole('tablist', { name: 'API reference' })).not.toBeNull();
    await waitFor(() => expect(view.container.textContent).toContain('Loading the API reference'));
    expect(view.queryByRole('table')).toBeNull();
    expect(view.getByRole('heading', { level: 1, name: 'API reference' })).not.toBeNull();
  });

  test('a read the server answers with an error is named, with Try again, and the tab row stays', async () => {
    const view = open({ openapi: 'fail' });

    const failed = await view.findByTestId('api-reference-load-failed');
    expect(failed.textContent).toContain('Couldn’t load the API reference.');
    expect(failed.textContent).toContain('The server answered with an error (500).');
    expect(within(failed).getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(view.queryByRole('table')).toBeNull();
    expect(view.getByRole('tablist', { name: 'API reference' })).not.toBeNull();
    // The other tabs read for themselves, so this one failing does not empty them.
    await fireEvent.click(tabNamed(view, 'Discovery documents'));
    expect(await view.findByTestId('api-discovery')).not.toBeNull();
  });
});
