/**
 * One tool source on the Sources tab (COR-2022, board PageCapabilities): its name with its address,
 * the sentence about it and where it stands; Sign in, Test connection and the ⋯ menu in the header;
 * and the always-editable table of its tools, whose On checkbox and Default asks select save at
 * once with an inline "Saved". Test connection says what it found, or that the source did not
 * answer, and leaves the status to the host.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../../app/copy.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import CapabilitiesPage from './index.svelte';
import {
  fakeToolSources,
  source,
  sourceTool,
  type FakeToolSources,
} from './sources-host.test-support.ts';

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  for (const restore of restores.splice(0).toReversed()) restore();
});

const copy = CAPABILITIES_COPY;
const mount = () => render(QueryPage, { props: { page: CapabilitiesPage } } as never);

const HOUR = 3_600_000;

/** GitHub as the sample world has it: three tools, one of them off. */
const GITHUB = source('github', {
  name: 'GitHub',
  description: 'An MCP server for issues and files in your repositories.',
  address: 'https://mcp.github.example/mcp',
  tools: [
    sourceTool('github', 'list_issues'),
    sourceTool('github', 'create_issue', { tier: 'mutating' }),
    sourceTool('github', 'delete_branch', {
      tier: 'dangerous',
      enabled: false,
      savedEnabled: false,
    }),
  ],
});

/** The Payments API, an OpenAPI source (row 32k), tested an hour ago and signed in with a stored key. */
const PAYMENTS = () =>
  source('payments', {
    kind: 'openapi',
    name: 'Payments API',
    address: 'https://api.example.com/openapi.json',
    lastTested: new Date(Date.now() - HOUR).toISOString(),
    credentials: ['payments-key'],
    tools: [
      sourceTool('payments', 'list_invoices'),
      sourceTool('payments', 'create_invoice', { tier: 'mutating' }),
    ],
  });

function serve(initial: Parameters<typeof fakeToolSources>[0]): FakeToolSources {
  const { host, other } = fakeToolSources(initial);
  restores.push(
    bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, other).restore,
  );
  return host;
}

/** The text of the first element inside the open source's detail that `selector` finds. */
const textIn = (container: Element, selector: string) =>
  container.querySelector(selector)?.textContent?.replaceAll(/\s+/g, ' ').trim();

