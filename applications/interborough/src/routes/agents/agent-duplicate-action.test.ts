/**
 * Duplicate on an agent's page. A built-in agent, which cannot be edited, offers it as a link to
 * the form for a new agent filled from it (`/agents/new?from=`), which writes nothing; a plugin's
 * agent keeps its own Duplicate, which writes the copy (`plugin-agent-page.test.ts`). An agent file
 * the owner keeps has Edit and New chat in its header and no Duplicate (board PageAgent, row 38c).
 *
 * COR-2232: the Bureau states what a copy of a plugin's code agent loses on the source's definition
 * before any write, so pressing Duplicate reads it. A list with something in it opens Cinder's
 * confirm dialog and nothing is written until the confirm press; an empty list writes at once; a
 * read that fails writes nothing.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY, droppedBehaviorWords } from '../../app/copy/agents.ts';
import { readyAgent, StubFault } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: AgentDetail } } as never);

function serve(summary: typeof AGENT) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [summary] }),
    'bureau.agents.definitions.get': () => readyAgent({ id: summary.name }),
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: summary.name }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
  });
  restore = served.restore;
  return served;
}

describe('Duplicate on an agent’s page', () => {
  test('is offered on a built-in agent, which has no Edit, and opens the form to copy it', async () => {
    landAt('/agents/assistant');
    const served = serve(AGENT);
    const { findByRole, queryByRole } = mount();

    const duplicate = await findByRole('link', { name: AGENT_PAGE_COPY.duplicate });
    expect(duplicate.getAttribute('href')).toBe('/agents/new?from=assistant');
    expect(queryByRole('link', { name: AGENT_EDITOR_COPY.editAction })).toBeNull();

    await fireEvent.click(duplicate);
    await waitFor(() => expect(router.pathname).toBe('/agents/new'));
    expect(router.search.get('from')).toBe('assistant');
    // Following it writes nothing: the copy is created from the form.
    expect(served.calls.some((call) => call.method.includes('duplicate'))).toBe(false);
    expect(served.calls.some((call) => call.method.includes('create'))).toBe(false);
  });

  test('is not in the header of a file agent, which holds Edit and New chat', async () => {
    landAt('/agents/researcher');
    serve({ ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' });
    const { findByRole, queryByRole } = mount();

    await findByRole('link', { name: AGENT_EDITOR_COPY.editAction });
    await findByRole('link', { name: 'New chat' });
    expect(queryByRole('link', { name: AGENT_PAGE_COPY.duplicate })).toBeNull();
  });
});

const CODE_AGENT = {
  ...AGENT,
  name: 'demo:release-helper',
  displayName: 'Release helper',
  kind: 'code',
  description: 'Drafts release notes.',
};
const copy = AGENT_PAGE_COPY.plugin;

type Answers = Parameters<typeof bureau>[0];

/** A plugin's code agent whose definition states `dropped` before any write. */
function serveCodeAgent(dropped: readonly string[], extra: Answers = {}) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [CODE_AGENT] }),
    'bureau.agents.definitions.get': () => ({
      ...readyAgent({ id: 'demo:release-helper', name: 'Release helper' }),
      dropped,
    }),
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: 'demo:release-helper' }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    'bureau.agents.versions.list': () => ({ versions: [] }),
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

const duplicateCalls = (served: {
  calls: readonly { method: string; params: Record<string, unknown> }[];
}) => served.calls.filter((call) => call.method === 'bureau.agents.definitions.duplicate');

