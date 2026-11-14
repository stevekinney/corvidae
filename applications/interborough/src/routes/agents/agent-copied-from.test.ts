/**
 * The line on a copy whose source has changed (COR-2234): the Bureau records where a copy came from
 * (`definition.from`) and states the version that source is at now (`fromNow`); the page compares
 * the two and says so in one plain line of the header, on every tab, with a link to the source.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
import { readyAgent } from '../../lib/bureau-stub.test-support.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';
import { copiedFromNotice } from './agent-presentation.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: AgentDetail } } as never);

const COPY = {
  ...AGENT,
  name: 'triager',
  displayName: 'Triager copy',
  kind: 'file',
  description: 'Triages issues.',
};
const SOURCE = { ...AGENT, name: 'linear:triager', displayName: 'Triager', kind: 'code' };
const FINGERPRINT = 'a'.repeat(64);

type Detail = Parameters<typeof copiedFromNotice>[0];

/** The copy's detail as the Bureau answers it, with `from` as written and the source's version now. */
function copyDetail(
  from: { agent: string; version: string } | null,
  fromNow: string | null,
  overrides: Partial<ReturnType<typeof readyAgent>> = {},
) {
  const base = readyAgent({ id: 'triager', name: 'Triager copy' });
  if (base.definition === null) throw new Error('expected a definition');
  return { ...base, definition: { ...base.definition, from }, fromNow, ...overrides };
}

function serve(detail: unknown, agents: readonly unknown[] = [COPY, SOURCE]) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents }),
    'bureau.agents.definitions.get': () => detail,
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: 'triager' }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    'bureau.agents.versions.list': () => ({ versions: [] }),
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
  });
  restore = served.restore;
  return served;
}

const header = AGENT_PAGE_COPY.header.copiedFrom;
const FROM = { agent: 'linear:triager', version: '1.0.0' };

describe('the copied-from line on a copy’s page', () => {
  test('says the source changed, with its versions as written, and links to its page', async () => {
    landAt('/agents/triager');
    serve(copyDetail(FROM, '1.1.0'));
    const { findByTestId } = mount();

    const line = await findByTestId('agent-copied-from');
    expect(line.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      `${header.lead} Triager${header.changedFrom('1.0.0', '1.1.0')}`,
    );
    const link = line.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/agents/linear%3Atriager');
    expect(link?.textContent).toBe('Triager');
    // The source's version is never worded as a saved version of the copy.
    expect(line.textContent).not.toMatch(/Version \d/u);
    expect(line.textContent).not.toContain(String.fromCodePoint(0xb7));
  });

  test('is one plain line in the header summary, styled as the needs-provider line, not a box', async () => {
    landAt('/agents/triager');
    serve(copyDetail(FROM, '1.1.0'));
    const { container, findByTestId } = mount();

    const line = await findByTestId('agent-copied-from');
    expect(line.tagName).toBe('P');
    expect(line.className).toBe('ib-agent__reason');
    expect(line.closest('.ib-agent__summary')).not.toBeNull();
    expect(
      container.querySelector('.cinder-banner, .cinder-alert, .cinder-callout, .cinder-card'),
    ).toBeNull();
    expect(line.querySelector('button, svg')).toBeNull();
  });

  test('stays on every tab, once', async () => {
    for (const path of [
      '/agents/triager',
      '/agents/triager/instructions',
      '/agents/triager/access',
      '/agents/triager/settings',
    ]) {
      landAt(path);
      serve(copyDetail(FROM, '1.1.0'));
      const { container, findByTestId } = mount();
      await findByTestId('agent-copied-from');
      expect(container.querySelectorAll('[data-testid="agent-copied-from"]')).toHaveLength(1);
      cleanup();
      restore?.();
    }
  });

  test('names the source by its identifier when the agent list does not hold it', async () => {
    landAt('/agents/triager');
    serve(copyDetail(FROM, '1.1.0'), [COPY]);
    const { findByTestId } = mount();

    const line = await findByTestId('agent-copied-from');
    expect(line.querySelector('a')?.textContent).toBe('linear:triager');
  });

  test('says only that the source changed when a version is a file’s fingerprint', async () => {
    landAt('/agents/triager');
    serve(copyDetail({ agent: 'linear:triager', version: FINGERPRINT }, 'b'.repeat(64)));
    const { findByTestId } = mount();

    const line = await findByTestId('agent-copied-from');
    expect(line.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
      `${header.lead} Triager${header.changed}`,
    );
    expect(line.textContent).not.toContain(FINGERPRINT);
  });

  test.each([
    ['there is no from', copyDetail(null, '1.1.0')],
    ['the versions match', copyDetail(FROM, '1.0.0')],
    ['the source is not loaded', copyDetail(FROM, null)],
    ['the file is invalid', copyDetail(FROM, '1.1.0', { definition: null, state: 'invalid' })],
  ])('shows nothing when %s', async (_name, detail) => {
    landAt('/agents/triager');
    serve(detail);
    const { container, findByTestId } = mount();

    await findByTestId('agent-header');
    // The agent has loaded when its facts are on the page; the line would be with them.
    await findByTestId('agent-status');
    expect(container.querySelector('[data-testid="agent-copied-from"]')).toBeNull();
    expect(container.textContent).not.toMatch(/undefined|null/u);
  });
});

describe('copiedFromNotice', () => {
  const detail = (from: typeof FROM | null, fromNow: string | null): Detail => ({
    definition: copyDetail(from, fromNow).definition,
    fromNow,
  });

  test('compares what the Bureau says and derives nothing else', () => {
    expect(copiedFromNotice(detail(FROM, '1.1.0'), [])).toEqual({
      agent: 'linear:triager',
      name: 'linear:triager',
      versions: { copied: '1.0.0', now: '1.1.0' },
    });
    expect(copiedFromNotice(detail(FROM, '1.0.0'), [])).toBeUndefined();
    expect(copiedFromNotice(detail(null, '1.1.0'), [])).toBeUndefined();
    expect(copiedFromNotice(detail(FROM, null), [])).toBeUndefined();
    expect(copiedFromNotice(undefined, [])).toBeUndefined();
    expect(copiedFromNotice({ definition: null, fromNow: '1.1.0' }, [])).toBeUndefined();
  });

  test('names the source by its identifier when its display name is the copy’s own', () => {
    const listed = [{ name: 'linear:triager', displayName: 'Triager' }];
    expect(copiedFromNotice(detail(FROM, '1.1.0'), listed, 'Triager')?.name).toBe('linear:triager');
    expect(copiedFromNotice(detail(FROM, '1.1.0'), listed, 'Triager copy')?.name).toBe('Triager');
    expect(copiedFromNotice(detail(FROM, '1.1.0'), listed)?.name).toBe('Triager');
  });
});
