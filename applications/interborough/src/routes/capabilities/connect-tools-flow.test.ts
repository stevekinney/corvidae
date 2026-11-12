/**
 * COR-2022 (board PageConnectTools, rows 33i to 35f): the Connect tools page from the test of the
 * connection to the source being connected. Choose tools is a dashed box until a test passes, then a
 * table of what the source offers with an On checkbox and an Asks level per tool; an OpenAPI spec is
 * read by the host as soon as it is chosen and lists its operations with a filter, a risk filter, a
 * count and Select all. Connect tests first, stays cancellable while it runs, says when it is taking
 * longer than usual, keeps every choice when it fails, and ends on a success state with Give to an
 * agent and View in Capabilities. Leaving a filled form asks first; an untouched one leaves at once;
 * while the server does not answer the form stays editable and Test connection and Connect say why
 * they are off. The state machine itself is `connect-tools-state.test.ts`.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import type { OpenApiInspection, ToolSourceProbe } from '../../lib/host-tool-sources.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import QueryPage from '../chat/chat-toasts.test-harness.svelte';
import { bureau, landAt } from '../chat/pages.test-support.ts';
import { connectTiming } from './connect-tools-state.svelte.ts';
import ConnectTools from './connect-tools.svelte';
import { fakeToolSources, source, type FakeToolSources } from './sources-host.test-support.ts';

const copy = CAPABILITIES_COPY.source.connect;
const ADDRESS = 'https://mcp.github.example/mcp';

const restores: (() => void)[] = [];
const monitors: ConnectionMonitor[] = [];

afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0).toReversed()) restore();
  for (const monitor of monitors.splice(0)) monitor.dispose();
  connectTiming.slowAfterMilliseconds = 15_000;
});

/** GitHub as the sample world has it: one tool that reads, one that changes things, one dangerous. */
const GITHUB_PROBE: ToolSourceProbe = {
  outcome: 'listed',
  tools: [
    { name: 'github__list_issues', tool: 'list_issues', tier: 'read-only', title: 'List issues' },
    { name: 'github__create_issue', tool: 'create_issue', tier: 'mutating', title: 'Create issue' },
    {
      name: 'github__delete_branch',
      tool: 'delete_branch',
      tier: 'dangerous',
      title: 'Delete branch',
    },
  ],
  skipped: [],
};

/** The agents the Bureau lists: three an owner's file defines, one defined in code, one a plugin ships. */
const AGENTS = [
  { name: 'tool-runner', displayName: 'Tool runner' },
  { name: 'assistant', displayName: 'Assistant', kind: 'code' },
  { name: 'workflow-author', displayName: 'Workflow author' },
  { name: 'acme:helper', displayName: 'Acme helper' },
  { name: 'model-switcher', displayName: 'Model switcher' },
].map(({ name, displayName, kind }) => ({
  name,
  displayName,
  description: null,
  definitionRevision: 1,
  kind: kind ?? 'file',
  a2a: false,
}));

function serve(initial: Parameters<typeof fakeToolSources>[0]): FakeToolSources {
  const { host, other } = fakeToolSources(initial);
  restores.push(
    bureau(
      {
        'bureau.agents.catalog': () => ({ models: [], tools: [] }),
        'bureau.agents.list': () => ({ agents: AGENTS }),
      },
      other,
    ).restore,
  );
  return host;
}

/**
 * Holds the host's answer to `method` on the path ending `suffix` until the test releases it, and
 * records the signal each such request was sent with.
 */
function hold(method: string, suffix: string) {
  const inner = globalThis.fetch;
  const held = Promise.withResolvers<Response>();
  const signals: (AbortSignal | undefined)[] = [];
  restores.push(
    installFetchImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (
        (init?.method ?? 'GET') === method &&
        new URL(url, 'http://localhost').pathname.endsWith(suffix)
      ) {
        signals.push(init?.signal ?? undefined);
        return held.promise;
      }
      return inner(input, init);
    }),
  );
  return { release: (response: Response) => held.resolve(response), signals };
}

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

