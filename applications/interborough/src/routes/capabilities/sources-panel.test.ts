/**
 * The Sources tab of Capabilities (COR-1845): the tool sources the host saved as a list with the
 * open source beside it, where each stands, and for each tool whether it asks first and whether it
 * accepts secrets. The Accepts secrets switch writes at once and reads back from the host's saved
 * settings; Sign in opens the host's authorization address; Remove lists the agents it breaks.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../../app/copy.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import CapabilitiesPage from './index.svelte';
import {
  fakeToolSources,
  source,
  sourceTool,
  type FakeToolSources,
} from './sources-host.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const copy = CAPABILITIES_COPY;
const mount = () => render(QueryPage, { props: { page: CapabilitiesPage } } as never);

const NOTES = source('notes', {
  tools: [
    sourceTool('notes', 'lookup'),
    sourceTool('notes', 'wipe', { tier: 'dangerous' }),
    sourceTool('notes', 'guess', { tier: null }),
  ],
  credentials: ['notes-token'],
});

/** The button whose text is `label`, found without computing accessible names, which is slow beside an open dialog. */
function buttonLabelled(container: ParentNode, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
}

function serve(initial: Parameters<typeof fakeToolSources>[0]): FakeToolSources {
  const { host, other } = fakeToolSources(initial);
  restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, other).restore;
  return host;
}

