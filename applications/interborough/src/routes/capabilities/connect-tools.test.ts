/**
 * COR-2022 (rows 33a to 33r, 34q): Connect tools is a page at `/capabilities/connect`, not a
 * dialog. Its sections run Source, Address, Sign in, Test connection and Choose tools above a
 * docked footer; an MCP server is reached by URL or by a one-line command with a warning under it;
 * Sign in offers OAuth, Bearer token and None. The page builds the host's request from the form,
 * tests the source before it saves it, says why a test failed without a credential or an address
 * in the words, saves it with the tools chosen, and says what is now available. The host's own
 * routes are exercised against a real host in `src/host/host-tool-sources.test.ts` and the
 * Playwright suite (`connect-tools-restart.spec.ts`). The flow's state machine is tested on its own
 * in `connect-tools-state.test.ts`; `connect-tools-flow.test.ts` drives the test, Choose tools,
 * the connect and leaving through this page (rows 33i to 35f).
 */
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import { restartProbing } from '../../app/restart/host-restart-flow.svelte.ts';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import ConnectTools from './connect-tools.svelte';
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

const mount = (page: typeof CapabilitiesPage, client?: QueryClient) =>
  render(QueryPage, {
    props: { page, ...(client === undefined ? {} : { client }) },
  } as never);

function serve(initial: Parameters<typeof fakeToolSources>[0]): FakeToolSources {
  const { host, other } = fakeToolSources(initial);
  restore = bureau({ 'bureau.agents.catalog': () => ({ models: [], tools: [] }) }, other).restore;
  return host;
}

/** The footer's line. */
const summary = () =>
  document.body.querySelector('[data-testid="connect-summary"]')?.textContent?.trim();

/** The field with this id, on the page. */
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

/** Picks URL or Command in Address's segmented control. */
async function reachBy(transport: 'http' | 'stdio'): Promise<void> {
  await fireEvent.click(
    field(`connect-transport`).querySelector<HTMLElement>(
      `[data-cinder-segment-value="${transport}"]`,
    )!,
  );
}

/** The button named `label` by its text or, for the header's icon-only "+", by its accessible name. */
function buttonLabelled(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
}

const requestsTo = (host: FakeToolSources, method: string, suffix = '') =>
  host.requests.filter((request) => request.method === method && request.path.endsWith(suffix));

/** Opens the Connect tools page on a host that lists `sources`. */
async function openPage(
  initial: Parameters<typeof fakeToolSources>[0] = { sources: [] },
  client?: QueryClient,
) {
  const host = serve(initial);
  landAt('/capabilities/connect');
  const view = mount(ConnectTools, client);
  await view.findByTestId('connect-form');
  // The list of saved sources is read, so a taken name is known.
  await waitFor(() => expect(requestsTo(host, 'GET').length).toBeGreaterThan(0));
  return { host, ...view };
}

async function fillBearerMcp(): Promise<void> {
  await type('connect-name', 'notes');
  await type('connect-url', ADDRESS);
  await choose('connect-authentication-bearer');
  await type('connect-secret', TOKEN);
}