/** The button whose text is `label`. */
function buttonLabelled(label: string, within: ParentNode = document.body): HTMLElement {
  const found = [...within.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
}

const requestsTo = (host: FakeToolSources, method: string, suffix = '') =>
  host.requests.filter((request) => request.method === method && request.path.endsWith(suffix));

/** The text of the element with this test id, with its white space collapsed. */
const textOf = (testId: string) =>
  document.body
    .querySelector(`[data-testid="${testId}"]`)
    ?.textContent?.replaceAll(/\s+/g, ' ')
    .trim();

const present = (testId: string) =>
  document.body.querySelector(`[data-testid="${testId}"]`) !== null;

/** Opens the page on a host that lists `sources`, shown to the shell's `connection` when one is given. */
async function openPage(
  initial: Parameters<typeof fakeToolSources>[0] = { sources: [] },
  connection?: ConnectionMonitor,
) {
  const host = serve(initial);
  landAt('/capabilities/connect');
  const view = render(QueryPage, {
    props: { page: ConnectTools, ...(connection === undefined ? {} : { connection }) },
  } as never);
  await view.findByTestId('connect-form');
  await waitFor(() => expect(requestsTo(host, 'GET').length).toBeGreaterThan(0));
  return { host, ...view };
}

async function fillGitHub(): Promise<void> {
  await type('connect-url', ADDRESS);
  await type('connect-name', 'GitHub');
}

/** Tests GitHub, which lists its three tools. */
async function testGitHub(host: FakeToolSources): Promise<void> {
  host.probe = GITHUB_PROBE;
  await fillGitHub();
  await fireEvent.click(buttonLabelled(copy.probe.action));
  await waitFor(() => expect(textOf('connect-listed')).toBe(copy.probe.found(3)));
}

const rowOf = (tool: string) =>
  document.body.querySelector<HTMLElement>(`[data-probe-tool="github__${tool}"]`);

describe('testing the connection', () => {
  test('before a test passes, Choose tools is a dashed box under its intro, and Connect stays enabled (rows 33m, 33n)', async () => {
    await openPage();

    expect(textOf('connect-choose-intro')).toBe(copy.chooseTools.intro);
    expect(textOf('connect-choose-locked')).toBe(copy.chooseTools.locked);
    expect(document.body.querySelector('[data-testid="connect-choose-table"]')).toBeNull();
    expect(textOf('connect-summary')).toBe(copy.chooseFirst);
    expect(buttonLabelled(copy.actions.connect).hasAttribute('disabled')).toBe(false);
  });

  test('while it runs, the button reads Testing…, says whom it contacts, Choose tools stays locked, and Connect tests first (rows 34i, 34j)', async () => {
    const { host } = await openPage();
    host.probe = GITHUB_PROBE;
    const probe = hold('POST', '/probe');
    await fillGitHub();

    await fireEvent.click(buttonLabelled(copy.probe.action));

    await waitFor(() =>
      expect(textOf('connect-contacting')).toBe(copy.probe.contacting('mcp.github.example')),
    );
    const testing = buttonLabelled(copy.probe.testing);
    expect(testing.getAttribute('aria-busy')).toBe('true');
    expect(present('connect-choose-locked')).toBe(true);
    expect(textOf('connect-summary')).toBe(copy.testsFirst);
    const connect = buttonLabelled(copy.actions.connect);
    expect(connect.hasAttribute('disabled')).toBe(false);

    // Connect pressed while the test runs connects once the test passes.
    await fireEvent.click(connect);
    probe.release(Response.json(GITHUB_PROBE));

    await waitFor(() => expect(present('connect-success')).toBe(true));
    // One test, held above and never repeated, then the connect.
    expect(probe.signals).toHaveLength(1);
    expect(requestsTo(host, 'PUT')).toHaveLength(1);
  });

  test('a test that fails says nothing is saved and keeps what was typed (row 34n)', async () => {
    const { host } = await openPage();
    host.probe = { outcome: 'failed', message: 'The source did not answer in time.' };
    await fillGitHub();

    await fireEvent.click(buttonLabelled(copy.probe.action));

    await waitFor(() => expect(textOf('connect-test-kept')).toBe(copy.probe.kept));
    expect(field('connect-url').value).toBe(ADDRESS);
    expect(field('connect-name').value).toBe('GitHub');
    expect(present('connect-choose-locked')).toBe(true);
  });

  test('a server that offers no tools: Connected, Found 0 tools, a dashed note, and Connect stays enabled (rows 34w, 34x)', async () => {
    const { host } = await openPage();
    host.probe = { outcome: 'listed', tools: [], skipped: [] };
    await fillGitHub();

    await fireEvent.click(buttonLabelled(copy.probe.action));

    await waitFor(() => expect(textOf('connect-listed')).toBe(copy.probe.found(0)));
    expect(textOf('connect-found')).toContain(copy.probe.connected);
    expect(textOf('connect-choose-none')).toBe(copy.chooseTools.none);
    expect(document.body.querySelector('[data-testid="connect-choose-table"]')).toBeNull();
    expect(textOf('connect-summary')).toBe(copy.joins(0, 'GitHub'));
    expect(buttonLabelled(copy.actions.connect).hasAttribute('disabled')).toBe(false);
  });

  test('an address already connected is named under Server URL, and Connect moves focus there (row 34e)', async () => {
    const { host, findByText } = await openPage({
      sources: [source('github', { name: 'GitHub', address: ADDRESS })],
    });
    await type('connect-url', `${ADDRESS}?session=1`);
    await type('connect-name', 'Work');

    await findByText(copy.duplicate('GitHub'));
    expect(textOf('connect-summary')).toBe(copy.testsFirst);
    const connect = buttonLabelled(copy.actions.connect);
    expect(connect.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(connect);

    expect(document.activeElement?.id).toBe('connect-url');
    expect(host.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
});

describe('choosing tools and connecting', () => {
  test('lists the tools under the legend, counts what is on, and connects with the choice (rows 33i, 34c, 34f, 34g, 34h)', async () => {
    const { host, findByTestId } = await openPage();
    await testGitHub(host);

    expect(textOf('connect-choose-intro')).toBe(
      `${copy.chooseTools.intro} ${copy.chooseTools.hints}`,
    );
    const legend = [...document.body.querySelectorAll('[data-testid="connect-legend"] li')];
    expect(legend.map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Never',
      'On changes',
      'Always',
      'Blocked',
    ]);
    expect(rowOf('list_issues')?.textContent).toContain('List issues');
    expect(rowOf('delete_branch')?.textContent).toContain('Dangerous');
    // An MCP server's tools all start on; a dangerous one asks Always.
    expect(field('connect-tool-delete_branch-on').checked).toBe(true);
    expect(textOf('connect-summary')).toBe(copy.joins(3, 'GitHub'));

    await fireEvent.click(field('connect-tool-delete_branch-on'));

    expect(textOf('connect-summary')).toBe(copy.joins(2, 'GitHub'));
    await fireEvent.click(buttonLabelled(copy.actions.connectCount(2)));

    const success = await findByTestId('connect-success');
    expect(requestsTo(host, 'PUT')[0]?.body).toMatchObject({
      name: 'GitHub',
      tools: { delete_branch: { enabled: false } },
    });
    expect(success.textContent).toContain(copy.success.title('GitHub'));
    expect(success.textContent).toContain(
      '2 tools are available now; Delete branch is off. No restart needed.',
    );
    const chosen = [...success.querySelectorAll('[data-connected-tool]')].map((row) =>
      row.textContent?.replaceAll(/\s+/g, ' ').trim(),
    );
    expect(chosen).toEqual([
      `List issues ${AGENT_PAGE_COPY.access.approvals.never}`,
      `Create issue ${AGENT_PAGE_COPY.access.approvals['on-changes']}`,
      `Delete branch ${copy.success.off}`,
    ]);
    expect(buttonLabelled(copy.success.give, success)).not.toBeNull();
    expect(buttonLabelled(copy.success.view, success)).not.toBeNull();
  });

  test('a connect that fails after a passing test keeps every choice and offers Try again (rows 34b, 34c)', async () => {
    const { host } = await openPage();
    await testGitHub(host);
    await fireEvent.click(field('connect-tool-delete_branch-on'));
    host.refuseNext = Response.json({ error: 'failed' }, { status: 500 });

    await fireEvent.click(buttonLabelled(copy.actions.connectCount(2)));

    await waitFor(() => expect(present('connect-failed')).toBe(true));
    expect(textOf('connect-failed')).toContain(
      `${copy.connectFailed.lead} ${copy.connectFailed.stopped} ${copy.connectFailed.kept}`,
    );
    expect(field('connect-tool-list_issues-on').checked).toBe(true);
    expect(field('connect-tool-create_issue-on').checked).toBe(true);
    expect(field('connect-tool-delete_branch-on').checked).toBe(false);
    expect(textOf('connect-summary')).toBe(copy.joins(2, 'GitHub'));
    expect(buttonLabelled(copy.actions.connectCount(2))).not.toBeNull();
    expect(host.sources).toEqual([]);

    const failed = document.body.querySelector<HTMLElement>('[data-testid="connect-failed"]')!;
    await fireEvent.click(buttonLabelled(copy.connectFailed.retry, failed));

    await waitFor(() => expect(present('connect-success')).toBe(true));
    expect(requestsTo(host, 'PUT')).toHaveLength(2);
    expect(requestsTo(host, 'PUT')[1]?.body).toMatchObject({
      tools: { delete_branch: { enabled: false } },
    });
  });

  test('Cancel stays live while Connect runs, says when it is slow, stops it and keeps the form (rows 34a, 34z)', async () => {
    connectTiming.slowAfterMilliseconds = 0;
    const { host } = await openPage();
    await testGitHub(host);
    const saving = hold('PUT', '/host/tool-sources/github');

    await fireEvent.click(buttonLabelled(copy.actions.connectCount(3)));

    await waitFor(() =>
      expect(textOf('connect-summary')).toContain(`${copy.connecting('GitHub')} ${copy.slow}`),
    );
    expect(buttonLabelled(copy.actions.connecting).getAttribute('aria-busy')).toBe('true');
    const cancel = buttonLabelled(copy.actions.cancel);
    expect(cancel.hasAttribute('disabled')).toBe(false);

    await fireEvent.click(cancel);

    expect(saving.signals[0]?.aborted).toBe(true);
    expect(router.pathname).toBe('/capabilities/connect');
    expect(textOf('connect-summary')).toBe(copy.joins(3, 'GitHub'));
    expect(field('connect-url').value).toBe(ADDRESS);
    expect(present('connect-success')).toBe(false);
    saving.release(Response.json({ id: 'github', changed: true, restartRequired: false }));
  });
});

describe('after connecting', () => {
  test('Give to an agent lists the agents that can take new tools, and opens the chosen one’s Access tab (rows 35c, 35d)', async () => {
    const { host, findByRole } = await openPage();
    await testGitHub(host);
    await fireEvent.click(buttonLabelled(copy.actions.connectCount(3)));
    await waitFor(() => expect(present('connect-success')).toBe(true));

    await fireEvent.click(buttonLabelled(copy.success.give));

    const picker = await findByRole('dialog', { name: copy.give.title('GitHub') });
    await waitFor(() =>
      expect(picker.querySelectorAll('[data-give-agent]').length).toBeGreaterThan(0),
    );
    const rows = [...picker.querySelectorAll<HTMLElement>('[data-give-agent]')];
    expect(rows.map((row) => row.dataset['giveAgent'])).toEqual([
      'tool-runner',
      'workflow-author',
      'model-switcher',
    ]);
    expect(rows[0]?.textContent).toContain('Tool runner');
    expect(rows[0]?.querySelector('code')?.textContent).toBe('tool-runner');
    expect(rows[0]?.textContent).toContain(copy.give.opens);

    await fireEvent.click(rows[0]!);

    await waitFor(() => expect(router.pathname).toBe('/agents/tool-runner/access'));
  });
});

describe('leaving', () => {
  test('an untouched form leaves without asking (row 35b)', async () => {
    const { queryByRole } = await openPage();

    await fireEvent.click(buttonLabelled(copy.actions.cancel));

    await waitFor(() => expect(router.pathname).toBe('/capabilities'));
    expect(queryByRole('dialog', { name: copy.leave.title }) === null).toBe(true);
  });

  test('a filled form asks first, and Keep editing stays with everything typed', async () => {
    const { findByRole } = await openPage();
    await fillGitHub();

    router.navigate('/chats');

    const dialog = await findByRole('dialog', { name: copy.leave.title });
    expect(router.pathname).toBe('/capabilities/connect');
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.leave.keep }));
    expect(router.pathname).toBe('/capabilities/connect');
    expect(field('connect-url').value).toBe(ADDRESS);
  });

  test('while the server does not answer, the fields stay editable, Test and Connect say why they are off, and leaving still asks (row 35f)', async () => {
    const monitor = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      browserOffline: false,
    });
    monitors.push(monitor);
    monitor.reportUnreachable();
    const { host, findByRole } = await openPage({ sources: [] }, monitor);

    await fillGitHub();

    expect(field('connect-url').disabled).toBe(false);
    expect(field('connect-name').value).toBe('GitHub');
    expect(textOf('connect-test-offline')).toBe(copy.probe.offline);
    expect(textOf('connect-summary')).toBe(copy.offline);
    await fireEvent.click(buttonLabelled(copy.actions.connect));
    await fireEvent.click(buttonLabelled(copy.probe.action));
    expect(host.requests.filter((request) => request.method !== 'GET')).toEqual([]);

    await fireEvent.click(buttonLabelled(copy.actions.cancel));
    await findByRole('dialog', { name: copy.leave.title });
    expect(router.pathname).toBe('/capabilities/connect');
  });
});