describe('the Sources tab', () => {
  test('lists each source with where it stands, and opens one with its tools, tiers and defaults', async () => {
    serve({
      sources: [
        NOTES,
        source('petstore', { kind: 'openapi', state: 'pending-restart' }),
        source('gone', { state: 'failed', message: 'The server did not answer.' }),
        source('ledger', { state: 'needs-authorization', authorized: false }),
      ],
    });
    landAt('/capabilities?tab=sources');
    const { container, findByText } = mount();

    await findByText('petstore');
    const stateOf = (id: string) =>
      container.querySelector(`[data-source-row="${id}"]`)?.getAttribute('data-state');
    expect(stateOf('notes')).toBe('loaded');
    expect(stateOf('petstore')).toBe('pending-restart');
    expect(stateOf('gone')).toBe('failed');
    expect(stateOf('ledger')).toBe('needs-authorization');
    expect(container.querySelector('[data-testid="sources-count"]')?.textContent?.trim()).toBe('4');

    await fireEvent.click(container.querySelector('[data-source-row="notes"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="source-detail"]')).not.toBeNull(),
    );
    const detail = container.querySelector('[data-testid="source-detail"]')!;
    expect(detail.getAttribute('data-source')).toBe('notes');
    expect(detail.querySelector('[data-testid="source-credentials"]')?.textContent).toContain(
      'notes-token',
    );
    const standing = (tool: string) =>
      detail.querySelector(`[data-source-tool="notes__${tool}"] [data-testid="tool-standing"]`)
        ?.textContent;
    expect(standing('lookup')).toContain(copy.source.tools.standing.runs);
    expect(standing('wipe')).toContain(copy.source.tools.standing['asks-first']);
    // A tool that declares nothing is never read as read-only.
    expect(standing('guess')).toContain(copy.source.tools.standing['asks-first']);
  });

  test('says why a source failed, and what a source waiting for a restart does', async () => {
    serve({
      sources: [
        source('gone', { state: 'failed', message: 'The server did not answer.' }),
        source('petstore', { kind: 'openapi', state: 'pending-restart' }),
      ],
    });
    landAt('/capabilities?tab=sources&source=gone');
    const { container, findByTestId } = mount();

    const failure = await findByTestId('source-failure');
    expect(failure.textContent).toContain('The server did not answer.');
    expect(
      container.querySelector('[data-testid="source-tools"] [data-cinder-kind="first-use"]'),
    ).not.toBeNull();

    await fireEvent.click(container.querySelector('[data-source-row="petstore"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="source-state-description"]')?.textContent).toBe(
        copy.source.stateDescriptions['pending-restart'],
      ),
    );
  });

  test('turns Accepts secrets on, writes it to the source, and reads it back after a reload', async () => {
    const host = serve({ sources: [NOTES] });
    landAt('/capabilities?tab=sources&source=notes');
    const first = mount();
    const switchOf = (container: Element, tool: string) =>
      container.querySelector<HTMLElement>(`[data-source-tool="notes__${tool}"] [role="switch"]`)!;

    await waitFor(() => expect(switchOf(first.container, 'wipe')).not.toBeNull());
    // Off until the owner turns it on, and every switch is marked as a write.
    expect(switchOf(first.container, 'wipe').getAttribute('aria-checked')).toBe('false');
    expect(switchOf(first.container, 'wipe').hasAttribute('data-changes')).toBe(true);

    await fireEvent.click(switchOf(first.container, 'wipe'));
    await waitFor(() =>
      expect(switchOf(first.container, 'wipe').getAttribute('aria-checked')).toBe('true'),
    );
    expect(host.requests.filter((request) => request.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/host/tool-sources/notes/tools',
        body: { tools: { wipe: { acceptsSecrets: true } } },
      },
    ]);
    // The running host loads it at its next start, and the row says so.
    expect(
      first.container.querySelector(
        '[data-source-tool="notes__wipe"] [data-testid="takes-effect"]',
      ),
    ).not.toBeNull();
    expect(
      first.container.querySelector(
        '[data-source-tool="notes__lookup"] [data-testid="takes-effect"]',
      ),
    ).toBeNull();

    // A reload builds the page again over the same host.
    first.unmount();
    const second = mount();
    await waitFor(() => expect(switchOf(second.container, 'wipe')).not.toBeNull());
    expect(switchOf(second.container, 'wipe').getAttribute('aria-checked')).toBe('true');
    expect(switchOf(second.container, 'lookup').getAttribute('aria-checked')).toBe('false');
  });

  test('leaves the switch off when the host refuses the write', async () => {
    const host = serve({ sources: [NOTES] });
    landAt('/capabilities?tab=sources&source=notes');
    const { container, findByText } = mount();
    const wipe = () =>
      container.querySelector<HTMLElement>('[data-source-tool="notes__wipe"] [role="switch"]');
    await waitFor(() => expect(wipe()).not.toBeNull());

    host.refuseNext = Response.json(
      { error: 'invalid', field: 'tools.wipe.acceptsSecrets', message: 'expected true or false.' },
      { status: 400 },
    );
    await fireEvent.click(wipe()!);
    await waitFor(() =>
      expect(host.requests.filter((request) => request.method === 'PUT')).toHaveLength(1),
    );
    // The refusal is a toast in the host's words, not a line on the page.
    await findByText(new RegExp(copy.source.tools.saveFailed));
    await waitFor(() => expect(wipe()?.hasAttribute('disabled')).toBe(false));
    expect(wipe()?.getAttribute('aria-checked')).toBe('false');
  });

  test('holds every switch, Sign in and Remove still when the host keeps its configuration in its deployment', async () => {
    serve({ sources: [NOTES], lockReason: 'deployment' });
    landAt('/capabilities?tab=sources&source=notes');
    const { container, findByText } = mount();

    await findByText(copy.source.tools.locked);
    for (const control of container.querySelectorAll('[data-source-tool] [role="switch"]')) {
      expect(control.hasAttribute('disabled')).toBe(true);
    }
    const remove = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === copy.source.remove.action,
    );
    expect(remove?.hasAttribute('disabled')).toBe(true);
  });

  test('signs in by opening the address the host hands out, and says so when the tab was blocked', async () => {
    const host = serve({
      sources: [source('ledger', { state: 'needs-authorization', authorized: false })],
      authorization: {
        authorized: false,
        authorizationUrl: 'http://127.0.0.1:9/authorize?state=x',
      },
    });
    landAt('/capabilities?tab=sources&source=ledger');
    const { container, findByTestId, getByRole } = mount();
    const open = spyOn(window, 'open').mockReturnValue(null);

    try {
      await findByTestId('source-detail');
      await fireEvent.click(getByRole('button', { name: copy.source.signIn.action }));
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      expect(open.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9/authorize?state=x');
      expect(host.requests.at(-1)).toEqual({
        method: 'POST',
        path: '/host/tool-sources/ledger/authorize',
        body: undefined,
      });
      // The browser blocked the tab, so the address is offered as a link instead of being lost.
      const link = await findByTestId('sign-in-link');
      expect(link.getAttribute('href')).toBe('http://127.0.0.1:9/authorize?state=x');
      expect(container.querySelector('[data-testid="source-state"]')?.textContent).toBe(
        copy.source.states['needs-authorization'],
      );
    } finally {
      open.mockRestore();
    }
  });

  test('says a source is already signed in when the host holds working tokens', async () => {
    serve({
      sources: [source('ledger', { state: 'needs-authorization', authorized: false })],
      authorization: { authorized: true },
    });
    landAt('/capabilities?tab=sources&source=ledger');
    const { container, findByTestId, getByRole } = mount();
    await findByTestId('source-detail');
    await fireEvent.click(getByRole('button', { name: copy.source.signIn.action }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="source-state-description"]')?.textContent).toBe(
        copy.source.signIn.signedIn,
      ),
    );
  });

  test('does not carry a sign-in just done over to the next source opened', async () => {
    serve({
      sources: [
        source('ledger', { state: 'needs-authorization', authorized: false }),
        source('vault', { state: 'needs-authorization', authorized: false }),
      ],
      authorization: { authorized: true },
    });
    landAt('/capabilities?tab=sources&source=ledger');
    const { container, findByTestId, getByRole } = mount();
    const words = () =>
      container.querySelector('[data-testid="source-state-description"]')?.textContent;
    await findByTestId('source-detail');
    await fireEvent.click(getByRole('button', { name: copy.source.signIn.action }));
    await waitFor(() => expect(words()).toBe(copy.source.signIn.signedIn));

    await fireEvent.click(container.querySelector('[data-source-row="vault"]')!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="source-detail"]')?.getAttribute('data-source'),
      ).toBe('vault'),
    );
    expect(words()).toBe(copy.source.stateDescriptions['needs-authorization']);
  });

  test('lists the agents a removal would break before it removes the source, then removes it', async () => {
    const host = serve({
      sources: [NOTES, source('petstore', { kind: 'openapi' })],
      agents: {
        notes: [
          { id: 'writer', name: 'Writer', tools: ['notes__lookup'], toolApproval: ['notes__wipe'] },
        ],
      },
    });
    landAt('/capabilities?tab=sources&source=notes');
    const { container, findByTestId, findByText, queryByTestId } = mount();
    await findByTestId('source-detail');

    await fireEvent.click(buttonLabelled(container, copy.source.remove.action));
    const dialog = await findByTestId('source-removal');
    await findByText('Writer');
    expect(dialog.querySelector('[data-affected-agent="writer"]')?.textContent).toContain(
      'notes__lookup',
    );
    expect(host.requests.some((request) => request.method === 'DELETE')).toBe(false);

    await fireEvent.click(buttonLabelled(document.body, copy.source.remove.confirm));
    await waitFor(() =>
      expect(container.querySelector('[data-source-row="notes"]') === null).toBe(true),
    );
    expect(
      host.requests.at(-1)?.method === 'GET' || host.requests.some((r) => r.method === 'DELETE'),
    ).toBe(true);
    expect(host.requests.filter((request) => request.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: '/host/tool-sources/notes', body: undefined },
    ]);
    expect(container.querySelector('[data-source-row="petstore"]')).not.toBeNull();
    expect(queryByTestId('source-removal')).toBeNull();
  });

  test('says no agent names the tools when none does, and changes nothing on Keep it', async () => {
    const host = serve({ sources: [NOTES] });
    landAt('/capabilities?tab=sources&source=notes');
    const { container, findByTestId, queryByTestId } = mount();
    await findByTestId('source-detail');
    await fireEvent.click(buttonLabelled(container, copy.source.remove.action));
    await findByTestId('source-removal-none');
    await fireEvent.click(buttonLabelled(document.body, copy.source.remove.cancel));
    await waitFor(() => expect(queryByTestId('source-removal') === null).toBe(true));
    expect(host.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  test('lists the tools the host does not offer and the settings that reach no tool', async () => {
    serve({
      sources: [
        source('notes', {
          tools: [sourceTool('notes', 'lookup')],
          skipped: [{ tool: 'bad name', reason: 'Its name cannot be used.' }],
          unmatchedSettings: [{ tool: 'missing', message: 'The server does not list it.' }],
        }),
      ],
    });
    landAt('/capabilities?tab=sources&source=notes');
    const { findByTestId } = mount();
    const skipped = await findByTestId('source-skipped');
    const unmatched = await findByTestId('source-unmatched');
    expect(skipped.textContent).toContain('Its name cannot be used.');
    expect(unmatched.textContent).toContain('missing');
  });

  test('is a first-use empty state when the host saved no source, and filters when it saved some', async () => {
    serve({ sources: [] });
    landAt('/capabilities?tab=sources');
    const empty = mount();
    await empty.findByText(copy.source.empty.title);
    expect(empty.container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    empty.unmount();
    restore?.();

    serve({ sources: [NOTES, source('petstore', { kind: 'openapi' })] });
    const { container, findByText, getByRole } = mount();
    await findByText('petstore');
    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.sources }), {
      target: { value: 'zzz' },
    });
    await findByText(copy.source.filtered.title);
    expect(container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();
  });

  test('says the sources could not be read, and reads them again on Try again', async () => {
    let failing = true;
    const { host, other } = fakeToolSources({ sources: [NOTES] });
    restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, (url, init) =>
      failing && url.includes('/host/tool-sources')
        ? new Response('down', { status: 500 })
        : other(url, init),
    ).restore;
    landAt('/capabilities?tab=sources');
    const { findByText, getByRole } = mount();
    await findByText(copy.source.loadFailed.title);
    failing = false;
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    await findByText('notes');
    expect(host.requests.length).toBeGreaterThan(0);
  });
});