describe('the Connect tools page', () => {
  test('is a page with its title in the column, its sections in order, and a docked footer (rows 33b to 33d)', async () => {
    const { container } = await openPage();

    expect(container.querySelector('h1')?.textContent?.trim()).toBe(copy.connect.title);
    expect(container.textContent).toContain(copy.connect.intro);
    const headings = [...container.querySelectorAll('[data-testid="connect-form"] h2')].map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toEqual([
      copy.connect.sections.source,
      copy.connect.sections.address,
      copy.connect.sections.signIn,
      copy.connect.sections.test,
      copy.connect.sections.chooseTools,
    ]);
    // No back link: the breadcrumb is the way back.
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.cinder-form-actions')).not.toBeNull();
    // Before a test passes, the footer says to test to choose tools (row 33n).
    expect(summary()).toBe(copy.connect.chooseFirst);
    expect(buttonLabelled(copy.connect.actions.cancel)).not.toBeNull();
    expect(buttonLabelled(copy.connect.actions.connect)).not.toBeNull();
  });

  test('is opened from the Capabilities header and from the empty Sources tab', async () => {
    serve({ sources: [] });
    landAt('/capabilities?tab=sources');
    const { container, findByText } = mount(CapabilitiesPage);
    await findByText(copy.empty.title);
    const connectButtons = () =>
      [...container.querySelectorAll<HTMLElement>('button')].filter(
        (button) =>
          button.textContent?.trim() === copy.connect.action ||
          button.getAttribute('aria-label') === copy.connect.action,
      );
    expect(connectButtons()).toHaveLength(2);

    for (const index of [0, 1]) {
      landAt('/capabilities?tab=sources');
      await findByText(copy.empty.title);
      await fireEvent.click(connectButtons()[index]!);
      await waitFor(() => expect(router.pathname).toBe('/capabilities/connect'));
    }
  });

  test('reaches an MCP server by URL first, with a required Server URL and Name (row 33f)', async () => {
    const { container } = await openPage();

    const url = container.querySelector('#connect-transport [data-cinder-segment-value="http"]');
    expect(url?.getAttribute('aria-checked')).toBe('true');
    expect(url?.textContent?.trim()).toBe(copy.connect.transport.http);
    expect(field('connect-url').required).toBe(true);
    expect(container.textContent).toContain(copy.connect.url.description);
    expect(field('connect-name').required).toBe(true);
    expect(container.textContent).toContain(copy.connect.name.description);
    expect(container.querySelector('#connect-command')).toBeNull();
  });

  test('reaches one by a command on one line, under a warning, and keeps Name and the footer (rows 33o, 33p, 33r)', async () => {
    const { host, container } = await openPage();
    await reachBy('stdio');

    expect(field('connect-command').required).toBe(true);
    expect(container.querySelector('#connect-url')).toBeNull();
    const warning = container.querySelector('[data-testid="connect-command-warning"]');
    expect(warning?.getAttribute('role')).toBe('note');
    expect(warning?.textContent).toContain(copy.connect.command.warningBefore.trim());
    expect(warning?.querySelector('code')?.textContent).toBe('npx -y');
    expect(field('connect-name').required).toBe(true);
    expect(summary()).toBe(copy.connect.testsFirst);
    // A local command signs in to nothing.
    expect(container.querySelector('[name="connect-authentication"]')).toBeNull();

    await type('connect-command', 'npx -y @example/github-mcp');
    await type('connect-name', 'Files');
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await waitFor(() => expect(requestsTo(host, 'PUT')).toHaveLength(1));
    expect(requestsTo(host, 'PUT')[0]?.body).toEqual({
      source: {
        id: 'files',
        kind: 'mcp',
        transport: { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp'] },
      },
      credentials: {},
      create: true,
      name: 'Files',
      operationId: expect.any(String),
      expectedRevision: '[]',
    });
  });

  test('offers OAuth, Bearer token and None to sign in, OAuth with its note (row 33g)', async () => {
    const { container } = await openPage();

    const options = [
      ...container.querySelectorAll<HTMLInputElement>('input[name="connect-authentication"]'),
    ].map((radio) => radio.id);
    expect(options).toEqual([
      'connect-authentication-oauth',
      'connect-authentication-bearer',
      'connect-authentication-none',
    ]);
    expect(container.textContent).toContain(copy.connect.authentication.oauthNote);

    await choose('connect-authentication-oauth');
    expect(container.querySelector('[data-testid="connect-oauth-help"]')?.textContent).toContain(
      copy.connect.authentication.oauthHelp,
    );
    expect(container.querySelector('#connect-secret')).toBeNull();
  });

  test('asks for a required masked token with Bearer, and tests with it (row 34q)', async () => {
    const { host, container } = await openPage();
    await fillBearerMcp();

    const token = field('connect-secret');
    expect(token.type).toBe('password');
    expect(token.required).toBe(true);
    expect(container.querySelector('label[for="connect-secret"]')?.textContent).toContain(
      copy.connect.secret.bearer.label,
    );
    expect(container.textContent).toContain(copy.connect.secret.description);

    await fireEvent.click(buttonLabelled(copy.connect.probe.action));

    await waitFor(() => expect(requestsTo(host, 'POST', '/probe')).toHaveLength(1));
    expect(requestsTo(host, 'POST', '/probe')[0]?.body).toMatchObject({
      credentials: { token: TOKEN },
    });
  });

  test('tests an MCP server with a bearer token, lists its tools with their tiers, and saves nothing', async () => {
    const { host, findByText } = await openPage();
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

    await findByText(copy.connect.probe.found(2));
    expect(document.body.querySelector('[data-probe-tool="notes__lookup"]')?.textContent).toContain(
      'Reads',
    );
    expect(document.body.querySelector('[data-probe-tool="notes__wipe"]')?.textContent).toContain(
      'Dangerous',
    );
    // A test that passed: the footer counts the tools that join, and Connect names them.
    expect(summary()).toBe(copy.connect.joins(2, 'notes'));
    expect(buttonLabelled(copy.connect.actions.connectCount(2))).not.toBeNull();
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
    const { host, findByTestId } = await openPage();
    host.probe = {
      outcome: 'failed',
      message:
        'The source could not be reached, or did not answer as an MCP server or OpenAPI service should.',
    };
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.probe.action));

    const reason = await findByTestId('connect-probe-reason');
    expect(reason.textContent).toContain('could not be reached');
    const result = document.body.querySelector('[data-testid="connect-result"]')!;
    expect(result.textContent).not.toContain(TOKEN);
    expect(result.textContent).not.toContain(ADDRESS);
    expect(document.body.innerHTML).not.toContain(`>${TOKEN}<`);
  });

  test('says a server that asks for a sign-in is there, and that the sign-in follows saving', async () => {
    const { host, findByTestId } = await openPage();
    host.probe = { outcome: 'needs-authorization' };
    await type('connect-name', 'ledger');
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

  test('lets go of the request, and the token in it, once the page is left', async () => {
    const client = createQueryClient();
    const { host, findByTestId, unmount } = await openPage({ sources: [] }, client);
    host.probe = { outcome: 'failed', message: 'The source did not answer in time.' };
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.probe.action));
    await findByTestId('connect-probe-failed');
    expect(requestsTo(host, 'POST', '/probe')).toHaveLength(1);

    unmount();

    // A mutation keeps its variables, which hold the token, until it is collected.
    await waitFor(() => expect(client.getMutationCache().getAll().length).toBe(0));
  });

  test('forgets a test once the form changes', async () => {
    const { host, findByTestId, queryByTestId } = await openPage();
    host.probe = { outcome: 'failed', message: 'The source did not answer in time.' };
    await fillBearerMcp();
    await fireEvent.click(buttonLabelled(copy.connect.probe.action));
    await findByTestId('connect-probe-failed');

    await type('connect-url', `${ADDRESS}/v2`);

    await waitFor(() => expect(queryByTestId('connect-probe-failed') === null).toBe(true));
  });

  test('names what is missing, and sends nothing, until the form can make a request', async () => {
    const { host, findByText } = await openPage();

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByText(copy.connect.errors.idRequired);
    await findByText(copy.connect.errors.urlRequired);
    await type('connect-name', '42');
    await findByText(copy.connect.errors.nameInvalid);
    await choose('connect-authentication-bearer');
    await findByText(copy.connect.errors.secretRequired.bearer);
    expect(host.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  test('tests the source first when Connect is pressed before a test passed, and saves nothing when it fails (row 33r)', async () => {
    const { host, findByTestId } = await openPage();
    host.probe = { outcome: 'failed', message: 'The source did not answer in time.' };
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByTestId('connect-probe-failed');
    expect(requestsTo(host, 'POST', '/probe')).toHaveLength(1);
    expect(requestsTo(host, 'PUT')).toEqual([]);
  });

  test('connects an OpenAPI service from a file with a base URL and an API key', async () => {
    const { host, findByTestId } = await openPage();
    await choose('connect-kind-openapi');
    await type('connect-name', 'petstore');
    await choose('connect-specification-file');
    const input = field('connect-file');
    const document = { openapi: '3.0.0', info: { title: 'Pets', version: '1' }, paths: {} };
    // The host reads the spec; what it parsed is what the connect sends.
    host.inspection = {
      outcome: 'valid',
      fileName: 'pets.json',
      version: '3.0',
      title: 'Pets',
      baseUrl: null,
      operationCount: 0,
      operations: [],
      testOperation: null,
      document,
    };
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(document)], 'pets.json', { type: 'application/json' })],
    });
    await fireEvent.change(input);
    await waitFor(() => expect(fileHelp()).toContain(copy.connect.file.chosen('pets.json')));
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
        name: 'petstore',
        operationId: expect.any(String),
        expectedRevision: '[]',
      },
    });
    // The name the person typed is kept: the spec's title fills in only an empty Name.
    const awaited443 = await findByTestId('connect-success');
    expect(awaited443.textContent).toContain(copy.connect.success.title('petstore'));
  });

  test('says a file that is not an OpenAPI document is not one, and a file that is too large is refused', async () => {
    const { host, findByText } = await openPage();
    await choose('connect-kind-openapi');
    await type('connect-name', 'petstore');
    await choose('connect-specification-file');
    const input = field('connect-file');

    Object.defineProperty(input, 'files', {
      value: [new File(['not json'], 'pets.json')],
      configurable: true,
    });
    await fireEvent.change(input);
    // The host read it and said what is wrong, in its own words.
    await findByText('This isn’t a valid OpenAPI 3 file. It is not YAML or JSON.');
    expect(requestsTo(host, 'POST', '/host/openapi-inspection')[0]?.body).toEqual({
      text: 'not json',
      fileName: 'pets.json',
    });

    const large = new File(['{}'], 'huge.json');
    Object.defineProperty(large, 'size', { value: 3_000_001 });
    Object.defineProperty(input, 'files', { value: [large], configurable: true });
    await fireEvent.change(input);
    await findByText(copy.connect.file.tooLarge);
  });

  test('shows the host’s refusal of a local command for someone who is not the owner, and keeps the form', async () => {
    const { host, findByTestId } = await openPage();
    await reachBy('stdio');
    await type('connect-name', 'files');
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
    expect(requestsTo(host, 'PUT')).toEqual([]);
  });

  test('puts a refusal the host names a field for under that field', async () => {
    const { host, findByText } = await openPage();
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
    const { host, findByText } = await openPage({ sources: [source('notes')] });
    await fillBearerMcp();
    await findByText(copy.connect.exists('notes'));
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));
    expect(requestsTo(host, 'PUT')).toEqual([]);

    // Another tab saves `fresh` after this page listed its sources: the host refuses to replace it.
    await type('connect-name', 'Fresh');
    host.sources = [...host.sources, source('fresh')];
    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    await findByText(copy.connect.exists('fresh'));
    expect(requestsTo(host, 'PUT')).toHaveLength(1);
    expect(requestsTo(host, 'PUT')[0]?.body).toMatchObject({ create: true, name: 'Fresh' });
    expect(host.sources.find((entry) => entry.id === 'fresh')?.state).toBe('loaded');
    // The form is as it was.
    expect(field('connect-url').value).toBe(ADDRESS);
    expect(field('connect-secret').value).toBe(TOKEN);
  });

  test('is held when the host keeps its configuration in its deployment', async () => {
    const { findByTestId } = await openPage({
      sources: [source('notes')],
      lockReason: 'deployment',
    });

    await findByTestId('connect-locked');
    expect(buttonLabelled(copy.connect.actions.connect).hasAttribute('disabled')).toBe(true);
    expect(buttonLabelled(copy.connect.probe.action).hasAttribute('disabled')).toBe(true);
  });

  test('says the source it saved is connected, and View in Capabilities opens it in Capabilities › Sources', async () => {
    const { host, findByTestId } = await openPage();
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.actions.connect));

    const success = await findByTestId('connect-success');
    expect(success.textContent).toContain(copy.connect.success.title('notes'));
    expect(host.sources.map((entry) => entry.id)).toEqual(['notes']);
    // Saved: leaving asks nothing.
    await fireEvent.click(buttonLabelled(copy.connect.success.view));
    await waitFor(() => expect(router.pathname).toBe('/capabilities'));
    expect(router.search.get('tab')).toBe('sources');
    expect(router.search.get('source')).toBe('notes');
  });

  test('leaves for Capabilities › Sources on Cancel once the person discards what was filled in, saving nothing (row 35b)', async () => {
    const { host, findByRole } = await openPage();
    await fillBearerMcp();

    await fireEvent.click(buttonLabelled(copy.connect.actions.cancel));
    const dialog = await findByRole('dialog', { name: copy.connect.leave.title });
    expect(router.pathname).toBe('/capabilities/connect');
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.connect.leave.discard }));

    await waitFor(() => expect(router.pathname).toBe('/capabilities'));
    expect(router.search.get('tab')).toBe('sources');
    expect(host.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
});

