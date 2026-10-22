/**
 * The model picker in a session's composer, over a stubbed Bureau: which models it lists and shows,
 * when it is hidden, and what each way a switch can end does to the selection and what it says.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { CHAT_COPY } from '../../app/copy.ts';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
import ModelPicker from './model-picker.svelte';
import QueryPage from './query-page.test-harness.svelte';

const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'claude-sonnet-5' };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5' };
const SONNET_4 = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  displayName: 'claude-sonnet-4-6',
};
const COPY = CHAT_COPY.modelPicker;

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

type Overrides = {
  readonly models?: readonly (typeof SONNET)[];
  readonly selectable?: boolean;
  readonly defaultModel?: { provider: string; model: string } | null;
  readonly steer?: (params: Record<string, unknown>) => unknown;
};

function serve({ models = [SONNET, HAIKU], defaultModel = SONNET, steer }: Overrides = {}) {
  stub = installBureauStub({
    'bureau.agents.models': () => ({ selectable: true, models, default: defaultModel }),
    'bureau.contexts.steer': steer ?? (() => ({ outcome: 'accepted', command: {} })),
  });
  return stub;
}

type Session = { current: { provider: string | null; model: string } | null; revision: number };

const HAIKU_NAME = { provider: 'anthropic', model: 'claude-haiku-4-5' };
const SONNET_NAME = { provider: 'anthropic', model: 'claude-sonnet-5' };

/**
 * The picker over a session, with a `reload` that records how often it was asked. When it is asked,
 * the session it reads is `afterReload`, as a Bureau that has taken the switch would answer it.
 */
function mount(
  props: {
    current?: Session['current'] | undefined;
    revision?: number | undefined;
    afterReload?: Session;
    reload?: () => Promise<boolean>;
  } = {},
) {
  const reloads: number[] = [];
  const client = createQueryClient();
  const pageProps = (session: {
    current?: Session['current'] | undefined;
    revision?: number | undefined;
  }) => ({
    page: ModelPicker,
    pageProps: {
      sessionId: 'session-1',
      agentName: 'model-switcher',
      current: session.current,
      revision: session.revision,
      reload,
    },
  });
  const reload =
    props.reload ??
    (async () => {
      reloads.push(reloads.length + 1);
      if (props.afterReload !== undefined)
        await view.rerender(pageProps(props.afterReload) as never);
      return true;
    });
  const view = render(QueryPage, {
    props: {
      ...pageProps({
        current: 'current' in props ? props.current : null,
        revision: 'revision' in props ? props.revision : 3,
      }),
      client,
    },
  } as never);
  return { ...view, reloads, client };
}

/**
 * Waits until the answer to `bureau.agents.models` has reached the page, and the page has drawn what
 * it made of it. Without this, a test of what the picker does not show passes before the list has
 * arrived, whatever the picker does with it.
 */
async function modelsAnswered(client: QueryClient): Promise<void> {
  await waitFor(() =>
    expect(client.getQueryData(queryKeys.agents.models('model-switcher')) === undefined).toBe(
      false,
    ),
  );
  await tick();
}

function picker(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector('select');
  if (select === null) throw new Error('The picker did not render.');
  return select;
}

/** The picker's value as a model name, which is the part of its value after the provider. */
const shownModel = (container: HTMLElement) => picker(container).value.split('\n')[1];

async function chooseModel(container: HTMLElement, model: string): Promise<void> {
  const option = [...picker(container).options].find((entry) => entry.value.endsWith(`\n${model}`));
  if (option === undefined) throw new Error(`The picker lists no ${model}.`);
  await fireEvent.change(picker(container), { target: { value: option.value } });
}

