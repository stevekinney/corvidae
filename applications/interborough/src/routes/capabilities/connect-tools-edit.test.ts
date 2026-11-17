/**
 * COR-2436, row 32m: Edit connection opens Connect tools on a saved source. The page fills in from
 * what the host holds (`GET /host/tool-sources/<id>/editing`), leaves the token blank (which keeps
 * the stored one), saves under the same id with no `create` and no `tools` (so each tool keeps its
 * settings), fenced on the revision it read, and opens the source again once saved. A source the
 * host will not let the page edit says why, with the way back.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import { router } from '../../lib/router.svelte.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import ConnectTools from './connect-tools.svelte';
import { fakeToolSources, source, sourceTool } from './sources-host.test-support.ts';

const copy = CAPABILITIES_COPY.source.connect;

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const GITHUB = source('github', {
  name: 'GitHub',
  address: 'https://mcp.github.example/mcp',
  credentials: ['token'],
  tools: [sourceTool('github', 'list_issues')],
});

const EDITING = {
  id: 'github',
  source: {
    id: 'github',
    kind: 'mcp',
    transport: {
      type: 'http',
      url: 'https://mcp.github.example/mcp',
      authentication: { type: 'bearer', credential: 'token' },
    },
  },
  name: 'GitHub',
  description: 'An MCP server for issues and files in your repositories.',
  credentials: ['token'],
  configurationRevision: 'revision-read-by-the-page',
};

function serve(editing: Response) {
  const { host, other } = fakeToolSources({ sources: [GITHUB] });
  host.probe = { outcome: 'listed', tools: [sourceTool('github', 'list_issues')], skipped: [] };
  restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, (url, init) =>
    new URL(url, 'http://localhost').pathname === '/host/tool-sources/github/editing'
      ? editing.clone()
      : other(url, init),
  ).restore;
  return host;
}

const mount = () => render(QueryPage, { props: { page: ConnectTools } } as never);

function field(id: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (found === null) throw new Error(`no field ${id}`);
  return found;
}

describe('Edit connection', () => {
  test('fills the page in from the saved source, with the token left blank', async () => {
    serve(Response.json(EDITING));
    landAt('/capabilities/connect?source=github');
    const { container } = mount();

    await waitFor(() => expect(field('connect-url').value).toBe('https://mcp.github.example/mcp'));
    expect(container.querySelector('h1')?.textContent?.trim()).toBe(copy.edit.title);
    expect(field('connect-secret').value).toBe('');
    expect(field('connect-secret').required).toBe(false);
  });

  test('saves under the same id, keeping the stored token and the tools, fenced on the revision read', async () => {
    const host = serve(Response.json(EDITING));
    landAt('/capabilities/connect?source=github');
    const { getByRole } = mount();
    await waitFor(() => expect(field('connect-url').value).toBe('https://mcp.github.example/mcp'));

    await fireEvent.click(getByRole('button', { name: copy.edit.save }));

    await waitFor(() =>
      expect(host.requests.some((request) => request.method === 'PUT')).toBe(true),
    );
    const put = host.requests.find((request) => request.method === 'PUT');
    expect(put?.path).toBe('/host/tool-sources/github');
    expect(put?.body).toMatchObject({
      source: EDITING.source,
      credentials: {},
      name: 'GitHub',
      expectedRevision: 'revision-read-by-the-page',
    });
    expect(put?.body).not.toHaveProperty('create');
    expect(put?.body).not.toHaveProperty('tools');
    // The test before the save sent no token either: the host uses the stored one.
    const probe = host.requests.find((request) => request.path.endsWith('/probe'));
    expect(probe?.body).toMatchObject({ credentials: {} });
    await waitFor(() => expect(router.search.get('source')).toBe('github'));
    expect(router.pathname).toBe('/capabilities');
  });

  test('says why a source cannot be edited here, with the way back', async () => {
    serve(
      Response.json(
        {
          error: 'not-editable',
          reason: 'address-query',
          message: 'An address of this source holds a query. Change it in configuration.json.',
        },
        { status: 409 },
      ),
    );
    landAt('/capabilities/connect?source=github');
    const { findByTestId, container } = mount();

    const refused = await findByTestId('connect-edit-refused');
    expect(refused.textContent).toContain('Change it in configuration.json.');
    expect(container.querySelector('[data-testid="connect-form"]')).toBeNull();
  });
});
