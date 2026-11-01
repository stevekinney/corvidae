/**
 * COR-1991: Connect a source from Capabilities › Sources. The dialog builds the host's request from
 * the form, tests the source before it saves it, says why a test failed without a credential or an
 * address in the words, saves it, and offers the restart that lists its tools. The host's own
 * routes are exercised against a real host in `src/host/host-tool-sources.test.ts` and the
 * Playwright suite (`connect-tools.spec.ts`).
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../../app/copy.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import { restartProbing } from '../settings/plugins/restart-flow.svelte.ts';
import CapabilitiesPage from './index.svelte';
import {
  fakeToolSources,
  source,
  sourceTool,
  type FakeToolSources,
} from './sources-host.test-support.ts';

const copy = CAPABILITIES_COPY.source;
const TOKEN = 'connect-token-that-must-never-be-printed';
const ADDRESS = 'https://tools.example.internal/mcp';

let restore: (() => void) | undefined;
const probing = { ...restartProbing };

beforeEach(() => {
  restartProbing.delayMs = 0;
  restartProbing.unchangedLimit = 3;
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  Object.assign(restartProbing, probing);
});

const mount = () => render(QueryPage, { props: { page: CapabilitiesPage } } as never);

function serve(initial: Parameters<typeof fakeToolSources>[0]): FakeToolSources {
  const { host, other } = fakeToolSources(initial);
  restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, other).restore;
  return host;
}

/** The field with this id, in the dialog. */
function field<Element extends HTMLElement = HTMLInputElement>(id: string): Element {
  const found = document.body.querySelector<Element>(`#${id}`);
  if (found === null) throw new Error(`no field ${id}`);
  return found;
}

async function type(id: string, value: string): Promise<void> {
  await fireEvent.input(field(id), { target: { value } });
}

async function choose(id: string): Promise<void> {
  await fireEvent.click(field(id));
}

function buttonLabelled(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
}

const requestsTo = (host: FakeToolSources, method: string, suffix = '') =>
  host.requests.filter((request) => request.method === method && request.path.endsWith(suffix));

/** Opens the dialog on a page that lists `sources`. */
async function openDialog(initial: Parameters<typeof fakeToolSources>[0] = { sources: [] }) {
  const host = serve(initial);
  landAt('/capabilities?tab=sources');
  const view = mount();
  await waitFor(() =>
    expect(view.container.querySelector('[data-testid="sources-panel"]')).not.toBeNull(),
  );
  await waitFor(() => buttonLabelled(copy.connect.action));
  await fireEvent.click(buttonLabelled(copy.connect.action));
  await view.findByTestId('connect-form');
  return { host, ...view };
}

async function fillBearerMcp(): Promise<void> {
  await type('connect-id', 'notes');
  await type('connect-url', ADDRESS);
  await choose('connect-authentication-bearer');
  await type('connect-secret', TOKEN);
}

