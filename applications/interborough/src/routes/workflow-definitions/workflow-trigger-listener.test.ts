/**
 * COR-2171: a workflow file with a plugin trigger says what starts it ("Starts when …") and shows what
 * its listener is doing under that line, in the one form the header shows a workflow's status in: a
 * dot and a word, then only what the word does not say (each state, a failed one with when it is
 * tried again). A failed one offers Retry now, which calls `bureau.workflows.triggers.retry` and
 * shows the state it answers, a refused configuration offers Edit, and a kind that receives shows the
 * address its deliveries go to, which wraps with its copy control. A run a trigger started names the
 * trigger's plugin by its title in Started by.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { RETRY_LABEL } from '../../app/copy/views.ts';
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { STUB_TRIGGERS_URL, StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  emptyWorld,
  type FileFixture,
  installWorkflowWorld,
  readyFile,
  type WorkflowStub,
} from '../../lib/workflow-world.test-support.ts';
import RunOrigin from '../workflows/runs/run-origin.svelte';
import { triggerOrigin } from '../workflows/runs/run-rows.ts';
import Harness from './area-harness.test-harness.svelte';
import ToastAreaHarness from './toast-area-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const copy = WORKFLOW_COPY.page.listener;
const SINCE = '2020-01-01T00:00:00.000Z';

type Listener = NonNullable<FileFixture['listener']>;

const listening: Listener = {
  state: 'listening',
  since: SINCE,
  code: null,
  lastFiredAt: null,
  retryAt: null,
};

/** The plugin trigger kinds the running plugins contribute: `inbox:message` listens, `inbox:hook` receives. */
const KINDS = {
  triggers: [
    {
      plugin: 'inbox',
      id: 'inbox:message',
      description: 'A message arrives.',
      version: '1.0.0',
      receives: false,
      configuration: null,
    },
    {
      plugin: 'inbox',
      id: 'inbox:hook',
      description: 'Inbox sends a delivery, and you can read it.',
      version: '1.0.0',
      receives: true,
      configuration: null,
    },
  ],
  reactions: [],
};

/** A page for the file `digest`, whose trigger is `kind` and whose listener is `listener`. */
function open(
  listener: Listener | null,
  options: { kind?: string; toasts?: boolean; titles?: boolean; edit?: boolean } = {},
) {
  const trigger = { kind: options.kind ?? 'inbox:message' };
  stub = installWorkflowWorld(
    emptyWorld({
      files: [
        readyFile('digest', {
          trigger,
          listener,
          schedule: null,
          text: JSON.stringify(
            {
              name: 'digest',
              trigger,
              agent: 'writer',
              steps: [{ kind: 'sleep', duration: '1m' }],
            },
            null,
            2,
          ),
        }),
      ],
      hostPlugins: options.titles === false ? null : [{ name: 'inbox', title: 'Inbox' }],
    }),
  );
  stub.on('bureau.plugins.contributions', () => KINDS);
  router.navigate('/workflows/digest', { replace: true });
  return render(options.toasts === true ? ToastAreaHarness : Harness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

/** The trigger section, once the page has drawn it. */
async function section(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-testid="workflow-trigger-listener"]');
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
}

/**
 * The words of an element as a person reads them: one space between runs. The dot's own element
 * ends in whitespace the browser does not draw (it is inside a flex container), so a space before
 * the punctuation that follows a word is not a space a person sees.
 */
function words(element: Element | null | undefined): string {
  return (element?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.:;)])/g, '$1')
    .trim();
}

/** The status line of a section: the dot and word, and what follows. */
function line(found: HTMLElement): HTMLElement {
  const status = found.querySelector<HTMLElement>('[data-state]');
  if (status === null) throw new Error('the status line is not drawn');
  return status;
}

