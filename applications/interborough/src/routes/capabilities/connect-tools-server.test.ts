/**
 * COR-2436, rows 33f and 31o: Test connection on an MCP server that is not named yet runs under
 * its address's name, and what the server says of itself fills in Name ("Filled in after the
 * test") and the sentence the source is saved with. A name a person typed is kept.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import ConnectTools from './connect-tools.svelte';
import { fakeToolSources, sourceTool } from './sources-host.test-support.ts';

const copy = CAPABILITIES_COPY.source.connect;

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function serve() {
  const { host, other } = fakeToolSources({ sources: [] });
  host.probe = {
    outcome: 'listed',
    tools: [sourceTool('github', 'list_issues')],
    skipped: [],
    server: {
      name: 'GitHub',
      instructions:
        'An MCP server for issues and files in your repositories.\nUse it to file bugs.',
    },
  };
  restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, other).restore;
  return host;
}

function field(id: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (found === null) throw new Error(`no field ${id}`);
  return found;
}

describe('a test fills in what the server says of itself', () => {
  test('Name, after the test, and the sentence the source is saved with', async () => {
    const host = serve();
    landAt('/capabilities/connect');
    const { getByRole } = render(QueryPage, { props: { page: ConnectTools } } as never);

    await fireEvent.input(field('connect-url'), {
      target: { value: 'https://mcp.github.example/mcp' },
    });
    await fireEvent.click(getByRole('button', { name: copy.probe.action }));

    await waitFor(() => expect(field('connect-name').value).toBe('GitHub'));
    const probe = host.requests.find((request) => request.path.endsWith('/probe'));
    expect(probe?.path).toBe('/host/tool-sources/github/probe');

    await fireEvent.submit(document.body.querySelector('[data-testid="connect-form"]')!);
    await waitFor(() =>
      expect(host.requests.some((request) => request.method === 'PUT')).toBe(true),
    );
    const put = host.requests.find((request) => request.method === 'PUT');
    expect(put?.body).toMatchObject({
      name: 'GitHub',
      description: 'An MCP server for issues and files in your repositories.',
    });
  });

  test('keeps a name a person typed', async () => {
    serve();
    landAt('/capabilities/connect');
    const { getByRole } = render(QueryPage, { props: { page: ConnectTools } } as never);
    await fireEvent.input(field('connect-name'), { target: { value: 'Work GitHub' } });
    await fireEvent.input(field('connect-url'), {
      target: { value: 'https://mcp.github.example/mcp' },
    });
    await fireEvent.click(getByRole('button', { name: copy.probe.action }));

    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="connect-listed"]')).not.toBeNull(),
    );
    expect(field('connect-name').value).toBe('Work GitHub');
  });
});