/** The button named `label`, by its text or, for an icon-only one, its accessible name. */
function buttonNamed(container: ParentNode, label: string): HTMLElement {
  // A menu item is a button too, and its words repeat the header's, so it is not one of these.
  const found = [...container.querySelectorAll<HTMLElement>('button:not([role="menuitem"])')].find(
    (button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`no button named ${label}`);
  return found;
}

const rowOf = (container: Element, tool: string) =>
  container.querySelector<HTMLElement>(`[data-source-tool="${tool}"]`)!;

describe('the header of a source', () => {
  test('names the source with its address and sentence, and says where it stands (rows 31o, 31r)', async () => {
    serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { container, findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    expect(textIn(detail, '[data-testid="source-name"]')).toBe('GitHub');
    expect(textIn(detail, '[data-testid="source-address"]')).toBe('https://mcp.github.example/mcp');
    expect(textIn(detail, '[data-testid="source-description"]')).toBe(
      'An MCP server for issues and files in your repositories.',
    );
    expect(textIn(detail, '[data-testid="source-state"]')).toContain(copy.source.states.loaded);
    expect(textIn(detail, '[data-testid="tools-note"]')).toBe(copy.source.tools.note(2, 3));
    expect(copy.source.tools.note(2, 3).startsWith('2 of 3 tools are on.')).toBe(true);
    // Test connection is secondary, and the list row is titled by the name, not the identifier.
    expect(buttonNamed(detail, copy.source.test.action).getAttribute('data-cinder-variant')).toBe(
      'secondary',
    );
    expect(container.querySelector('[data-source-row="github"]')?.textContent).toContain('GitHub');
  });

  test('says how an OpenAPI source signs in, when it was last tested and what it is (row 32k)', async () => {
    serve({ sources: [PAYMENTS()] });
    landAt('/capabilities?tab=sources&source=payments');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    expect(textIn(detail, '[data-testid="source-name"]')).toBe('Payments API');
    expect(textIn(detail, '[data-testid="source-address"]')).toBe(
      'https://api.example.com/openapi.json',
    );
    const facts = [...detail.querySelectorAll('[data-testid="source-status"] li')].map((fact) =>
      fact.textContent?.trim(),
    );
    expect(facts).toEqual([
      copy.source.status.auth.credentials,
      copy.source.status.lastTested('1 h ago'),
      copy.source.kinds.openapi,
    ]);
    expect(copy.source.kinds.openapi).toBe('OpenAPI spec');
  });

  test('lists the operations in the same table with the same Risk and Default asks columns (row 32l)', async () => {
    serve({ sources: [PAYMENTS()] });
    landAt('/capabilities?tab=sources&source=payments');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    const list = rowOf(detail, 'payments__list_invoices');
    expect(list.textContent).toContain('List invoices');
    expect(list.textContent).toContain('list_invoices');
    expect(list.querySelector('[data-testid="tool-risk"]')?.textContent).toBe('Reads');
    expect(list.querySelector('select')?.value).toBe('never');
    const create = rowOf(detail, 'payments__create_invoice');
    expect(create.textContent).toContain('Create invoice');
    expect(create.querySelector('[data-testid="tool-risk"]')?.textContent).toBe('Changes things');
    expect(create.querySelector('select')?.value).toBe('on-changes');
    const columns = [...detail.querySelectorAll('th')].map((head) => head.textContent?.trim());
    expect(columns).toEqual(Object.values(copy.source.tools.columns));
  });

  test('keeps the ⋯ menu to Edit connection, Test connection and Remove source…, the last in the danger colour (row 32m)', async () => {
    serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { findByTestId } = mount();
    await findByTestId('source-detail');

    await fireEvent.click(buttonNamed(document.body, copy.source.menu.label));
    await waitFor(() =>
      expect(document.body.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0),
    );
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      copy.source.menu.edit,
      copy.source.menu.test,
      copy.source.menu.remove,
    ]);
    expect(items.map((item) => item.getAttribute('data-cinder-variant'))).toEqual([
      'default',
      'default',
      'danger',
    ]);
    // Only Remove source is destructive, and the Connect tools page does not read a saved source yet.
    expect(items[0]?.getAttribute('aria-disabled')).toBe('true');
  });

  test('tests the source from the menu as it does from the button', async () => {
    const host = serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { findByTestId } = mount();
    await findByTestId('source-detail');

    await fireEvent.click(buttonNamed(document.body, copy.source.menu.label));
    await waitFor(() =>
      expect(document.body.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0),
    );
    const test = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === copy.source.menu.test,
    );
    await fireEvent.click(test!);

    await findByTestId('test-passed');
    expect(host.requests.filter((request) => request.path.endsWith('/test'))).toHaveLength(1);
  });
});