describe('Duplicate on an agent that loses something', () => {
  test('opens the question with each dropped item as a list row, and writes nothing yet', async () => {
    landAt('/agents/demo%3Arelease-helper');
    const served = serveCodeAgent(['generate', 'guardrails']);
    const { findByRole, findByTestId } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    const dialog = await findByRole('dialog', { name: copy.confirm.title('Release helper') });
    expect(dialog.textContent).toContain(copy.confirm.description);
    const list = await findByTestId('agent-duplicate-dropped');
    const rows = [...list.querySelectorAll('li')];
    expect(rows.map((row) => row.getAttribute('data-dropped'))).toEqual(['generate', 'guardrails']);
    for (const row of rows) {
      const words = droppedBehaviorWords(row.getAttribute('data-dropped') ?? '');
      expect(row.querySelector('strong')?.textContent).toBe(words.name);
      expect(row.textContent?.trim()).toBe(`${words.name} ${words.effect}`);
    }
    // No dot between a name and its sentence, and nothing boxed around the list.
    expect(dialog.textContent).not.toContain(String.fromCodePoint(0xb7));
    expect(list.closest('[role="alert"], .cinder-alert, .cinder-callout, .cinder-card')).toBeNull();
    // The list is on screen and the write has not been made.
    expect(duplicateCalls(served)).toHaveLength(0);
  });

  test('says each of the five wire names in a person’s words, and an unknown name as itself', async () => {
    landAt('/agents/demo%3Arelease-helper');
    serveCodeAgent([
      'generate',
      'stopWhen',
      'approvals',
      'outputSchema',
      'guardrails',
      'somethingNew',
    ]);
    const { findByRole, findByTestId } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    const list = await findByTestId('agent-duplicate-dropped');
    const rows = [...list.querySelectorAll('li')];
    expect(rows).toHaveLength(6);
    for (const wire of ['generate', 'stopWhen', 'approvals', 'outputSchema', 'guardrails']) {
      const row = rows.find((entry) => entry.getAttribute('data-dropped') === wire);
      expect(row?.querySelector('strong')?.textContent).not.toBe(wire);
      expect(row?.querySelector('strong')?.textContent).toBe(droppedBehaviorWords(wire).name);
    }
    expect(rows.at(-1)?.textContent?.trim()).toBe('somethingNew');
  });

  test('confirms with Duplicate, which is not the danger variant, and opens the copy', async () => {
    landAt('/agents/demo%3Arelease-helper');
    const served = serveCodeAgent(['generate'], {
      'bureau.agents.definitions.duplicate': () => ({
        id: 'release-helper',
        hash: 'hash-2',
        dropped: ['generate'],
      }),
    });
    const { findByRole, queryByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));
    const dialog = await findByRole('dialog');
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === copy.duplicate,
    );
    if (confirm === undefined) throw new Error('expected the Duplicate button');
    expect(confirm.className).not.toContain('danger');
    expect(duplicateCalls(served)).toHaveLength(0);

    await fireEvent.click(confirm);

    await waitFor(() => expect(router.pathname).toBe('/agents/release-helper'));
    expect(duplicateCalls(served).map((call) => call.params)).toEqual([
      { id: 'demo:release-helper' },
    ]);
    await waitFor(() => expect(queryByRole('dialog')?.outerHTML ?? null).toBeNull());
  });

  test('Cancel writes nothing and closes the question', async () => {
    landAt('/agents/demo%3Arelease-helper');
    const served = serveCodeAgent(['generate']);
    const { findByRole, queryByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));
    await fireEvent.click(await findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    expect(duplicateCalls(served)).toHaveLength(0);
    expect(router.pathname).toBe('/agents/demo%3Arelease-helper');
  });

  test('Escape writes nothing and closes the question', async () => {
    landAt('/agents/demo%3Arelease-helper');
    const served = serveCodeAgent(['generate']);
    const { findByRole, queryByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));
    const dialog = await findByRole('dialog');
    await fireEvent(dialog, new window.Event('cancel', { cancelable: true }));

    await waitFor(() => expect(queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    expect(duplicateCalls(served)).toHaveLength(0);
  });

  test('shows a failure in the dialog, leaves Duplicate armed, and retries to success', async () => {
    landAt('/agents/demo%3Arelease-helper');
    let attempts = 0;
    const served = serveCodeAgent(['generate'], {
      'bureau.agents.definitions.duplicate': () => {
        attempts += 1;
        if (attempts === 1)
          throw new StubFault('Conflict', 409, 'exists', { reason: 'agent-file-exists' });
        return { id: 'release-helper', hash: 'hash-2', dropped: ['generate'] };
      },
    });
    const { findByRole, findByText, queryByText } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));
    const dialog = await findByRole('dialog');
    const confirm = () => {
      const found = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === copy.duplicate,
      );
      if (found === undefined) throw new Error('expected the Duplicate button');
      return found;
    };
    await fireEvent.click(confirm());

    const fault = await findByText(copy.exists('release-helper'));
    expect(dialog.contains(fault)).toBe(true);
    expect(dialog.textContent).toContain(copy.confirm.errorTitle);
    expect(router.pathname).toBe('/agents/demo%3Arelease-helper');
    expect(confirm().disabled).toBe(false);
    expect(confirm().getAttribute('aria-disabled')).not.toBe('true');

    await fireEvent.click(confirm());
    await waitFor(() => expect(router.pathname).toBe('/agents/release-helper'));
    expect(duplicateCalls(served)).toHaveLength(2);
    expect(queryByText(copy.exists('release-helper'))).toBeNull();
  });

  test('keeps the dialog busy while the copy is written', async () => {
    landAt('/agents/demo%3Arelease-helper');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveCodeAgent(['generate'], {
      'bureau.agents.definitions.duplicate': () => ({
        id: 'release-helper',
        hash: 'hash-2',
        dropped: ['generate'],
      }),
    });
    // The stub answers at once, so the write is held at the wire until the test lets it through.
    const answered = globalThis.fetch;
    const releaseFetch = installFetchImplementation(async (input, init) => {
      if (typeof init?.body === 'string' && init.body.includes('definitions.duplicate')) {
        await gate;
      }
      return answered(input, init);
    });
    const unrestored = restore;
    restore = () => {
      releaseFetch();
      unrestored?.();
    };
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));
    const dialog = await findByRole('dialog');
    const confirm = [...dialog.querySelectorAll('button')].find((button) =>
      button.textContent.includes(copy.duplicate),
    );
    if (confirm === undefined) throw new Error('expected the Duplicate button');
    await fireEvent.click(confirm);

    await waitFor(() => expect(dialog.textContent).toContain(copy.confirm.busy));
    expect(router.pathname).toBe('/agents/demo%3Arelease-helper');
    release?.();
    await waitFor(() => expect(router.pathname).toBe('/agents/release-helper'));
  });
});