describe('which models the picker offers', () => {
  test('lists exactly the models the agent allows, with the agent’s default selected for a session never switched', async () => {
    serve();
    const { container } = mount({ current: null });

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect([...picker(container).options].map((option) => option.textContent)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(shownModel(container)).toBe('claude-sonnet-5');
  });

  test('shows the model the session was switched to, over the agent’s default', async () => {
    serve();
    const { container } = mount({ current: { provider: 'anthropic', model: 'claude-haiku-4-5' } });

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect(shownModel(container)).toBe('claude-haiku-4-5');
  });

  test('asks for the models of the session’s agent', async () => {
    const served = serve();
    mount();

    await waitFor(() => expect(served.callsTo('bureau.agents.models')).toHaveLength(1));
    expect(served.callsTo('bureau.agents.models')[0]?.params).toEqual({
      agentName: 'model-switcher',
    });
  });

  test('is hidden when the agent allows one model', async () => {
    serve({ models: [SONNET] });
    const { container, client } = mount();

    await modelsAnswered(client);

    expect(container.querySelector('select') === null).toBe(true);
  });

  test('is hidden when the agent allows none', async () => {
    serve({ models: [], defaultModel: null });
    const { container, client } = mount();

    await modelsAnswered(client);

    expect(container.querySelector('select') === null).toBe(true);
  });

  test('shows a session’s model that the agent no longer lists, so the picker never shows another', async () => {
    serve();
    const { container } = mount({ current: { provider: 'anthropic', model: 'claude-retired-1' } });

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect(shownModel(container)).toBe('claude-retired-1');
    expect(picker(container).selectedOptions[0]?.disabled).toBe(true);
  });

  test('matches a model the session was switched to without a provider by its name', async () => {
    serve();
    const { container } = mount({ current: { provider: null, model: 'claude-haiku-4-5' } });

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect(shownModel(container)).toBe('claude-haiku-4-5');
  });

  test('says the model is the agent’s default when the session has none and the agent names none', async () => {
    serve({ defaultModel: null });
    const { container } = mount({ current: null });

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect(picker(container).selectedOptions[0]?.textContent).toBe(COPY.agentDefault);
  });
});

describe('choosing a model', () => {
  test('switches the session with the revision it read, and shows the new model once it is admitted', async () => {
    const served = serve();
    const { container, reloads } = mount({
      revision: 7,
      afterReload: { current: HAIKU_NAME, revision: 8 },
    });
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

    await chooseModel(container, 'claude-haiku-4-5');

    await waitFor(() => expect(served.callsTo('bureau.contexts.steer')).toHaveLength(1));
    const params = served.callsTo('bureau.contexts.steer')[0]?.params;
    expect(params).toMatchObject({
      contextId: 'session-1',
      override: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      expectedRevision: 7,
    });
    expect(typeof params?.['commandId']).toBe('string');
    // The session is read again so the page agrees with the Bureau, and the choice stays.
    await waitFor(() => expect(reloads).toHaveLength(1));
    expect(shownModel(container)).toBe('claude-haiku-4-5');
    expect(container.textContent).not.toContain(COPY.fault);
  });

  test('shows the new model for an exact replay of the command, as for a new one', async () => {
    serve({ steer: () => ({ outcome: 'replayed', command: {} }) });
    const { container, reloads } = mount({ afterReload: { current: HAIKU_NAME, revision: 4 } });
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

    await chooseModel(container, 'claude-haiku-4-5');

    await waitFor(() => expect(reloads).toHaveLength(1));
    expect(shownModel(container)).toBe('claude-haiku-4-5');
  });

  test('keeps an admitted choice on screen when the session cannot be read again', async () => {
    serve();
    const { container } = mount({ reload: async () => false });
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

    await chooseModel(container, 'claude-haiku-4-5');

    await waitFor(() => expect(picker(container).disabled).toBe(false));
    expect(shownModel(container)).toBe('claude-haiku-4-5');
  });

  test('reads the session again and shows the model it has now when the switch was refused as stale', async () => {
    serve({
      models: [SONNET, HAIKU, SONNET_4],
      steer: () => ({
        outcome: 'rejected',
        failure: { failedAt: '2026-10-22T00:00:00.000Z', reason: 'stale-revision' },
      }),
    });
    // The session it reads again was switched to a third model elsewhere, and that is what shows.
    const { container, reloads, findByText } = mount({
      current: SONNET_NAME,
      revision: 1,
      afterReload: { current: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, revision: 2 },
    });
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect(shownModel(container)).toBe('claude-sonnet-5');

    await chooseModel(container, 'claude-haiku-4-5');

    expect(await findByText(COPY.staleRevision)).not.toBeNull();
    await waitFor(() => expect(shownModel(container)).toBe('claude-sonnet-4-6'));
    expect(reloads).toHaveLength(1);
  });

  const refusals: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      'model-not-allowed',
      { outcome: 'rejected', failure: { failedAt: 'now', reason: 'model-not-allowed' } },
      COPY.modelNotAllowed,
    ],
    [
      'a catalog that no longer holds the model',
      { outcome: 'rejected', failure: { failedAt: 'now', reason: 'policy-denied' } },
      COPY.modelNotAllowed,
    ],
    [
      'a session that has ended, refused as a rejection',
      { outcome: 'rejected', failure: { failedAt: 'now', reason: 'session-terminal' } },
      COPY.sessionTerminal,
    ],
    [
      'session-terminal',
      { outcome: 'session-terminal', sessionId: 'session-1' },
      COPY.sessionTerminal,
    ],
    [
      'unsupported-capability',
      { outcome: 'unsupported-capability', reason: 'The agent cannot be switched.' },
      COPY.unsupportedCapability,
    ],
    [
      'a Bureau that is shutting down',
      { outcome: 'rejected', failure: { failedAt: 'now', reason: 'shutting-down' } },
      COPY.notSwitched,
    ],
  ];

  for (const [name, outcome, copy] of refusals) {
    test(`restores the previous selection and says so in its own words for ${name}`, async () => {
      serve({ steer: () => outcome });
      const { container, reloads, findByText } = mount();
      await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

      await chooseModel(container, 'claude-haiku-4-5');

      expect(await findByText(copy)).not.toBeNull();
      await waitFor(() => expect(shownModel(container)).toBe('claude-sonnet-5'));
      // Only a stale revision reads the session again.
      expect(reloads).toHaveLength(0);
    });
  }

  test('reads the session again when the request fails, and shows the model it has then, which the switch may have reached', async () => {
    serve({
      steer: () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
      },
    });
    const { container, reloads, findByText } = mount({
      afterReload: { current: HAIKU_NAME, revision: 4 },
    });
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

    await chooseModel(container, 'claude-haiku-4-5');

    expect(await findByText(COPY.fault)).not.toBeNull();
    expect(COPY.fault).not.toContain('keeps');
    await waitFor(() => expect(reloads).toHaveLength(1));
    // The Bureau had taken the switch before the answer was lost, and the picker shows it.
    await waitFor(() => expect(picker(container).disabled).toBe(false));
    expect(shownModel(container)).toBe('claude-haiku-4-5');
  });

  test('shows the previous model after a failed request when the session still has it', async () => {
    serve({
      steer: () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
      },
    });
    const { container, reloads, findByText } = mount({
      afterReload: { current: SONNET_NAME, revision: 3 },
    });
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

    await chooseModel(container, 'claude-haiku-4-5');

    expect(await findByText(COPY.fault)).not.toBeNull();
    await waitFor(() => expect(reloads).toHaveLength(1));
    await waitFor(() => expect(shownModel(container)).toBe('claude-sonnet-5'));
  });

  test('retries a command that failed under the same identifier, so the Bureau never applies it twice', async () => {
    let calls = 0;
    const served = serve({
      steer: () => {
        calls += 1;
        if (calls === 1) throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
        return { outcome: 'replayed', command: {} };
      },
    });
    const { container, findByText } = mount();
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));

    await chooseModel(container, 'claude-haiku-4-5');
    await findByText(COPY.fault);
    await waitFor(() => expect(picker(container).disabled).toBe(false));
    await chooseModel(container, 'claude-haiku-4-5');

    await waitFor(() => expect(served.callsTo('bureau.contexts.steer')).toHaveLength(2));
    const [first, second] = served.callsTo('bureau.contexts.steer');
    expect(second?.params['commandId']).toBe(first?.params['commandId']);
  });

  test('is turned off until the session has been read, because the switch needs its revision', async () => {
    serve();
    const { container } = mount({ current: undefined, revision: undefined });

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    expect(picker(container).disabled).toBe(true);
  });
});