describe('a source that needs a sign-in', () => {
  const LEDGER = source('ledger', {
    state: 'needs-authorization',
    authorized: false,
    tools: [sourceTool('ledger', 'post_entry', { tier: 'mutating' })],
  });

  test('leads with a primary Sign in, then a secondary Test connection, and no other primary (rows 31t)', async () => {
    serve({ sources: [LEDGER] });
    landAt('/capabilities?tab=sources&source=ledger');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    const actions = [...detail.querySelectorAll<HTMLElement>('.ib-source__actions button')];
    expect(actions.slice(0, 2).map((button) => button.textContent?.trim())).toEqual([
      copy.source.signIn.action,
      copy.source.test.action,
    ]);
    expect(actions.slice(0, 2).map((button) => button.getAttribute('data-cinder-variant'))).toEqual(
      ['primary', 'secondary'],
    );
    expect(detail.querySelectorAll('[data-cinder-variant="primary"]')).toHaveLength(1);
  });

  test('keeps the same rows, paused and inert, with the line under the table (row 31u)', async () => {
    serve({ sources: [LEDGER] });
    landAt('/capabilities?tab=sources&source=ledger');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    const table = await findByTestId('source-tool-table');
    expect(table.hasAttribute('data-paused')).toBe(true);
    expect(rowOf(detail, 'ledger__post_entry').querySelector('select')?.value).toBe('on-changes');
    for (const control of table.querySelectorAll(
      '[role="switch"], input[type="checkbox"], select',
    )) {
      expect(control.hasAttribute('disabled')).toBe(true);
    }
    expect(textIn(detail, '[data-testid="tools-paused"]')).toBe(copy.source.tools.paused);
  });

  test('draws no paused line while the source is signed in', async () => {
    serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { findByTestId, queryByTestId } = mount();
    await findByTestId('source-detail');

    expect(queryByTestId('tools-paused')).toBeNull();
  });
});

describe('a source that fails to read', () => {
  test('shows its reason with one Test connection beside it, and tests it (row 32i)', async () => {
    const host = serve({
      sources: [source('gone', { state: 'failed', message: 'The server did not answer.' })],
    });
    landAt('/capabilities?tab=sources&source=gone');
    const { container, findByTestId } = mount();
    const failure = await findByTestId('source-failure');

    expect(failure.textContent).toContain('The server did not answer.');
    const buttons = [...container.querySelectorAll('button:not([role="menuitem"])')].filter(
      (button) => button.textContent?.trim() === copy.source.test.action,
    );
    expect(buttons).toHaveLength(1);
    expect(failure.contains(buttons[0] ?? null)).toBe(true);

    await fireEvent.click(buttons[0]!);
    await findByTestId('test-passed');
    expect(host.requests.filter((request) => request.path.endsWith('/test'))).toHaveLength(1);
  });
});