describe('an OpenAPI spec', () => {
  /** The Payments API: three reads, two changes and one dangerous operation. */
  const PAYMENTS: OpenApiInspection = {
    outcome: 'valid',
    fileName: 'payments-openapi.yaml',
    version: '3.1',
    title: 'Payments API',
    baseUrl: 'https://payments.example.com/v1',
    operationCount: 6,
    operations: [
      ['listRefunds', 'GET', '/refunds', 'List refunds', 'read-only'],
      ['getRefund', 'GET', '/refunds/{id}', 'Get a refund', 'read-only'],
      ['listInvoices', 'GET', '/invoices', 'List invoices', 'read-only'],
      ['createRefund', 'POST', '/refunds', 'Create a refund', 'mutating'],
      ['updateInvoice', 'PATCH', '/invoices/{id}', 'Update an invoice', 'mutating'],
      ['deleteInvoice', 'DELETE', '/invoices/{id}', 'Delete an invoice', 'dangerous'],
    ].map(([operationId, method, path, title, tier]) => ({
      operationId: operationId!,
      method: method!,
      path: path!,
      title: title!,
      description: null,
      tier: tier as 'read-only' | 'mutating' | 'dangerous',
    })),
    testOperation: {
      operationId: 'listRefunds',
      title: 'List refunds',
      method: 'GET',
      path: '/refunds',
    },
    document: { openapi: '3.1.0', info: { title: 'Payments API', version: '1' }, paths: {} },
  };

  /** Chooses the OpenAPI file `name` for the page to read. */
  async function upload(name: string): Promise<void> {
    await choose('connect-kind-openapi');
    await choose('connect-specification-file');
    Object.defineProperty(field('connect-file'), 'files', {
      value: [new File(['openapi: 3.1.0'], name, { type: 'application/yaml' })],
      configurable: true,
    });
    await fireEvent.change(field('connect-file'));
  }

  test('fills in Name and the Base URL from the spec, starts on an API key, and says what the test calls (rows 33t, 33u, 33v, 34r)', async () => {
    const { host, container } = await openPage();
    host.inspection = PAYMENTS;

    await upload('payments-openapi.yaml');

    await waitFor(() => expect(field('connect-name').value).toBe('Payments API'));
    expect(container.textContent).toContain(copy.name.fromSpec);
    expect(field('connect-base-url').value).toBe('https://payments.example.com/v1');
    expect(field('connect-base-url').required).toBe(true);
    expect(container.textContent).toContain(copy.baseUrl.description);
    const headings = [...container.querySelectorAll('[data-testid="connect-form"] h2')].map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toContain(copy.sections.baseUrlAndSignIn);
    expect(field('connect-authentication-api-key').checked).toBe(true);
    expect(field('connect-secret').type).toBe('password');
    expect(textOf('connect-test-calls')).toBe(copy.probe.calls('List refunds', 'GET', '/refunds'));
    const summary = [...container.querySelectorAll('[data-testid="connect-spec-summary"] li')].map(
      (part) => part.textContent,
    );
    expect(summary).toEqual(['payments-openapi.yaml', 'OpenAPI 3.1', '6 operations']);
  });

  test('lists its operations: reads on and changes off, with a filter, a risk filter, a count, Select all and a scrolling list (rows 33w, 33y)', async () => {
    const { host, container } = await openPage();
    host.inspection = PAYMENTS;
    await upload('payments-openapi.yaml');
    await waitFor(() =>
      expect(textOf('connect-operations-found')).toBe(copy.chooseTools.operations.found(6)),
    );

    expect(textOf('connect-operations-selected')).toBe(copy.chooseTools.operations.selected(3, 6));
    expect(container.textContent).toContain(copy.chooseTools.operations.selectAll(6));
    // Each operation is the tool its operationId names at the source: `deleteInvoice` is `delete-invoice`.
    expect(field('connect-tool-delete-invoice-on').checked).toBe(false);
    expect(textOf('connect-operations-showing')).toBe(copy.chooseTools.operations.showing(4, 6));
    expect(textOf('connect-summary')).toBe(copy.joins(3, 'Payments API'));
    expect(buttonLabelled(copy.actions.connectCount(3))).not.toBeNull();

    // The one search field on the page: Filter operations.
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(filter.getAttribute('aria-label')).toBe(copy.chooseTools.operations.filterLabel);
    await fireEvent.input(filter, { target: { value: 'invoice' } });
    await waitFor(() => expect(container.querySelectorAll('[data-probe-tool]').length).toBe(3));
    expect(present('connect-operations-showing')).toBe(false);
    await fireEvent.input(filter, { target: { value: '' } });

    await fireEvent.click(
      field('connect-operations-risk').querySelector<HTMLElement>(
        '[data-cinder-segment-value="dangerous"]',
      )!,
    );
    await waitFor(() => expect(container.querySelectorAll('[data-probe-tool]').length).toBe(1));
    expect(
      container.querySelector('[data-probe-tool="payments-api__delete-invoice"]'),
    ).not.toBeNull();

    await fireEvent.click(field('connect-operations-all'));
    expect(textOf('connect-operations-selected')).toBe(copy.chooseTools.operations.selected(6, 6));
  });

  test('a spec whose operations have no operationId names the problem under a danger ring, and one that is not a spec says where (rows 34u, 34v)', async () => {
    const { host, container } = await openPage();
    host.inspection = {
      outcome: 'no-operation-ids',
      fileName: 'payments-openapi.yaml',
      version: '3.1',
      operationCount: 24,
      message:
        'None of the 24 operations has an operationId, and each tool needs one. Add operationIds to the spec, then upload it again.',
    };

    await upload('payments-openapi.yaml');

    await waitFor(() =>
      expect(textOf('connect-file-error')).toBe(
        'None of the 24 operations has an operationId, and each tool needs one. Add operationIds to the spec, then upload it again.',
      ),
    );
    expect(
      [...container.querySelectorAll('[data-testid="connect-spec-summary"] li')].map(
        (part) => part.textContent,
      ),
    ).toEqual(['payments-openapi.yaml', 'OpenAPI 3.1', '24 operations']);
    expect(container.querySelector('.ib-connect__file[data-invalid]')).not.toBeNull();
    expect(field('connect-file').getAttribute('aria-invalid')).toBe('true');
    expect(present('connect-choose-locked')).toBe(true);

    host.inspection = {
      outcome: 'invalid',
      fileName: 'payments-openapi.yaml',
      line: 14,
      problem: '“paths” must be an object.',
      message: 'This isn’t a valid OpenAPI 3 file. Line 14: “paths” must be an object.',
    };
    await upload('payments-openapi.yaml');

    await waitFor(() =>
      expect(textOf('connect-file-error')).toBe(
        'This isn’t a valid OpenAPI 3 file. Line 14: “paths” must be an object.',
      ),
    );
    expect(present('connect-spec-summary')).toBe(false);
  });

  test('says it is fetching a spec from its address, with a Cancel that stops it (row 34s)', async () => {
    const { host, findByTestId } = await openPage();
    const reading = hold('POST', '/host/openapi-inspection');
    await choose('connect-kind-openapi');
    await type('connect-specification-address', 'https://api.example.com/openapi.json');

    await fireEvent.change(field('connect-specification-address'));

    const fetching = await findByTestId('connect-spec-fetching');
    expect(fetching.textContent).toContain(copy.spec.fetching);
    await fireEvent.click(buttonLabelled(copy.spec.cancel, fetching));

    await waitFor(() => expect(present('connect-spec-fetching')).toBe(false));
    expect(reading.signals[0]?.aborted).toBe(true);
    expect(requestsTo(host, 'PUT')).toEqual([]);
    reading.release(Response.json(PAYMENTS));
  });
});