describe('Duplicate on an agent that loses nothing, or that cannot be read', () => {
  test('writes at once when nothing is dropped, with no question', async () => {
    landAt('/agents/demo%3Arelease-helper');
    const served = serveCodeAgent([], {
      'bureau.agents.definitions.duplicate': () => ({
        id: 'release-helper',
        hash: 'hash-2',
        dropped: [],
      }),
    });
    const { findByRole, queryByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    await waitFor(() => expect(router.pathname).toBe('/agents/release-helper'));
    expect(queryByRole('dialog')?.hasAttribute('open') ?? false).toBe(false);
    expect(duplicateCalls(served)).toHaveLength(1);
  });

  test('writes nothing and shows the page fault when the source cannot be read', async () => {
    landAt('/agents/demo%3Arelease-helper/instructions');
    let gone = false;
    const served = serveCodeAgent(['generate'], {
      'bureau.agents.definitions.get': () => {
        // The page's own read answers; the read Duplicate makes on demand does not.
        if (gone) throw new StubFault('NotFound', 404, 'gone');
        return { ...readyAgent({ id: 'demo:release-helper' }), dropped: ['generate'] };
      },
    });
    const { findByRole, findByText, findByTestId } = mount();

    await findByTestId('agent-instructions-body');
    gone = true;
    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    await findByText(copy.notLoaded);
    expect(duplicateCalls(served)).toHaveLength(0);
    expect(router.pathname).toBe('/agents/demo%3Arelease-helper/instructions');
  });
});