describe('Connect a source', () => {
  test('is offered on an empty list and beside a list, and starts with an empty form each time', async () => {
    const empty = await openDialog();
    await type('connect-id', 'half-typed');
    await fireEvent.click(buttonLabelled(copy.connect.actions.cancel));
    expect(empty.queryByTestId('connect-form')).toBeNull();
    await fireEvent.click(buttonLabelled(copy.connect.action));
    await empty.findByTestId('connect-form');
    expect(field('connect-id').value).toBe('');
    cleanup();
    restore?.();

    await openDialog({ sources: [source('notes')] });
    expect(document.body.querySelector('[data-testid="connect-form"]')).not.toBeNull();
  });

  test('tests an MCP server with a bearer token, lists its tools with their tiers, and saves nothing', async () => {
    const { host, findByTestId, findByText } = await openDialog();
    host.probe = {
      outcome: 'listed',
      tools: [
        { name: 'notes__lookup', tool: 'lookup', tier: 'read-only' },
        { name: 'notes__wipe', tool: 'wipe', tier: 'dangerous' },
      ],
      skipped: [],
    };
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.probe.action));

    await findByText(copy.connect.probe.listed(2));
    const listed = await findByTestId('connect-result');
    expect(listed.querySelector('[data-probe-tool="notes__lookup"]')?.textContent).toContain(
      'Reads only',
    );
    expect(listed.querySelector('[data-probe-tool="notes__wipe"]')?.textContent).toContain(
      'Dangerous',
    );
    expect(requestsTo(host, 'POST', '/probe')).toEqual([
      {
        method: 'POST',
        path: '/host/tool-sources/notes/probe',
        body: {
          source: {
            id: 'notes',
            kind: 'mcp',
            transport: {
              type: 'http',
              url: ADDRESS,
              authentication: { type: 'bearer', credential: 'token' },
            },
          },
          credentials: { token: TOKEN },
        },
      },
    ]);
    expect(requestsTo(host, 'PUT')).toEqual([]);
  });

  test('says why a test failed in the host’s words, with no credential and no address in them', async () => {
    const { host, findByTestId } = await openDialog();
    host.probe = {
      outcome: 'failed',
      message:
        'The source could not be reached, or did not answer as an MCP server or OpenAPI service should.',
    };
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.probe.action));

    const reason = await findByTestId('connect-probe-reason');
    expect(reason.textContent).toContain('could not be reached');
    const dialog = document.body.querySelector('[data-testid="connect-result"]')!;
    expect(dialog.textContent).not.toContain(TOKEN);
    expect(dialog.textContent).not.toContain(ADDRESS);
    expect(document.body.innerHTML).not.toContain(`>${TOKEN}<`);
  });

  test('says a server that asks for a sign-in is there, and that the sign-in follows saving', async () => {
    const { host, findByTestId } = await openDialog();
    host.probe = { outcome: 'needs-authorization' };
    await type('connect-id', 'ledger');
    await type('connect-url', ADDRESS);
    await choose('connect-authentication-oauth');

    await fireEvent.click(buttonLabelled(copy.connect.probe.action));

    const notice = await findByTestId('connect-needs-authorization');
    expect(notice.textContent).toContain(copy.connect.probe.needsAuthorization);
    // An OAuth source holds no credential of its own.
    expect(requestsTo(host, 'POST', '/probe')[0]?.body).toMatchObject({
      source: { transport: { authentication: { type: 'oauth' } } },
      credentials: {},
    });
    expect(document.body.querySelector('#connect-secret')).toBeNull();
  });

  test('forgets a test once the form changes', async () => {
    const { host, findByTestId, queryByTestId } = await openDialog();
    host.probe = { outcome: 'failed', message: 'The source did not answer in time.' };
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.probe.action));
    await findByTestId('connect-probe-failed');

    await type('connect-url', `${ADDRESS}/v2`);

    await waitFor(() => expect(queryByTestId('connect-probe-failed') === null).toBe(true));
  });

  test('names what is missing, and sends nothing, until the form can make a request', async () => {
    const { host, findByText } = await openDialog();

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByText(copy.connect.errors.idRequired);
    await findByText(copy.connect.errors.urlRequired);
    await type('connect-id', 'Not valid');
    await findByText(copy.connect.errors.idInvalid);
    await choose('connect-authentication-bearer');
    await findByText(copy.connect.errors.secretRequired.bearer);
    expect(host.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  test('connects an OpenAPI service from a file with a base URL and an API key', async () => {
    const { host, findByTestId } = await openDialog();
    await choose('connect-kind-openapi');
    await type('connect-id', 'petstore');
    await choose('connect-specification-file');
    const input = field('connect-file');
    const document = { openapi: '3.0.0', info: { title: 'Pets', version: '1' }, paths: {} };
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(document)], 'pets.json', { type: 'application/json' })],
    });
    await fireEvent.change(input);
    await waitFor(() => expect(document_help()).toContain(copy.connect.file.chosen('pets.json')));
    await type('connect-base-url', 'https://pets.example.internal');
    await choose('connect-authentication-api-key');
    await type('connect-header', 'x-api-key');
    await type('connect-secret', TOKEN);

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await waitFor(() => expect(requestsTo(host, 'PUT')).toHaveLength(1));
    expect(requestsTo(host, 'PUT')[0]).toEqual({
      method: 'PUT',
      path: '/host/tool-sources/petstore',
      body: {
        source: {
          id: 'petstore',
          kind: 'openapi',
          specification: { type: 'document', document },
          baseUrl: 'https://pets.example.internal',
          authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
        },
        credentials: { key: TOKEN },
        create: true,
      },
    });
    await waitFor(() => expect(document_dialogGone()).toBe(true));
    await findByTestId('source-detail');
  });

  test('says a file that is not an OpenAPI document is not one, and a file that is too large is refused', async () => {
    const { findByText } = await openDialog();
    await choose('connect-kind-openapi');
    await type('connect-id', 'petstore');
    await choose('connect-specification-file');
    const input = field('connect-file');

    Object.defineProperty(input, 'files', {
      value: [new File(['not json'], 'pets.json')],
      configurable: true,
    });
    await fireEvent.change(input);
    await fireEvent.click(buttonLabelled(copy.connect.probe.action));
    await findByText(copy.connect.errors.documentInvalid);

    const large = new File(['{}'], 'huge.json');
    Object.defineProperty(large, 'size', { value: 3_000_001 });
    Object.defineProperty(input, 'files', { value: [large], configurable: true });
    await fireEvent.change(input);
    await findByText(copy.connect.file.tooLarge);
  });

  test('connects a local command with its arguments, one per line', async () => {
    const { host } = await openDialog();
    await choose('connect-transport-stdio');
    await type('connect-id', 'files');
    await type('connect-command', 'npx');
    await type('connect-args', '-y\n\n  @acme/server  \n');

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await waitFor(() => expect(requestsTo(host, 'PUT')).toHaveLength(1));
    expect(requestsTo(host, 'PUT')[0]?.body).toEqual({
      source: {
        id: 'files',
        kind: 'mcp',
        transport: { type: 'stdio', command: 'npx', args: ['-y', '@acme/server'] },
      },
      credentials: {},
      create: true,
    });
  });

  test('shows the host’s refusal of a local command for someone who is not the owner, and keeps the form', async () => {
    const { host, findByTestId } = await openDialog();
    await choose('connect-transport-stdio');
    await type('connect-id', 'files');
    await type('connect-command', 'npx');
    host.refuseNext = Response.json(
      {
        error: 'owner-only',
        message: 'Only the owner may add a source that runs a command on this machine.',
      },
      { status: 403 },
    );

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    const failure = await findByTestId('connect-failure');
    expect(failure.textContent).toContain('Only the owner may add a source');
    expect(field('connect-command').value).toBe('npx');
  });

  test('puts a refusal the host names a field for under that field', async () => {
    const { host, findByText } = await openDialog();
    await fillBearerMcp();
    host.refuseNext = Response.json(
      {
        error: 'invalid',
        field: 'source.transport.url',
        message:
          'Invalid source.transport.url: expected an http or https URL without a username or password.',
      },
      { status: 400 },
    );

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByText(/expected an http or https URL/);
    expect(document.body.querySelector('[data-testid="connect-failure"]')).toBeNull();
    expect(field('connect-url').getAttribute('aria-invalid')).toBe('true');
    expect(field('connect-url').value).toBe(ADDRESS);
  });

  test('refuses a name that is taken, and one another tab took after the list was read', async () => {
    const { host, findByText } = await openDialog({ sources: [source('notes')] });
    await fillBearerMcp();
    await findByText(copy.connect.exists('notes'));
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));
    expect(requestsTo(host, 'PUT')).toEqual([]);

    // Another tab saves `fresh` after this page listed its sources: the host refuses to replace it.
    await type('connect-id', 'fresh');
    host.sources = [...host.sources, source('fresh')];
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByText(copy.connect.exists('fresh'));
    expect(requestsTo(host, 'PUT')).toHaveLength(1);
    expect(requestsTo(host, 'PUT')[0]?.body).toMatchObject({ create: true });
    expect(host.sources.find((entry) => entry.id === 'fresh')?.state).toBe('loaded');
    // The form is as it was.
    expect(field('connect-url').value).toBe(ADDRESS);
    expect(field('connect-secret').value).toBe(TOKEN);
  });

  test('keeps what was typed when the list is read again', async () => {
    const { host, container } = await openDialog({ sources: [source('notes')] });
    await type('connect-id', 'mine');
    host.sources = [...host.sources, source('other')];

    window.dispatchEvent(new window.Event('visibilitychange'));

    await waitFor(() =>
      expect(container.querySelector('[data-source-row="other"]')).not.toBeNull(),
    );
    expect(field('connect-id').value).toBe('mine');
  });

  test('is held when the host keeps its configuration in its deployment', async () => {
    serve({ sources: [source('notes')], lockReason: 'deployment' });
    landAt('/capabilities?tab=sources');
    const { findByTestId } = mount();
    await findByTestId('sources-count');

    expect(buttonLabelled(copy.connect.action).hasAttribute('disabled')).toBe(true);
  });
});