describe('a saved source that waits for a restart', () => {
  const PENDING = { sources: [source('notes', { state: 'pending-restart' })] };

  async function openSources(initial: Parameters<typeof fakeToolSources>[0] = PENDING) {
    const host = serve(initial);
    landAt(`/capabilities?tab=sources&source=${initial.sources[0]?.id ?? ''}`);
    const view = mount(CapabilitiesPage);
    await view.findByTestId('source-detail');
    return { host, ...view };
  }

  test('offers to restart, and lists its tools when the host is back', async () => {
    const { host, findByTestId } = await openSources();
    const detail = await findByTestId('source-detail');
    expect(detail.getAttribute('data-state')).toBe('pending-restart');
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
    const { host, findByTestId } = await openSources();
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
    const { host, findByTestId } = await openSources();
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
    const { host, findByTestId } = await openSources();
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
    const { host, findByTestId } = await openSources();
    await findByTestId('sources-restart');
    host.restart = Response.json({ error: 'locked' }, { status: 403 });

    await fireEvent.click(buttonLabelled(copy.restart.action));

    const refusal = await findByTestId('sources-restart-refusal');
    expect(refusal.textContent).toContain(copy.restart.refusal.locked);
    expect(buttonLabelled(copy.restart.action)).not.toBeNull();
  });

  test('asks for a sign-in before a restart for an OAuth source, and for the restart once it is signed in', async () => {
    const { host, findByText, queryByTestId } = await openSources({
      sources: [source('ledger', { state: 'pending-restart', authorized: false })],
    });

    await findByText(copy.signIn.savedFirst);
    expect(buttonLabelled(copy.signIn.action)).not.toBeNull();
    // Signing in comes first: a restart would list nothing.
    expect(queryByTestId('sources-restart')).toBeNull();
    host.sources = host.sources.map((entry) => ({ ...entry, authorized: true }));
    window.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(() => expect(queryByTestId('sources-restart')).not.toBeNull());
  });
});

function fileHelp(): string {
  return document.body.querySelector('#connect-file-help')?.textContent ?? '';
}
