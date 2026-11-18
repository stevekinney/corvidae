/**
 * COR-2436, rows 33g, 34k, 34l and 34y: Connect tools signs in to an OAuth server before the
 * source is saved. The page asks the host to start, opens the provider in a window of its own,
 * waits with a spinner and Cancel, and reads how it ended: signed in, canceled (neutral text with
 * Try again) or refused (a danger-tone reason with Try again). It holds the host's reference only,
 * which Test connection and Connect name; no token reaches it.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import ConnectTools from './connect-tools.svelte';
import { fakeToolSources, sourceTool } from './sources-host.test-support.ts';

const copy = CAPABILITIES_COPY.source.connect;
const signInCopy = copy.authentication.signIn;

/**
 * A class, not an object literal: the page keeps the window it opened in `$state`, which wraps a
 * plain object in a proxy (so `event.source` would never equal it) and leaves a class instance, as
 * a real `Window` is, as it is.
 */
class FakeWindow {
  closed = false;
  location = { href: 'about:blank' };
  close(): void {
    this.closed = true;
  }
}

let restore: (() => void) | undefined;
let opened: FakeWindow[] = [];
const originalOpen = window.open;

beforeEach(() => {
  opened = [];
  window.open = () => {
    const popup = new FakeWindow();
    opened.push(popup);
    return popup as unknown as Window;
  };
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  window.open = originalOpen;
});

/** A host whose sign-in ends as `outcome` when the page reads it. */
function serve(standing: { outcome: string; reason?: string }) {
  const { host, other } = fakeToolSources({ sources: [] });
  host.probe = { outcome: 'listed', tools: [sourceTool('github', 'list_issues')], skipped: [] };
  const signInRequests: { method: string; body: unknown }[] = [];
  restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, (url, init) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/host/tool-source-sign-ins') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      signInRequests.push({ method: init?.method ?? 'GET', body });
      return Response.json({
        authorized: false,
        signIn: 'sign-in-reference',
        authorizationUrl: 'https://provider.example/authorize?state=host-state',
      });
    }
    if (path === '/host/tool-source-sign-ins/sign-in-reference') {
      return Response.json({ signIn: 'sign-in-reference', ...standing });
    }
    return other(url, init);
  }).restore;
  return { host, signInRequests };
}

function field(id: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (found === null) throw new Error(`no field ${id}`);
  return found;
}

/** Fills in an OAuth MCP server called GitHub and presses Sign in to GitHub. */
async function signIn(getByRole: (role: string, options: { name: string }) => HTMLElement) {
  await fireEvent.input(field('connect-name'), { target: { value: 'GitHub' } });
  await fireEvent.input(field('connect-url'), {
    target: { value: 'https://mcp.github.example/mcp' },
  });
  // OAuth is the segmented control's first choice and is already selected: press it all the same.
  await fireEvent.click(
    document.body.querySelector<HTMLElement>(
      '#connect-authentication [data-cinder-segment-value="oauth"]',
    )!,
  );
  await fireEvent.click(getByRole('button', { name: signInCopy.action('GitHub') }));
}