describe('after a source is saved', () => {
  test('opens it, offers to restart, and lists its tools when the host is back', async () => {
    const { host, findByTestId, findByText } = await openDialog();
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    const detail = await findByTestId('source-detail');
    expect(detail.getAttribute('data-source')).toBe('notes');
    expect(detail.getAttribute('data-state')).toBe('pending-restart');
    await findByText(copy.connect.connected('notes'));
    const banner = await findByTestId('sources-restart');
    expect(banner.textContent).toContain(copy.restart.title(1));

    host.sources = host.sources.map((entry) => ({
      ...entry,
      tools: [sourceTool('notes', 'lookup')],
    }));
    await fireEvent.click(buttonLabelled(copy.restart.action));

    await findByTestId('sources-restart-back');
    expect(host.restarts).toBe(1);
    await waitFor(() =>
      expect(
        document.body.querySelector('[data-testid="source-detail"]')?.getAttribute('data-state'),
      ).toBe('loaded'),
    );
    expect(document.body.querySelector('[data-source-tool="notes__lookup"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="sources-restart"]')).toBeNull();
  });

  test('says the host did not restart when it keeps answering with the source still waiting', async () => {
    const { host, findByTestId } = await openDialog();
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));
    await findByTestId('sources-restart');
    // Nothing supervises this host: it answers 202 and goes on running.
    host.restartApplies = false;

    await fireEvent.click(buttonLabelled(copy.restart.action));

    const notice = await findByTestId('sources-restart-unconfirmed');
    expect(notice.textContent).toContain(copy.restart.unconfirmed);
    await fireEvent.click(notice.querySelector<HTMLElement>('.cinder-alert__dismiss')!);
    await waitFor(() =>
      expect(
        document.body.querySelector('[data-testid="sources-restart-unconfirmed"]') === null,
      ).toBe(true),
    );
  });

  test('says the host is back once it has been down, even if the source still shows as waiting', async () => {
    const { host, findByTestId } = await openDialog();
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));
    await findByTestId('sources-restart');
    // The first two reads after the restart find the host stopped.
    host.restartApplies = false;
    host.downReads = 2;

    await fireEvent.click(buttonLabelled(copy.restart.action));

    const back = await findByTestId('sources-restart-back');
    expect(host.downReads).toBe(0);
    // The person reads how it ended and dismisses it.
    await fireEvent.click(back.querySelector<HTMLElement>('.cinder-alert__dismiss')!);
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="sources-restart-back"]') === null).toBe(
        true,
      ),
    );
  });

  test('says when the host would not take the request, or could not be reached', async () => {
    const { host, findByTestId } = await openDialog();
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));
    await findByTestId('sources-restart');

    host.restart = Response.json({ error: 'failed' }, { status: 500 });
    await fireEvent.click(buttonLabelled(copy.restart.action));
    await waitFor(() =>
      expect(
        document.body.querySelector('[data-testid="sources-restart-refusal"]')?.textContent,
      ).toContain(copy.restart.refusal.refused),
    );

    host.restartUnreachable = true;
    await fireEvent.click(buttonLabelled(copy.restart.action));
    await waitFor(() =>
      expect(
        document.body.querySelector('[data-testid="sources-restart-refusal"]')?.textContent,
      ).toContain(copy.restart.refusal.unreachable),
    );
    expect(host.restarts).toBe(2);
  });

  test('says why the host would not restart, and offers the restart again', async () => {
    const { host, findByTestId } = await openDialog();
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));
    await findByTestId('sources-restart');
    host.restart = Response.json({ error: 'locked' }, { status: 403 });

    await fireEvent.click(buttonLabelled(copy.restart.action));

    const refusal = await findByTestId('sources-restart-refusal');
    expect(refusal.textContent).toContain(copy.restart.refusal.locked);
    expect(buttonLabelled(copy.restart.action)).not.toBeNull();
  });

  test('asks for a sign-in before a restart for an OAuth source, and for the restart once it is signed in', async () => {
    const { host, findByText, queryByTestId } = await openDialog();
    await type('connect-id', 'ledger');
    await type('connect-url', ADDRESS);
    await choose('connect-authentication-oauth');

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByText(copy.signIn.savedFirst);
    expect(buttonLabelled(copy.signIn.action)).not.toBeNull();
    // Signing in comes first: a restart would list nothing.
    expect(queryByTestId('sources-restart')).toBeNull();
    host.sources = host.sources.map((entry) => ({ ...entry, authorized: true }));
    window.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(() => expect(queryByTestId('sources-restart')).not.toBeNull());
  });
});

function document_help(): string {
  return document.body.querySelector('#connect-file-help')?.textContent ?? '';
}

function document_dialogGone(): boolean {
  return document.body.querySelector('[data-testid="connect-form"]') === null;
}
