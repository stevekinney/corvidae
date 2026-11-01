/**
 * The effort and permission selects in a session's composer, over a stubbed Bureau: what each sends
 * and with which revision, how each answer ends, and what they do while another setting is changed.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { steerContext } from '../../lib/bureau-client.ts';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import SettingSelect from './setting-select.svelte';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const SETTINGS = CHAT_COPY.settings;
const NOTICES = SETTINGS.effortNotices;

type Props = {
  current?: string | null | undefined;
  revision?: number | undefined;
  locked?: boolean;
  reload?: () => Promise<boolean>;
  unsetLabel?: string;
};

function serve(steer: (params: Record<string, unknown>) => unknown) {
  stub = installBureauStub({ 'bureau.contexts.steer': steer });
  return stub;
}

function mount(props: Props = {}) {
  const events: string[] = [];
  const reloads: number[] = [];
  const view = render(SettingSelect, {
    props: {
      sessionId: 'session-1',
      id: 'weft-chat-effort',
      label: SETTINGS.effort,
      options: SETTINGS.effortOptions,
      current: 'current' in props ? props.current : null,
      ...(props.unsetLabel === undefined ? {} : { unsetLabel: props.unsetLabel }),
      revision: 'revision' in props ? props.revision : 3,
      send: (value: string, commandId: string, expectedRevision: number) =>
        steerContext({
          contextId: 'session-1',
          commandId,
          expectedRevision,
          effort: value as 'low',
        }),
      notices: NOTICES,
      reload:
        props.reload ??
        (async () => {
          reloads.push(reloads.length + 1);
          return true;
        }),
      locked: props.locked ?? false,
      onBusyChange: (busy: boolean) => events.push(busy ? 'busy' : 'idle'),
      onApplied: () => events.push('applied'),
    },
  } as never);
  return { ...view, events, reloads };
}

function select(container: HTMLElement): HTMLSelectElement {
  const found = container.querySelector('select');
  if (found === null) throw new Error('The select did not render.');
  return found;
}

const choose = (container: HTMLElement, value: string) =>
  fireEvent.change(select(container), { target: { value } });

describe('the select’s options', () => {
  test('lists the choices, and says the setting is the agent’s while the chat has none of its own', () => {
    const { container } = mount({ current: null, unsetLabel: SETTINGS.agentDefault });

    expect([...select(container).options].map((option) => option.textContent)).toEqual([
      SETTINGS.agentDefault,
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
    expect(select(container).selectedOptions[0]?.disabled).toBe(true);
  });

  test('shows the setting the chat has, with no placeholder when the setting always has a value', () => {
    const { container } = mount({ current: 'high' });

    expect(select(container).value).toBe('high');
    expect([...select(container).options]).toHaveLength(5);
  });

  test('is changing a setting, so it is marked as one', () => {
    const { container } = mount({ current: 'high' });

    expect(select(container).hasAttribute('data-changes')).toBe(true);
  });

  test('takes no choice before the session is read, or while another setting is changed', () => {
    expect(select(mount({ current: undefined, revision: undefined }).container).disabled).toBe(
      true,
    );
    cleanup();
    expect(select(mount({ current: 'high', locked: true }).container).disabled).toBe(true);
  });
});

describe('choosing', () => {
  test('sends the choice with the revision the page read, then reads the session again', async () => {
    const served = serve(() => ({ outcome: 'accepted', command: {} }));
    const { container, events, reloads } = mount({ current: 'low', revision: 7 });

    await choose(container, 'max');

    await waitFor(() => expect(events).toEqual(['busy', 'applied', 'idle']));
    const params = served.callsTo('bureau.contexts.steer')[0]?.params;
    expect(params).toMatchObject({ contextId: 'session-1', effort: 'max', expectedRevision: 7 });
    expect(typeof params?.['commandId']).toBe('string');
    expect(reloads).toHaveLength(1);
    // The session read again is what shows from then on, and this one is read as it was.
    expect(select(container).value).toBe('low');
  });

  test('sends nothing for the choice already shown, or for one it does not list', async () => {
    const served = serve(() => ({ outcome: 'accepted', command: {} }));
    const { container } = mount({ current: 'low' });

    await choose(container, 'low');
    await choose(container, 'bogus');

    expect(served.callsTo('bureau.contexts.steer')).toHaveLength(0);
  });

  test('keeps an admitted choice on screen when the session cannot be read again', async () => {
    serve(() => ({ outcome: 'accepted', command: {} }));
    const { container, events } = mount({ current: 'low', reload: async () => false });

    await choose(container, 'high');

    await waitFor(() => expect(events).toEqual(['busy', 'applied', 'idle']));
    expect(select(container).value).toBe('high');
  });

  test('restores the previous choice and says why when the Bureau refuses it', async () => {
    serve(() => ({
      outcome: 'rejected',
      failure: { failedAt: 'now', reason: 'policy-denied' },
    }));
    const { container, events, findByText } = mount({ current: 'low' });

    await choose(container, 'max');

    expect(await findByText(NOTICES.denied)).not.toBeNull();
    expect(select(container).value).toBe('low');
    expect(events).not.toContain('applied');
  });

  test('reads the session again when it changed since it was read', async () => {
    serve(() => ({
      outcome: 'rejected',
      failure: { failedAt: 'now', reason: 'stale-revision' },
    }));
    const { container, reloads, findByText } = mount({ current: 'low' });

    await choose(container, 'max');

    expect(await findByText(NOTICES.staleRevision)).not.toBeNull();
    expect(reloads).toHaveLength(1);
    expect(select(container).value).toBe('low');
  });

  test('says what the Bureau’s own reason is for a request it refused outright', async () => {
    serve(() => {
      throw new StubFault('InvalidParams', 400, 'bad', {
        issues: [{ message: 'No such effort in the catalog.' }],
      });
    });
    const { container, findByText } = mount({ current: 'low' });

    await choose(container, 'max');

    expect(await findByText('No such effort in the catalog.')).not.toBeNull();
    expect(select(container).value).toBe('low');
  });

  test('reads the session again after a fault, since nobody knows whether the Bureau took the change', async () => {
    serve(() => {
      throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
    });
    const { container, reloads, findByText } = mount({ current: 'low' });

    await choose(container, 'max');

    expect(await findByText(NOTICES.fault)).not.toBeNull();
    expect(reloads).toHaveLength(1);
    expect(select(container).value).toBe('low');
  });

  test('says it was not changed for an answer with no setting of its own, such as a conflicting command or a closing Bureau', async () => {
    serve(() => ({ outcome: 'conflict' }));
    const conflicting = mount({ current: 'low' });
    await choose(conflicting.container, 'max');
    expect(await conflicting.findByText(NOTICES.notChanged)).not.toBeNull();
    cleanup();

    stub?.restore();
    serve(() => ({
      outcome: 'rejected',
      failure: { failedAt: 'now', reason: 'shutting-down' },
    }));
    const closing = mount({ current: 'low' });
    await choose(closing.container, 'max');
    expect(await closing.findByText(NOTICES.notChanged)).not.toBeNull();
  });

  test('says the chat has ended, or that the agent cannot change it, in those words', async () => {
    serve(() => ({ outcome: 'session-terminal', sessionId: 'session-1' }));
    const ended = mount({ current: 'low' });
    await choose(ended.container, 'max');
    expect(await ended.findByText(NOTICES.sessionTerminal)).not.toBeNull();
    cleanup();

    stub?.restore();
    serve(() => ({ outcome: 'unsupported-capability', reason: 'No effort.' }));
    const unsupported = mount({ current: 'low' });
    await choose(unsupported.container, 'max');
    expect(await unsupported.findByText(NOTICES.unsupportedCapability)).not.toBeNull();
  });
});