/** How many times `needle` is said in `haystack`. */
function times(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the trigger status on a workflow’s page', () => {
  const STATES: ReadonlyArray<readonly [Listener, string, string]> = [
    [listening, copy.states.listening, 'success'],
    [{ ...listening, state: 'ready' }, copy.states.ready, 'success'],
    [{ ...listening, state: 'standby' }, copy.states.standby, 'pending'],
    [{ ...listening, state: 'waiting-for-secret' }, copy.states['waiting-for-secret'], 'warning'],
    [{ ...listening, state: 'stopped' }, copy.states.stopped, 'neutral'],
    [
      { ...listening, state: 'failed', code: 'configuration-refused' },
      copy.states.failed,
      'danger',
    ],
  ];

  for (const [listener, word, tone] of STATES) {
    test(`shows ${listener.state} as the word ${word} beside its dot, said once, in its tone`, async () => {
      const { container } = open(listener);
      const found = await section(container);
      const status = line(found);
      expect(status.getAttribute('data-state')).toBe(listener.state);
      // One status form: the header's dot and word, not a badge, and the word is not said again.
      const dot = status.querySelector('.cinder-status-dot');
      expect(dot?.getAttribute('data-cinder-status')).toBe(tone);
      expect(words(dot)).toBe(word);
      expect(times(words(status), word)).toBe(1);
      expect(found.querySelector('.cinder-badge')).toBeNull();
      expect(words(status).startsWith(word)).toBe(true);
    });
  }

  test('a listening trigger says only when, after the word: "Listening since 12:00 AM."', async () => {
    const { container } = open(listening);
    const status = line(await section(container));
    expect(words(status)).toMatch(/^Listening since \d{1,2}:\d{2} [AP]M\.$/);
  });

  test('a ready trigger says it is ready to receive, and a stopped one why', async () => {
    const ready = open({ ...listening, state: 'ready' });
    expect(words(line(await section(ready.container)))).toMatch(
      /^Ready to receive deliveries since \d{1,2}:\d{2} [AP]M\.$/,
    );
    cleanup();
    stub?.restore();
    const stopped = open({ ...listening, state: 'stopped' });
    expect(words(line(await section(stopped.container)))).toBe(
      'Stopped while the workflow is paused.',
    );
  });

  test('a standby trigger says another Interborough runs it and that this one takes over', async () => {
    const { container } = open({ ...listening, state: 'standby' });
    expect(words(line(await section(container)))).toBe(
      'Standby, another Interborough that shares this storage runs this trigger. This one takes over if that one stops.',
    );
  });

  test('a trigger that waits for a secret names its plugin by title and leads to Plugins settings', async () => {
    const { container } = open({ ...listening, state: 'waiting-for-secret' });
    const status = line(await section(container));
    await waitFor(() =>
      expect(words(status)).toBe(
        'Waiting for a secret. Inbox needs one: add it in Plugins settings.',
      ),
    );
    const link = status.querySelector('a');
    expect(link?.textContent).toBe('add it in Plugins settings');
    expect(link?.getAttribute('href')).toContain('/settings/plugins');
  });

  test('a trigger that waits for a secret says "The plugin", never its identifier, while no title is loaded', async () => {
    const { container } = open({ ...listening, state: 'waiting-for-secret' }, { titles: false });
    const found = await section(container);
    await waitFor(() => expect(found.getAttribute('data-kinds')).toBe('loaded'));
    await quietFor(50);
    expect(words(line(found))).toBe(
      'Waiting for a secret. The plugin needs one: add it in Plugins settings.',
    );
    expect(found.textContent).not.toContain('inbox');
  });

  test('shows a failed trigger as one sentence, with when it is tried again, and the code last', async () => {
    const retryAt = new Date(Date.now() + 59 * 60_000 + 30_000).toISOString();
    const { container, getByRole } = open({
      ...listening,
      state: 'failed',
      code: 'start-failed',
      retryAt,
    });
    const found = await section(container);
    const status = line(found);
    expect(words(status)).toMatch(
      /^Failed, the trigger could not start\. Next try in \d+ minutes\. Try again \(code start-failed\)$/,
    );
    // COR-2489 design round: one label for a retry on every page.
    expect(copy.retry).toBe(RETRY_LABEL);
    expect(found.querySelector('[data-testid="workflow-trigger-code"]')?.textContent).toBe(
      'start-failed',
    );
    expect(getByRole('button', { name: copy.retry })).toBeTruthy();
  });

  test('draws Retry now at the xs size of an action inside a line', async () => {
    const { container, getByRole } = open({
      ...listening,
      state: 'failed',
      code: 'start-failed',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await section(container);
    expect(getByRole('button', { name: copy.retry }).getAttribute('data-cinder-size')).toBe('xs');
  });

  test('counts the next try down while the page is open', async () => {
    const { container } = open({
      ...listening,
      state: 'failed',
      code: 'start-failed',
      retryAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const status = line(await section(container));
    const first = words(status);
    expect(first).toMatch(/Next try in \d+ seconds\./);
    await waitUntil(() => words(status) !== first);
    expect(words(status)).toMatch(/Next try in \d+ seconds\./);
  });

  test('says when the last run started, after the sentence', async () => {
    const { container } = open({
      ...listening,
      lastFiredAt: '2020-01-01T00:00:30.000Z',
    });
    expect(words(line(await section(container)))).toMatch(
      /^Listening since \d{1,2}:\d{2} [AP]M\. Last started a run at \d{1,2}:\d{2} [AP]M\.$/,
    );
  });

  test('offers no Retry now for a listener that is not failed', async () => {
    const { container, queryByRole } = open(listening);
    await section(container);
    expect(queryByRole('button', { name: copy.retry })).toBeNull();
  });

  test('offers Edit, not Retry now, for a configuration the plugin refused', async () => {
    const { container, queryByRole } = open({
      ...listening,
      state: 'failed',
      code: 'configuration-refused',
    });
    const found = await section(container);
    expect(queryByRole('button', { name: copy.retry })).toBeNull();
    // The header has an Edit of its own; this one is on the status line.
    const edit = await waitFor(() => within(found).getByRole('link', { name: copy.edit }));
    expect(edit.getAttribute('href')).toContain('/workflows/digest/edit');
    expect(words(line(found))).toContain(
      'Failed, the plugin refused this trigger’s settings, so it is not tried again until they change.',
    );
    expect(words(line(found)).endsWith('(code configuration-refused)')).toBe(true);
  });

  test('Retry now calls bureau.workflows.triggers.retry and shows the state it answers', async () => {
    const { container, getByRole } = open({
      ...listening,
      state: 'failed',
      code: 'start-failed',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await section(container);
    const retried: unknown[] = [];
    stub!.on('bureau.workflows.triggers.retry', (params) => {
      retried.push(params);
      return { id: 'digest', listener: { ...listening, state: 'standby' } };
    });
    await fireEvent.click(getByRole('button', { name: copy.retry }));
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="workflow-trigger-listener"] [data-state]')
          ?.getAttribute('data-state'),
      ).toBe('standby'),
    );
    expect(retried).toEqual([{ id: 'digest' }]);
  });

  for (const [name, fault, words_] of [
    [
      'refused',
      new StubFault('Unprocessable', 422, 'REFUSED-RETRY-TEXT', { reason: 'no-listener' }),
      copy.retryFailed,
    ],
    ['forbidden', new StubFault('Forbidden', 403, 'FORBIDDEN-RETRY-TEXT'), copy.retryForbidden],
  ] as const) {
    test(`a ${name} Retry now is said once, as plain text beside the control, and raises no toast`, async () => {
      const { container, getByRole } = open(
        {
          ...listening,
          state: 'failed',
          code: 'start-failed',
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { toasts: true },
      );
      await section(container);
      stub!.on('bureau.workflows.triggers.retry', () => {
        throw fault;
      });
      await fireEvent.click(getByRole('button', { name: copy.retry }));
      const found = await section(container);
      // The page says the retry failed, beside the control, not in an alert box over the title.
      const failure = await waitFor(() => {
        const text = found.querySelector('[data-testid="workflow-trigger-failure"]');
        expect(text).toBeTruthy();
        return text as HTMLElement;
      });
      expect(failure.textContent).toBe(words_);
      expect(found.querySelector('.cinder-alert')).toBeNull();
      expect(line(found).contains(failure)).toBe(true);
      // And only there: the toast the query client raises by default names the Bureau's message.
      await quietFor(100);
      expect(document.body.textContent).not.toContain(fault.message);
      expect(document.body.textContent?.split(words_).length).toBe(2);
    });
  }

  test('says what starts the file from its kind’s description, with the status directly under that line', async () => {
    const { container, findByTestId } = open(listening);
    const startsLine = await findByTestId('workflow-line-starts');
    await waitFor(() => expect(words(startsLine)).toContain('Starts when a message arrives'));
    const found = await section(container);
    expect(startsLine.nextElementSibling).toBe(found);
  });

  test('says "Starts when" for a plugin kind that receives, and you can also start it yourself', async () => {
    const { findByTestId } = open({ ...listening, state: 'ready' }, { kind: 'inbox:hook' });
    const startsLine = await findByTestId('workflow-line-starts');
    await waitFor(() =>
      expect(words(startsLine)).toContain(
        'Starts when Inbox sends a delivery, and you can read it',
      ),
    );
  });

  test('a kind that receives shows the address its deliveries go to, in one value with its copy control', async () => {
    const { container } = open({ ...listening, state: 'ready' }, { kind: 'inbox:hook' });
    const found = await section(container);
    await waitFor(() =>
      expect(found.querySelector('[data-testid="workflow-trigger-address"]')).toBeTruthy(),
    );
    const value = found.querySelector<HTMLElement>('[data-testid="workflow-trigger-address"]');
    expect(value?.classList.contains('cinder-copyable-value')).toBe(true);
    // The value as drawn: every part's text, without the copy control's label.
    const shown = value?.cloneNode(true) as HTMLElement | undefined;
    shown?.querySelector('.cinder-copyable-value__control')?.remove();
    const drawn = shown?.textContent ?? '';
    expect(drawn).toBe(`${STUB_TRIGGERS_URL}digest`);
    // The control sits in the value's last stretch, so it wraps with the address.
    expect(
      value?.querySelector(`.cinder-copyable-value__end button[aria-label="${copy.copyAddress}"]`),
    ).toBeTruthy();
  });

  test('a kind that only listens shows no address', async () => {
    const { container } = open(listening, { kind: 'inbox:message' });
    const found = await section(container);
    // The section has drawn what the kinds said, and still has no address.
    await waitFor(() => expect(found.getAttribute('data-kinds')).toBe('loaded'));
    expect(found.querySelector('[data-testid="workflow-trigger-address"]')).toBeNull();
  });

  test('a file with no listener shows no trigger status', async () => {
    const { container, findByText } = open(null, { kind: 'schedule' });
    await findByText('digest');
    expect(container.querySelector('[data-testid="workflow-trigger-listener"]')).toBeNull();
  });
});

describe('the Started by of a run a trigger started (COR-2171)', () => {
  test('names the trigger’s plugin and links to the file whose trigger it is', () => {
    const { container } = render(RunOrigin, {
      props: { origin: triggerOrigin('linear', 'sync') },
    });
    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.textContent).toBe('linear');
    expect(link?.getAttribute('href')).toContain('/workflows/sync');
  });

  test('names the plugin by its title, not its identifier, and in no code element', () => {
    const { container } = render(RunOrigin, {
      props: {
        origin: triggerOrigin('github', 'sync'),
        pluginTitle: (plugin: string) => (plugin === 'github' ? 'GitHub' : undefined),
      },
    });
    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.textContent).toBe('GitHub');
    expect(container.querySelector('code')).toBeNull();
    expect(container.textContent).not.toContain('github');
  });
});