describe('Test connection', () => {
  test('says what it reached, and moves the last tested time the host reports', async () => {
    const host = serve({
      sources: [{ ...GITHUB, lastTested: new Date(Date.now() - HOUR).toISOString() }],
    });
    host.testedAt = new Date().toISOString();
    landAt('/capabilities?tab=sources&source=github');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    await fireEvent.click(buttonNamed(detail, copy.source.test.action));

    const passed = await findByTestId('test-passed');
    expect(passed.textContent?.trim()).toBe(copy.source.test.passed('GitHub', 3));
    await waitFor(() =>
      expect(textIn(detail, '[data-testid="source-status"]')).toContain(
        copy.source.status.lastTested('just now'),
      ),
    );
    expect(host.requests.filter((request) => request.path.endsWith('/test'))).toEqual([
      { method: 'POST', path: '/host/tool-sources/github/test', body: {} },
    ]);
  });

  test('asks a source that wants a sign-in to sign in, then test again', async () => {
    const host = serve({ sources: [GITHUB] });
    host.testAnswer = { outcome: 'needs-authorization' };
    landAt('/capabilities?tab=sources&source=github');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    await fireEvent.click(buttonNamed(detail, copy.source.test.action));

    const line = await findByTestId('test-sign-in');
    expect(line.textContent?.trim()).toBe(copy.source.test.needsAuthorization);
  });

  test('shows an inline block when the source did not answer, leaves the status alone, and tests again (row 32q)', async () => {
    const host = serve({ sources: [GITHUB] });
    host.testAnswer = { outcome: 'failed', message: 'The source did not answer in time.' };
    landAt('/capabilities?tab=sources&source=github');
    const { findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    await fireEvent.click(buttonNamed(detail, copy.source.test.action));

    const failed = await findByTestId('test-failed');
    expect(failed.textContent).toContain(copy.source.test.failedTitle('GitHub'));
    expect(failed.textContent).toContain(
      copy.source.test.failedBody('https://mcp.github.example/mcp'),
    );
    expect(failed.textContent).toContain(copy.source.test.toolsKept);
    expect(textIn(failed, '[data-testid="test-failed-reason"]')).toBe(
      'The source did not answer in time.',
    );
    // The test did not run past 15 seconds, so the slow sentence is not said.
    expect(failed.textContent).not.toContain(copy.source.test.failedSlow);
    // The status is the host's: it stays Connected.
    expect(textIn(detail, '[data-testid="source-state"]')).toContain(copy.source.states.loaded);
    expect(rowOf(detail, 'github__list_issues')).not.toBeNull();

    host.testAnswer = { outcome: 'listed', tools: [], skipped: [] };
    await fireEvent.click(buttonNamed(failed, copy.source.test.again));
    await findByTestId('test-passed');
    expect(host.requests.filter((request) => request.path.endsWith('/test'))).toHaveLength(2);
  });

  test('says "Taking longer than usual" after 15 seconds, and names it in the failure that follows (row 32q)', async () => {
    jest.useFakeTimers();
    serve({ sources: [GITHUB] });
    // The host holds the test until the test says otherwise.
    const inner = globalThis.fetch;
    let answer!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    restores.push(
      installFetchImplementation((input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url.endsWith('/host/tool-sources/github/test') ? held : inner(input, init);
      }),
    );
    landAt('/capabilities?tab=sources&source=github');
    const { container } = mount();
    await until(() =>
      expect(container.querySelector('[data-testid="source-detail"]')).not.toBeNull(),
    );

    await fireEvent.click(buttonNamed(container, copy.source.test.action));
    await until(() =>
      expect(textIn(container, '[data-testid="test-running"]')).toBe(
        copy.source.test.testing('GitHub'),
      ),
    );
    jest.advanceTimersByTime(15_000);
    await until(() =>
      expect(textIn(container, '[data-testid="test-running"]')).toBe(
        `${copy.source.test.testing('GitHub')} ${copy.source.test.slow}`,
      ),
    );

    answer(Response.json({ outcome: 'failed', message: 'The source did not answer in time.' }));
    await settle();
    await until(() =>
      expect(textIn(container, '[data-testid="test-failed"]')).toContain(
        copy.source.test.failedSlow,
      ),
    );
  });
});

describe('the tool table', () => {
  test('is always editable: no Edit, Done or Cancel, and the On checkbox saves at once with an inline Saved (row 32r)', async () => {
    const host = serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { container, findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    for (const word of ['Edit', 'Done', 'Cancel']) {
      expect(
        [...detail.querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === word,
        ),
      ).toBe(false);
    }
    expect(textIn(detail, '[data-testid="tools-saved"]')).toBe('');

    const on = rowOf(container, 'github__list_issues').querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    expect(on.checked).toBe(true);
    expect(on.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(on);

    await waitFor(() =>
      expect(textIn(detail, '[data-testid="tools-saved"]')).toBe(copy.source.tools.saved),
    );
    expect(host.requests.filter((request) => request.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/host/tool-sources/github/tools',
        body: {
          tools: { list_issues: { enabled: false } },
          operationId: expect.any(String),
          expectedRevision: JSON.stringify([GITHUB]),
        },
      },
    ]);
    // Read back from the host: the checkbox is off, and the note counts one of three.
    await waitFor(() => expect(on.checked).toBe(false));
    expect(textIn(detail, '[data-testid="tools-note"]')).toBe(copy.source.tools.note(1, 3));
    // Turning one tool off does not reset the other settings: only the named field was sent.
    expect(host.sources[0]?.tools[1]?.savedEnabled).toBeUndefined();
  });

  test('saves the Default asks level at once, one tool at a time, and reads it back', async () => {
    const host = serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { container, findByTestId } = mount();
    const detail = await findByTestId('source-detail');

    const asks = () => rowOf(container, 'github__create_issue').querySelector('select')!;
    expect(asks().value).toBe('on-changes');
    await fireEvent.change(asks(), { target: { value: 'always' } });

    await waitFor(() =>
      expect(textIn(detail, '[data-testid="tools-saved"]')).toBe(copy.source.tools.saved),
    );
    expect(host.requests.filter((request) => request.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/host/tool-sources/github/tools',
        body: {
          tools: { create_issue: { approval: 'always' } },
          operationId: expect.any(String),
          expectedRevision: JSON.stringify([GITHUB]),
        },
      },
    ]);
    await waitFor(() => expect(asks().value).toBe('always'));
    // The others keep the level their tier gives.
    expect(rowOf(container, 'github__list_issues').querySelector('select')?.value).toBe('never');
    expect(rowOf(container, 'github__delete_branch').querySelector('select')?.value).toBe('always');
  });

  test('keeps the value the host holds when it refuses a change, and says nothing was saved', async () => {
    const host = serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { container, findByTestId, findByText } = mount();
    const detail = await findByTestId('source-detail');
    const on = rowOf(container, 'github__list_issues').querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;

    host.refuseNext = Response.json(
      { error: 'invalid', field: 'tools.list_issues.enabled', message: 'expected true or false.' },
      { status: 400 },
    );
    await fireEvent.click(on);

    await findByText(/expected true or false\./);
    await waitFor(() => expect(on.hasAttribute('disabled')).toBe(false));
    expect(on.checked).toBe(true);
    expect(textIn(detail, '[data-testid="tools-saved"]')).toBe('');
  });
});

describe('connecting tools from the Sources tab', () => {
  test('has one primary button when no source is connected, and a secondary "+" in the header (rows 31z, 32a)', async () => {
    serve({ sources: [] });
    landAt('/capabilities?tab=sources');
    const { container, findByText } = mount();

    await findByText(copy.source.empty.title);
    expect(copy.source.empty.title).toBe('No sources connected');
    await findByText(copy.source.empty.description);
    const buttons = [...container.querySelectorAll<HTMLElement>('button')].filter(
      (button) =>
        button.textContent?.trim() === copy.source.connect.action ||
        button.getAttribute('aria-label') === copy.source.connect.action,
    );
    expect(buttons.map((button) => button.getAttribute('data-cinder-variant'))).toEqual([
      'secondary',
      'primary',
    ]);
    // The header's is icon only; the empty state's is the one with words.
    expect(buttons[0]?.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(container.querySelectorAll('[data-cinder-variant="primary"]')).toHaveLength(1);
  });

  test('opens the same dialog from the empty state and from the header', async () => {
    serve({ sources: [] });
    landAt('/capabilities?tab=sources');
    const { container, findByTestId, findByText } = mount();
    await findByText(copy.source.empty.title);
    const buttons = [...container.querySelectorAll<HTMLElement>('button')].filter(
      (button) =>
        button.textContent?.trim() === copy.source.connect.action ||
        button.getAttribute('aria-label') === copy.source.connect.action,
    );

    await fireEvent.click(buttons[1]!);
    await findByTestId('connect-form');
    await fireEvent.click(buttonNamed(document.body, copy.source.connect.actions.cancel));
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="connect-form"]')).toBeNull(),
    );
    await fireEvent.click(buttons[0]!);
    await findByTestId('connect-form');
  });

  test('keeps the header "+" the only connect button once a source is saved', async () => {
    serve({ sources: [GITHUB] });
    landAt('/capabilities?tab=sources&source=github');
    const { container, findByTestId } = mount();
    await findByTestId('source-detail');

    const buttons = [...container.querySelectorAll<HTMLElement>('button')].filter(
      (button) =>
        button.textContent?.trim() === copy.source.connect.action ||
        button.getAttribute('aria-label') === copy.source.connect.action,
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('data-cinder-variant')).toBe('secondary');
  });
});
