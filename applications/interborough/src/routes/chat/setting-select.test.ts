/**
 * The effort and permission selects in a session's composer, over a stubbed Bureau: what each sends
 * and with which revision, how each answer ends, and what they do while another setting is changed.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { steerContext } from '../../lib/bureau-client.ts';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import {
  chooseOption,
  listboxTrigger,
  optionDescriptions,
  optionDisabled,
  optionLabels,
  shownLabel,
  shownPrefix,
} from './listbox.test-support.ts';
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
  options?: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }[];
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
      options: props.options ?? SETTINGS.effortOptions,
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

const select = (container: HTMLElement): HTMLButtonElement => listboxTrigger(container);

/** Chooses the option whose value is `value`, by the words it is listed with. */
async function choose(container: HTMLElement, value: string): Promise<void> {
  const option = SETTINGS.effortOptions.find((entry) => entry.value === value);
  if (option === undefined) throw new Error(`The select lists no ${value}.`);
  await chooseOption(container, option.label);
}

describe('the select’s options', () => {
  test('lists the choices, and says the setting is the agent’s while the chat has none of its own', async () => {
    const { container } = mount({ current: null, unsetLabel: SETTINGS.agentDefault });

    expect(await optionLabels(container)).toEqual([
      SETTINGS.agentDefault,
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
    const disabled = await optionDisabled(container);
    expect(disabled[0]).toBe(true);
    expect(shownLabel(container)).toBe(SETTINGS.agentDefault);
  });

  test('shows the setting the chat has, with no placeholder when the setting always has a value', async () => {
    const { container } = mount({ current: 'high' });

    expect(shownLabel(container)).toBe('High');
    expect(await optionLabels(container)).toHaveLength(5);
  });

  test('is a ghost listbox that names the setting before its value', () => {
    const { container } = mount({ current: 'high' });

    expect(shownPrefix(container)).toBe(SETTINGS.effort);
    expect(container.querySelector('.cinder-select')?.getAttribute('data-cinder-variant')).toBe(
      'ghost',
    );
  });

  test('gives each option its help line when the setting has them', async () => {
    const { container } = mount({
      current: 'on-changes',
      options: SETTINGS.permissionOptions,
    });

    expect(await optionDescriptions(container)).toEqual(
      SETTINGS.permissionOptions.map((option) => option.description),
    );
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
    expect(shownLabel(container)).toBe('Low');
  });

  test('sends nothing for the choice already shown', async () => {
    const served = serve(() => ({ outcome: 'accepted', command: {} }));
    const { container } = mount({ current: 'low' });

    await choose(container, 'low');

    expect(served.callsTo('bureau.contexts.steer')).toHaveLength(0);
  });

  test('keeps an admitted choice on screen when the session cannot be read again', async () => {
    serve(() => ({ outcome: 'accepted', command: {} }));
    const { container, events } = mount({ current: 'low', reload: async () => false });

    await choose(container, 'high');

    await waitFor(() => expect(events).toEqual(['busy', 'applied', 'idle']));
    expect(shownLabel(container)).toBe('High');
  });

  test('restores the previous choice and says why when the Bureau refuses it', async () => {
    serve(() => ({
      outcome: 'rejected',
      failure: { failedAt: 'now', reason: 'policy-denied' },
    }));
    const { container, events, findByText } = mount({ current: 'low' });

    await choose(container, 'max');

    expect(await findByText(NOTICES.denied)).not.toBeNull();
    expect(shownLabel(container)).toBe('Low');
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
    expect(shownLabel(container)).toBe('Low');
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
    expect(shownLabel(container)).toBe('Low');
  });

  test('reads the session again after a fault, since nobody knows whether the Bureau took the change', async () => {
    serve(() => {
      throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
    });
    const { container, reloads, findByText } = mount({ current: 'low' });

    await choose(container, 'max');

    expect(await findByText(NOTICES.fault)).not.toBeNull();
    expect(reloads).toHaveLength(1);
    expect(shownLabel(container)).toBe('Low');
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