describe('signing in before the source is saved', () => {
  test('waits with a spinner and Cancel while the provider window is open, then says signed in, and saves with the reference', async () => {
    const { host, signInRequests } = serve({ outcome: 'succeeded' });
    landAt('/capabilities/connect');
    const { getByRole, findByTestId } = render(QueryPage, {
      props: { page: ConnectTools },
    } as never);

    await signIn(getByRole);
    const waiting = await findByTestId('connect-sign-in-waiting');
    expect(waiting.textContent?.trim()).toBe(signInCopy.waiting('GitHub'));
    expect(document.body.textContent).toContain(signInCopy.approve('GitHub'));
    expect(getByRole('link', { name: signInCopy.cancel })).not.toBeNull();
    expect(opened[0]?.location.href).toBe('https://provider.example/authorize?state=host-state');
    expect(signInRequests[0]?.body).toMatchObject({
      id: 'github',
      source: { id: 'github', kind: 'mcp', transport: { authentication: { type: 'oauth' } } },
    });

    // The provider window closes after the host settled the sign-in: the page reads it.
    opened[0]!.closed = true;
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="connect-signed-in"]')?.textContent).toBe(
        signInCopy.signedIn,
      ),
    );

    await fireEvent.submit(document.body.querySelector('[data-testid="connect-form"]')!);
    await waitFor(() =>
      expect(host.requests.some((request) => request.method === 'PUT')).toBe(true),
    );
    const probe = host.requests.find((request) => request.path.endsWith('/probe'));
    expect(probe?.body).toMatchObject({ signIn: 'sign-in-reference' });
    const put = host.requests.find((request) => request.method === 'PUT');
    expect(put?.body).toMatchObject({ signIn: 'sign-in-reference', credentials: {} });
  });

  test('reads a message only from the opened window and the host’s own origin', async () => {
    serve({ outcome: 'waiting' });
    landAt('/capabilities/connect');
    const { getByRole, findByTestId } = render(QueryPage, {
      props: { page: ConnectTools },
    } as never);
    await signIn(getByRole);
    await findByTestId('connect-sign-in-waiting');

    const message = (origin: string, source: unknown = opened[0]) =>
      window.dispatchEvent(
        Object.assign(new window.Event('message'), {
          origin,
          source,
          data: {
            type: 'interborough:tool-source-sign-in',
            signIn: 'sign-in-reference',
            outcome: 'succeeded',
          },
        }),
      );
    // The right window and the right sign-in, from another origin: not read.
    message('https://evil.example');
    await tick();
    await tick();
    expect(document.body.querySelector('[data-testid="connect-signed-in"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="connect-sign-in-waiting"]')).not.toBeNull();
    // The right origin from a window the page did not open: not read either.
    message(window.location.origin, new FakeWindow());
    await tick();
    await tick();
    expect(document.body.querySelector('[data-testid="connect-signed-in"]')).toBeNull();

    // The opened window, from the host's own origin: read. This fails if the listener is dead.
    message(window.location.origin);
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="connect-signed-in"]')).not.toBeNull(),
    );
  });

  test('says a closed window canceled the sign-in, in neutral words, with Try again', async () => {
    serve({ outcome: 'waiting' });
    landAt('/capabilities/connect');
    const { getByRole, findByTestId } = render(QueryPage, {
      props: { page: ConnectTools },
    } as never);
    await signIn(getByRole);
    await findByTestId('connect-sign-in-waiting');

    opened[0]!.closed = true;
    // A neutral note under the Sign in choice, not an error (row 34k).
    await waitFor(() =>
      expect(document.body.querySelector('.cinder-form-field__note')?.textContent?.trim()).toBe(
        signInCopy.canceled('GitHub'),
      ),
    );
    expect(document.body.querySelector('[data-cinder-error]')).toBeNull();
    // The button keeps its label; Try again is the message's own quiet link beside it.
    expect(
      document.body.querySelector('[data-testid="connect-sign-in-start"]')?.textContent?.trim(),
    ).toBe(signInCopy.action('GitHub'));
    expect(getByRole('link', { name: signInCopy.tryAgain })).not.toBeNull();
  });

  test('says the waiting line below the Waiting button, as the button’s own line (row 34y)', async () => {
    serve({ outcome: 'waiting' });
    landAt('/capabilities/connect');
    const { getByRole, findByTestId } = render(QueryPage, {
      props: { page: ConnectTools },
    } as never);
    await signIn(getByRole);
    await findByTestId('connect-sign-in-waiting');

    const button = document.body.querySelector('[data-testid="connect-sign-in-waiting"]')!;
    const line = document.body.querySelector('[data-testid="connect-sign-in-approve"]')!;
    expect(line.textContent?.trim()).toBe(signInCopy.approve('GitHub'));
    // A Cinder Text, after the button in the document, and not the choice's description above it.
    expect(line.className).toContain('cinder-text');
    expect(button.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      document.body.querySelector('#connect-authentication')?.hasAttribute('aria-describedby'),
    ).toBe(false);
  });

  test('says why the provider refused, from the host’s reason, with Try again, and keeps every field', async () => {
    serve({ outcome: 'refused', reason: 'invalid_request' });
    landAt('/capabilities/connect');
    const { getByRole, findByTestId } = render(QueryPage, {
      props: { page: ConnectTools },
    } as never);
    await signIn(getByRole);
    await findByTestId('connect-sign-in-waiting');

    await fireEvent.click(getByRole('link', { name: signInCopy.cancel }));
    // The choice's own error, with Try again as its action; the button keeps its label (rows 34k, 34l).
    await findByTestId('connect-sign-in-try-again');
    const refused = document.body.querySelector('[data-cinder-error]');
    expect(refused?.textContent).toContain(
      signInCopy.refused('GitHub', signInCopy.reasons['invalid_request'] ?? ''),
    );
    expect(refused?.getAttribute('aria-live')).toBe('polite');
    expect(
      document.body.querySelector('[data-testid="connect-sign-in-start"]')?.textContent?.trim(),
    ).toBe(signInCopy.action('GitHub'));
    await fireEvent.click(getByRole('link', { name: signInCopy.tryAgain }));
    await findByTestId('connect-sign-in-waiting');
    expect(field('connect-url').value).toBe('https://mcp.github.example/mcp');
    expect(field('connect-name').value).toBe('GitHub');
  });
});
