/**
 * The Embedder row of Settings › General (board COR-2189, rows EM6-01 to EM6-23): the picker over
 * the embedders memory can use, the confirmation before a switch, the line of a running, canceled
 * or failed switch with its cancel and its retry, and what the row says while the embedder in use
 * has a problem. The Bureau is a stub (`settings-fixtures.test-support.ts`) and the host's plugins
 * a stand-in (`plugins/plugins-host.test-support.ts`); the real ones are the Playwright suite's
 * (`tests/e2e/settings-general.spec.ts`).
 */
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { EMBEDDER_COPY } from '../../app/copy/embedder.ts';
import { PLUGINS_COPY } from '../../app/copy/plugins.ts';
import { SETTINGS_COPY } from '../../app/copy/settings.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { API_SCOPES } from '../../lib/api-scopes.ts';
import type { EmbeddingStatus } from '../../lib/bureau-embedding.ts';
import { StubFault, type BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';
import {
  contribution,
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from './plugins/plugins-host.test-support.ts';
import {
  installSettingsBureau,
  servedSettings,
  type SettingsServed,
} from './settings-fixtures.test-support.ts';

const copy = EMBEDDER_COPY;

let stub: BureauStub | undefined;
let pluginHost: FakePluginHost | undefined;
let restoreSession: (() => void) | undefined;
let served: SettingsServed;

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  // Newest first: each stand-in restores the fetch it found.
  restoreSession?.();
  restoreSession = undefined;
  pluginHost?.restore();
  pluginHost = undefined;
  stub?.restore();
  stub = undefined;
});

const GEMINI: PluginFixture = {
  name: 'gemini',
  title: 'Gemini',
  contributions: [contribution('embedder', 'gemini:embedder')],
  secrets: [{ key: 'gemini-api-key', set: true }],
};

/** The status of memory on the built-in embedder with Gemini registered beside it, and nothing to report. */
function embedding(overrides: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
  return {
    active: { embedder: 'hashing', dimension: 256, model: 'hashing' },
    problem: null,
    job: null,
    embedders: [
      { id: 'hashing', dimension: 256, availability: 'available' },
      { id: 'gemini:embedder', dimension: 768, availability: 'available' },
    ],
    ...overrides,
  };
}

/** What the stub Bureau holds about embedding, which a test changes as the Bureau would. */
const world: {
  status: EmbeddingStatus | (() => EmbeddingStatus | Promise<EmbeddingStatus>);
  /** Throws on a refused or unreachable write; the stub does the write when it returns. */
  beforeWrite?: (patch: Record<string, unknown>) => void;
  /** Called with the embedder a write asked for, as the Bureau starts the switch. */
  afterWrite?: (target: string) => void;
  cancel?: () => { cancelled: boolean };
} = { status: embedding() };

function open(
  options: {
    plugins?: PluginFixture[];
    /** The scopes of the session; the host's own answer when left out. */
    scopes?: readonly string[];
    lockEmbedder?: boolean;
  } = {},
) {
  world.status = embedding();
  delete world.beforeWrite;
  delete world.afterWrite;
  delete world.cancel;
  served = servedSettings({
    values: { ...servedSettings().values, 'memory.embedder': 'hashing' },
    ...(options.lockEmbedder === true ? { locked: new Set(['memory.embedder']) } : {}),
  });
  stub = installSettingsBureau(served, {
    'bureau.memory.embedding': async () =>
      typeof world.status === 'function' ? await world.status() : structuredClone(world.status),
    'bureau.memory.embedding.cancel': () => world.cancel?.() ?? { cancelled: true },
    'bureau.settings.update': (params) => {
      const patch = params['patch'] as Record<string, unknown>;
      world.beforeWrite?.(patch);
      if (params['expectedRevision'] !== served.revision) {
        throw new StubFault('StaleRevision', 409, 'The settings changed since they were read.', {
          currentRevision: served.revision,
        });
      }
      served.values = { ...served.values, ...patch };
      served.revision += 1;
      const target = patch['memory.embedder'];
      if (typeof target === 'string') world.afterWrite?.(target);
      return { revision: served.revision, pendingRestart: [] };
    },
  });
  pluginHost = installFakePluginHost(options.plugins ?? [GEMINI]);
  if (options.scopes !== undefined) {
    const scopes = options.scopes;
    const underneath = globalThis.fetch;
    restoreSession = installFetchImplementation(async (input, init) => {
      const path = new URL(
        typeof input === 'string' ? input : 'url' in input ? input.url : input.href,
        'http://localhost',
      ).pathname;
      return path === '/host/session'
        ? Response.json({ subject: 'reader', scopes })
        : underneath(input, init);
    });
  }
  landAt('/settings');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const row = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-setting="memory.embedder"]')!;
const trigger = (container: HTMLElement) => within(row(container)).getByRole('combobox');
const line = (container: HTMLElement) =>
  row(container).querySelector<HTMLElement>('[data-testid="embedder-switch"]');
const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

/** The row is drawn and has read the embedders: its picker can be used. */
const ready = (container: HTMLElement) =>
  waitFor(() => {
    expect(row(container)).not.toBeNull();
    expect(trigger(container).hasAttribute('disabled')).toBe(false);
  });

/** The row has read a switch that is running, failed or canceled. */
const lineShown = (container: HTMLElement) => waitFor(() => expect(line(container)).not.toBeNull());

/** Opens the picker and returns its options. */
async function optionsOf(container: HTMLElement): Promise<HTMLElement[]> {
  await fireEvent.click(trigger(container));
  const body = container.ownerDocument.body;
  await waitFor(() => expect(body.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
  return [...body.querySelectorAll<HTMLElement>('[role="option"]')];
}

const dialogTitled = (container: HTMLElement, title: string) =>
  waitFor(() => {
    const found = [...container.ownerDocument.querySelectorAll<HTMLElement>('dialog[open]')].find(
      (candidate) => candidate.querySelector('h2')?.textContent?.trim() === title,
    );
    expect(found, `a dialog titled "${title}"`).toBeDefined();
    return found!;
  });

const noDialog = (container: HTMLElement) =>
  expect(container.ownerDocument.querySelectorAll('dialog[open]')).toHaveLength(0);

describe('the picker (EM6-01 to EM6-06)', () => {
  test('is a Select of the registered embedders in words, with no field that takes an identifier, and nothing else on the row while nothing is wrong (EM6-01, EM6-02, EM6-06)', async () => {
    const { container } = open();
    await ready(container);

    expect(within(row(container)).queryByRole('textbox')).toBeNull();
    expect(trigger(container).textContent).toContain('Text hashing');
    const options = await optionsOf(container);
    expect(options.map((option) => text(option))).toEqual([
      expect.stringContaining('Text hashing'),
      expect.stringContaining('Gemini'),
    ]);
    expect(text(options[0])).toContain(copy.builtIn.suffix);
    expect(text(options[1])).not.toContain(copy.builtIn.suffix);
    for (const option of options) expect(text(option)).not.toMatch(/gemini:|hashing:|embedder/u);
    await fireEvent.keyDown(trigger(container), { key: 'Escape' });

    // Nothing wrong and no switch: no dot, bar, panel or extra line.
    expect(row(container).querySelector('.cinder-status-dot')).toBeNull();
    expect(row(container).querySelector('[role="progressbar"]')).toBeNull();
    expect(line(container)).toBeNull();
    expect(row(container).querySelector('.cinder-setting-row__status')?.textContent?.trim()).toBe(
      '',
    );
    expect(text(row(container))).toContain('memory.embedder');
  });

  test('follows a plugin’s title with the embedder’s own name when the plugin adds more than one (EM6-02)', async () => {
    const { container } = open({
      plugins: [
        {
          name: 'multi',
          title: 'Multi',
          contributions: [
            contribution('embedder', 'multi:small', {}, 'Small model'),
            contribution('embedder', 'multi:large'),
          ],
        },
      ],
    });
    world.status = embedding({
      embedders: [
        { id: 'hashing', dimension: 256, availability: 'available' },
        { id: 'multi:small', dimension: 64, availability: 'available' },
        { id: 'multi:large', dimension: 128, availability: 'available' },
      ],
    });
    await ready(container);

    const options = await optionsOf(container);
    expect(options.map((option) => text(option))).toEqual([
      expect.stringContaining('Text hashing'),
      expect.stringContaining('Multi, Small model'),
      expect.stringContaining('Multi, Large'),
    ]);
  });

  test('lists an embedder that needs setup but does not let it be chosen, with its note and its description (EM6-03)', async () => {
    const { container } = open();
    world.status = embedding({
      embedders: [
        { id: 'hashing', dimension: 256, availability: 'available' },
        { id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' },
      ],
    });
    await ready(container);

    const options = await optionsOf(container);
    const gemini = options.find((option) => text(option).includes('Gemini'))!;
    expect(gemini.getAttribute('aria-disabled')).toBe('true');
    expect(text(gemini)).toContain(copy.needsSetup.note);
    expect(text(gemini)).toContain(copy.needsSetup.description);
    await fireEvent.click(gemini);
    noDialog(container);
    expect(updates()).toHaveLength(0);
  });

  test('holds the embedder memory uses as its value after a canceled switch, while the setting still names the other (EM6-04)', async () => {
    const { container } = open();
    served.values['memory.embedder'] = 'gemini:embedder';
    world.status = embedding({
      job: { target: 'gemini:embedder', state: 'cancelled', done: 2, total: 9, error: null },
    });
    await lineShown(container);

    expect(trigger(container).textContent).toContain('Text hashing');
    expect(trigger(container).textContent).not.toContain('Gemini');
  });

  test('shows an embedder in use that no plugin has loaded as the current value, in words, with the note Not loaded (EM6-05)', async () => {
    const { container } = open({
      plugins: [{ name: 'ollama', title: 'Ollama', status: 'skipped' }],
    });
    world.status = embedding({
      active: { embedder: 'ollama:embed', dimension: 4, model: 'm' },
      problem: 'embedder-unavailable',
      embedders: [{ id: 'hashing', dimension: 256, availability: 'available' }],
    });
    await waitFor(() => expect(trigger(container).textContent).toContain('Ollama'));

    expect(trigger(container).textContent).not.toContain('ollama:embed');
    const options = await optionsOf(container);
    const loaded = options.find((option) => text(option).includes('Ollama'))!;
    expect(text(loaded)).toContain(copy.notLoadedNote);
  });
});

describe('a switch (EM6-07)', () => {
  test('asks first, in words that name both embedders and the cost, and Keep leaves the setting and the picker as they were', async () => {
    const { container } = open();
    await ready(container);

    const options = await optionsOf(container);
    await fireEvent.click(options.find((option) => text(option).includes('Gemini'))!);

    const dialog = await dialogTitled(container, 'Switch memory search to Gemini?');
    expect(text(dialog)).toContain(
      'Interborough embeds every stored memory again with Gemini. Search keeps using Text hashing until all of them are done, and you can cancel at any point. A paid embedder charges for each memory it embeds.',
    );
    expect(within(dialog).getByRole('button', { name: 'Switch embedder' })).toBeDefined();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Text hashing' }));

    await waitFor(() => noDialog(container));
    expect(updates()).toHaveLength(0);
    expect(served.values['memory.embedder']).toBe('hashing');
    expect(trigger(container).textContent).toContain('Text hashing');
  });

  test('writes the setting against the revision just read only when confirmed, and the row then shows the running switch alone', async () => {
    const { container } = open();
    world.afterWrite = (target) => {
      world.status = embedding({
        job: { target, state: 'running', done: 0, total: 10, error: null },
      });
    };
    await ready(container);
    const options = await optionsOf(container);
    await fireEvent.click(options.find((option) => text(option).includes('Gemini'))!);
    const dialog = await dialogTitled(container, 'Switch memory search to Gemini?');

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Switch embedder' }));

    await lineShown(container);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]?.params['patch']).toEqual({ 'memory.embedder': 'gemini:embedder' });
    expect(updates()[0]?.params['expectedRevision']).toBe(served.revision - 1);
    await waitFor(() => noDialog(container));
    // The setting's own save line never shows beside the switch line (EM6-09, EM6-23).
    expect(row(container).querySelector('.cinder-setting-row__status')?.textContent?.trim()).toBe(
      '',
    );
    expect(text(row(container))).not.toContain('Saved just now');
  });
});

describe('a running switch (EM6-08, EM6-09, EM6-23)', () => {
  const running = () =>
    embedding({
      job: { target: 'gemini:embedder', state: 'running', done: 3, total: 10, error: null },
    });

  test('reads the Running word and the count, over a determinate bar with Cancel switch on the same row', async () => {
    const { container } = open();
    world.status = running();
    await lineShown(container);

    const found = line(container)!;
    const dot = found.querySelector('.cinder-status-dot')!;
    expect(dot.getAttribute('data-cinder-status')).toBe('info');
    expect(text(dot)).toBe('Running');
    expect(text(found)).toContain('Switch to Gemini, 3 of 10 memories');
    const bar = found.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('10');
    expect(bar.getAttribute('data-cinder-size')).toBe('sm');
    expect(bar.getAttribute('data-cinder-indeterminate')).toBeNull();
    const cancel = within(found).getByRole('button', { name: 'Cancel switch' });
    expect(cancel.parentElement).toBe(bar.parentElement?.parentElement ?? null);
  });

  test('disables the picker and describes it by the switch line, and states the switch nowhere else', async () => {
    const { container } = open();
    world.status = running();
    await lineShown(container);

    expect(trigger(container).hasAttribute('disabled')).toBe(true);
    const sentence = [...line(container)!.querySelectorAll('[id]')].find((element) =>
      text(element).startsWith('Switch to Gemini'),
    )!;
    expect(trigger(container).getAttribute('aria-describedby')).toContain(sentence.id);
    expect(row(container).querySelector('.cinder-setting-row__status')?.textContent?.trim()).toBe(
      '',
    );
    expect(row(container).querySelectorAll('.cinder-status-dot')).toHaveLength(1);
    expect(container.ownerDocument.querySelector('.cinder-toast')).toBeNull();
  });

  test.each([
    ['running', 'Running', 'info'],
    ['failed', 'Failed', 'danger'],
    ['cancelled', 'Canceled', 'neutral'],
  ] as const)(
    'draws a %s switch with the table’s word %s in its table tone %s, and no other status',
    async (state, word, tone) => {
      const { container } = open();
      world.status = embedding({
        job: {
          target: 'gemini:embedder',
          state,
          done: 1,
          total: 2,
          error: state === 'failed' ? 'embedder-timeout' : null,
        },
      });
      await lineShown(container);

      const dots = row(container).querySelectorAll('.cinder-status-dot');
      expect(dots).toHaveLength(1);
      expect(text(dots[0])).toBe(word);
      expect(dots[0]?.getAttribute('data-cinder-status')).toBe(tone);
      expect(row(container).querySelector('.cinder-setting-row__status')?.textContent?.trim()).toBe(
        '',
      );
    },
  );
});

describe('canceling a switch (EM6-11, EM6-12, EM6-13)', () => {
  const running = () =>
    embedding({
      job: { target: 'gemini:embedder', state: 'running', done: 3, total: 10, error: null },
    });

  test('asks first in the danger style, and Keep switching changes nothing', async () => {
    const { container } = open();
    world.status = running();
    await lineShown(container);

    await fireEvent.click(within(line(container)!).getByRole('button', { name: 'Cancel switch' }));
    const dialog = await dialogTitled(container, 'Cancel the switch to Gemini?');

    expect(text(dialog)).toContain(
      'The 3 memories embedded so far are thrown away. Search keeps using Text hashing, and nothing else changes.',
    );
    const confirm = within(dialog).getByRole('button', { name: 'Cancel switch' });
    expect(confirm.getAttribute('data-cinder-variant') ?? confirm.className).toMatch(/danger/u);
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep switching' }));
    await waitFor(() => noDialog(container));
    expect(stub?.callsTo('bureau.memory.embedding.cancel')).toHaveLength(0);
    expect(line(container)?.getAttribute('data-state')).toBe('running');
  });

  test('keeps the dialog open with the reason when the Bureau does not answer, and Cancel switch can be pressed again', async () => {
    const { container } = open();
    world.status = running();
    let fail = true;
    world.cancel = () => {
      if (fail) throw new StubFault('Internal', 500, 'The server did not answer.');
      world.status = embedding({
        job: { target: 'gemini:embedder', state: 'cancelled', done: 3, total: 10, error: null },
      });
      return { cancelled: true };
    };
    await lineShown(container);
    await fireEvent.click(within(line(container)!).getByRole('button', { name: 'Cancel switch' }));
    const dialog = await dialogTitled(container, 'Cancel the switch to Gemini?');

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel switch' }));

    await waitFor(() => expect(text(dialog)).toContain('Couldn’t cancel the switch.'));
    expect(text(dialog)).toContain('Interborough didn’t answer. The switch is still running.');
    expect(dialog.hasAttribute('open')).toBe(true);
    fail = false;
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel switch' }));
    await waitFor(() => expect(line(container)?.getAttribute('data-state')).toBe('canceled'));
  });

  test('names the switch and the count it was opened for, whatever the switch does under it', async () => {
    const { container } = open();
    world.status = running();
    await lineShown(container);
    await fireEvent.click(within(line(container)!).getByRole('button', { name: 'Cancel switch' }));
    const dialog = await dialogTitled(container, 'Cancel the switch to Gemini?');

    world.status = embedding({
      job: { target: 'gemini:embedder', state: 'running', done: 7, total: 10, error: null },
    });
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(text(line(container))).toContain('7 of 10 memories'));
    expect(text(dialog)).toContain('The 3 memories embedded so far are thrown away.');
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  test('closes when the switch ends under it, since there is nothing left to cancel', async () => {
    const { container } = open();
    world.status = running();
    await lineShown(container);
    await fireEvent.click(within(line(container)!).getByRole('button', { name: 'Cancel switch' }));
    await dialogTitled(container, 'Cancel the switch to Gemini?');

    // The switch finished while the question was open.
    world.status = embedding();
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => noDialog(container));
    expect(line(container)).toBeNull();
  });

  test('says You canceled the switch, in the neutral Canceled word, with no button, and keeps saying it (EM6-13)', async () => {
    const { container } = open();
    world.status = embedding({
      job: { target: 'gemini:embedder', state: 'cancelled', done: 3, total: 10, error: null },
    });
    await lineShown(container);

    const found = line(container)!;
    expect(text(found)).toContain(
      'You canceled the switch to Gemini. Search still uses Text hashing.',
    );
    expect(text(found.querySelector('.cinder-status-dot'))).toBe('Canceled');
    expect(found.querySelector('button')).toBeNull();
    // The picker is free again, and the line stays until another switch starts.
    expect(trigger(container).hasAttribute('disabled')).toBe(false);
  });
});

describe('a failed switch (EM6-14)', () => {
  const failed = (error: string | null) =>
    embedding({
      job: { target: 'gemini:embedder', state: 'failed', done: 4, total: 10, error },
    });

  test.each([
    ['target-unavailable', 'Gemini wasn’t loaded after a restart'],
    ['target-missing', 'Gemini isn’t installed any more'],
    ['embedder-failed', 'Gemini couldn’t embed one of the memories'],
    ['embedder-timeout', 'Gemini took too long to answer'],
  ])('words the cause %s, with the embedder search still uses', async (code, cause) => {
    const { container } = open();
    world.status = failed(code);
    await lineShown(container);

    const found = line(container)!;
    expect(text(found.querySelector('.cinder-status-dot'))).toBe('Failed');
    expect(text(found)).toContain(
      `The switch to Gemini failed: ${cause}. Search still uses Text hashing.`,
    );
    expect(text(found)).not.toContain(code);
  });

  test('says an unknown code stopped the switch and shows the code in monospace, the one place a code shows', async () => {
    const { container } = open();
    world.status = failed('quota-exceeded');
    await lineShown(container);

    const found = line(container)!;
    // The whole sentence, as the browser specification matches it.
    expect(text(found)).toContain(
      'The switch to Gemini failed: Gemini stopped the switch (quota-exceeded). Search still uses Text hashing.',
    );
    const code = found.querySelector('code')!;
    expect(code.textContent).toBe('quota-exceeded');
  });

  test('offers Retry switch, which opens the same confirmation a pick does', async () => {
    const { container } = open();
    world.status = failed('embedder-timeout');
    await lineShown(container);

    await fireEvent.click(within(line(container)!).getByRole('button', { name: 'Retry switch' }));

    const dialog = await dialogTitled(container, 'Switch memory search to Gemini?');
    expect(within(dialog).getByRole('button', { name: 'Switch embedder' })).toBeDefined();
  });
});

describe('a problem with the embedder in use (EM6-15, EM6-16)', () => {
  const problem = (overrides: Partial<EmbeddingStatus>) =>
    embedding({
      active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
      problem: 'embedder-unavailable',
      ...overrides,
    });
  const descriptionOf = (container: HTMLElement) =>
    text(row(container).querySelector('.cinder-form-field__description'));

  test('says the embedder is not loaded and links to its plugin when the plugin is known', async () => {
    const { container } = open({
      plugins: [{ name: 'gemini', title: 'Gemini', status: 'skipped' }],
    });
    world.status = problem({
      embedders: [{ id: 'hashing', dimension: 256, availability: 'available' }],
    });

    await waitFor(() =>
      expect(descriptionOf(container)).toContain(
        'Gemini isn’t loaded, so memory search matches words only until it’s back or you switch embedders.',
      ),
    );
    const link = within(row(container)).getByRole('link', { name: 'Open Gemini in Settings' });
    expect(link.getAttribute('href')).toBe('/settings/plugins?plugin=gemini');
    expect(descriptionOf(container)).not.toContain('Save its key');
  });

  test('offers no link to a plugin the host does not list', async () => {
    const { container } = open({ plugins: [] });
    world.status = problem({
      active: { embedder: 'ollama:embed', dimension: 4, model: 'm' },
      embedders: [{ id: 'hashing', dimension: 256, availability: 'available' }],
    });

    await waitFor(() => expect(descriptionOf(container)).toContain('Ollama isn’t loaded'));
    expect(within(row(container)).queryByRole('link')).toBeNull();
  });

  test('says the embedder needs its key, and Add the key opens the existing dialog for the one missing secret', async () => {
    const { container } = open({
      plugins: [
        { ...GEMINI, status: 'needs-setup', secrets: [{ key: 'gemini-api-key', set: false }] },
      ],
    });
    world.status = problem({
      embedders: [
        { id: 'hashing', dimension: 256, availability: 'available' },
        { id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' },
      ],
    });

    await waitFor(() =>
      expect(descriptionOf(container)).toContain(
        'Gemini needs its key, so memory search matches words only until it’s saved.',
      ),
    );
    await fireEvent.click(within(row(container)).getByRole('button', { name: 'Add the key' }));
    const dialog = await dialogTitled(
      container,
      PLUGINS_COPY.secrets.dialog.title('gemini-api-key'),
    );

    // The key is saved, memory can embed again, and the row says so without a reload.
    await fireEvent.input(within(dialog).getByLabelText(PLUGINS_COPY.secrets.dialog.valueLabel), {
      target: { value: 'a-key-that-is-never-shown' },
    });
    world.status = embedding({
      active: { embedder: 'gemini:embedder', dimension: 768, model: 'm' },
    });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.secrets.dialog.save }),
    );

    await waitFor(() => expect(descriptionOf(container)).not.toContain('needs its key'));
    expect(descriptionOf(container)).not.toContain('Add the key');
  });

  test('links to the plugin instead when more than one secret is missing', async () => {
    const { container } = open({
      plugins: [
        {
          ...GEMINI,
          status: 'needs-setup',
          secrets: [
            { key: 'gemini-api-key', set: false },
            { key: 'gemini-project', set: false },
          ],
        },
      ],
    });
    world.status = problem({
      embedders: [{ id: 'gemini:embedder', dimension: 768, availability: 'needs-setup' }],
    });

    await waitFor(() => expect(descriptionOf(container)).toContain('Gemini needs its key'));
    expect(within(row(container)).queryByRole('button', { name: 'Add the key' })).toBeNull();
    expect(
      within(row(container)).getByRole('link', { name: 'Open Gemini in Settings' }),
    ).toBeDefined();
  });

  test('says the vectors are another size, and Embed again asks to embed every memory again with the same embedder', async () => {
    const { container } = open();
    world.status = problem({
      embedders: [
        { id: 'hashing', dimension: 256, availability: 'available' },
        { id: 'gemini:embedder', dimension: 1536, availability: 'available' },
      ],
    });

    await waitFor(() =>
      expect(descriptionOf(container)).toContain(
        'Gemini now makes vectors of another size than your memories were made with, so search matches words only.',
      ),
    );
    await fireEvent.click(within(row(container)).getByRole('button', { name: 'Embed again' }));
    const dialog = await dialogTitled(container, 'Embed every memory again with Gemini?');

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Embed again' }));
    // The setting already holds this embedder; the write is made all the same.
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'memory.embedder': 'gemini:embedder' });
  });

  test('says the model changed at the same size, with Embed again', async () => {
    const { container } = open();
    world.status = problem({});

    await waitFor(() =>
      expect(descriptionOf(container)).toContain(
        'Gemini now runs another model than your memories were made with, so search matches words only.',
      ),
    );
    expect(within(row(container)).getByRole('button', { name: 'Embed again' })).toBeDefined();
  });
});

describe('what the row says of the embedders (EM6-17, EM6-18, EM6-19)', () => {
  const descriptionOf = (container: HTMLElement) =>
    text(row(container).querySelector('.cinder-form-field__description'));

  test('names the only embedder, says plugins can add others, and links to Plugins (EM6-17)', async () => {
    const { container } = open();
    world.status = embedding({
      embedders: [{ id: 'hashing', dimension: 256, availability: 'available' }],
    });

    await waitFor(() =>
      expect(descriptionOf(container)).toContain(
        'Text hashing is the only embedder. Plugins can add others.',
      ),
    );
    expect(trigger(container).textContent).toContain('Text hashing');
    expect(
      within(row(container)).getByRole('link', { name: 'Open Plugins' }).getAttribute('href'),
    ).toBe('/settings/plugins');
  });

  test('keeps the row on a home with no memory, with the picker disabled and empty (EM6-18)', async () => {
    const { container } = open();
    world.status = () => {
      throw new StubFault('UnsupportedCapability', 501, 'This Bureau keeps no memory', {});
    };

    await waitFor(() => expect(descriptionOf(container)).toContain(copy.noMemory));
    expect(trigger(container).hasAttribute('disabled')).toBe(true);
    expect(trigger(container).textContent?.trim()).toBe('');
  });

  test('disables the picker on its current value while the embedders are read (EM6-19)', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { container } = open();
    world.status = async () => {
      await held;
      return embedding();
    };

    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(trigger(container).hasAttribute('disabled')).toBe(true);
    expect(trigger(container).textContent).toContain('Text hashing');
    expect(row(container).querySelector('[role="progressbar"], .cinder-spinner')).toBeNull();
    release();
    await ready(container);
  });

  test('says the embedders could not be loaded, with Try again on the row, and the rest of the page stays usable (EM6-19)', async () => {
    const { container } = open();
    let failing = true;
    world.status = () => {
      if (failing) throw new StubFault('Internal', 500, 'The server did not answer.');
      return embedding();
    };

    await waitFor(() => expect(text(row(container))).toContain(copy.loadFailed));
    expect(trigger(container).hasAttribute('disabled')).toBe(true);
    expect(
      (
        container.querySelector('[data-setting="tools.wakeup"] button[role="switch"]') as
          HTMLButtonElement | undefined
      )?.disabled,
    ).toBe(false);
    failing = false;
    await fireEvent.click(within(row(container)).getByRole('button', { name: 'Try again' }));
    await ready(container);
    expect(text(row(container))).not.toContain(copy.loadFailed);
  });
});

describe('a switch the server does not take (EM6-20)', () => {
  async function pickGemini(container: HTMLElement): Promise<void> {
    await ready(container);
    const options = await optionsOf(container);
    await fireEvent.click(options.find((option) => text(option).includes('Gemini'))!);
    const dialog = await dialogTitled(container, 'Switch memory search to Gemini?');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Switch embedder' }));
  }

  test('says why in words and offers no retry when the Bureau refuses it', async () => {
    const { container } = open();
    world.beforeWrite = () => {
      // Another switch started first, so the Bureau refuses this one.
      world.status = embedding({
        job: { target: 'hashing', state: 'running', done: 1, total: 4, error: null },
      });
      throw new StubFault('InvalidParams', 400, 'A switch to the embedder "hashing" is running', {
        issues: [{ path: ['patch', 'memory.embedder'], message: 'A switch is running' }],
      });
    };

    await pickGemini(container);

    await waitFor(() =>
      expect(text(row(container))).toContain(
        'Couldn’t switch to Gemini: another switch is already running. Nothing changed.',
      ),
    );
    expect(text(row(container))).not.toContain('hashing"');
    expect(within(row(container)).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  test('offers Try again only when the server did not answer, and the second try goes through', async () => {
    const { container } = open();
    let down = true;
    world.beforeWrite = () => {
      if (down) throw new StubFault('Internal', 500, 'The server did not answer.');
    };

    await pickGemini(container);

    await waitFor(() =>
      expect(text(row(container))).toContain(
        'Couldn’t switch to Gemini: Interborough didn’t answer. Nothing changed.',
      ),
    );
    down = false;
    world.afterWrite = (target) => {
      world.status = embedding({
        job: { target, state: 'running', done: 0, total: 3, error: null },
      });
    };
    await fireEvent.click(within(row(container)).getByRole('button', { name: 'Try again' }));

    await lineShown(container);
    expect(text(row(container))).not.toContain('Couldn’t switch');
  });
});

describe('who may change it (EM6-21)', () => {
  const readOnly = API_SCOPES.filter((scope) => scope !== 'settings:write');

  test('shows the picker in the page’s read-only treatment for a caller that cannot change settings, with no Cancel switch', async () => {
    const { container } = open({ scopes: readOnly });
    world.status = embedding({
      job: { target: 'gemini:embedder', state: 'running', done: 3, total: 10, error: null },
    });
    await lineShown(container);

    await waitFor(() => expect(text(row(container))).toContain(SETTINGS_COPY.forbidden));
    expect(trigger(container).hasAttribute('disabled')).toBe(true);
    expect(within(row(container)).queryByRole('button', { name: 'Cancel switch' })).toBeNull();
  });

  test('offers no Retry switch to that caller after a failed switch', async () => {
    const { container } = open({ scopes: readOnly });
    world.status = embedding({
      job: {
        target: 'gemini:embedder',
        state: 'failed',
        done: 3,
        total: 10,
        error: 'embedder-failed',
      },
    });
    await lineShown(container);

    await waitFor(() => expect(text(row(container))).toContain(SETTINGS_COPY.forbidden));
    expect(within(row(container)).queryByRole('button', { name: 'Retry switch' })).toBeNull();
  });

  test('holds the picker, with the page’s locked words, when the deployment locked the setting', async () => {
    const { container } = open({ lockEmbedder: true });
    await waitFor(() => expect(row(container)).not.toBeNull());

    await waitFor(() => expect(text(row(container))).toContain(SETTINGS_COPY.lockedMessage));
    expect(trigger(container).hasAttribute('disabled')).toBe(true);
    expect(row(container).getAttribute('data-locked')).toBe('true');
  });
});

describe('the status is read again while a switch runs (EM6-08)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('moves the count within five seconds, without a reload, and stops reading once the switch is over', async () => {
    jest.useFakeTimers();
    const { container } = open();
    let done = 3;
    let over = false;
    world.status = () =>
      embedding({
        job: over
          ? { target: 'gemini:embedder', state: 'cancelled', done, total: 10, error: null }
          : { target: 'gemini:embedder', state: 'running', done, total: 10, error: null },
      });
    await until(() => expect(text(line(container))).toContain('3 of 10 memories'));
    const reads = () => stub?.callsTo('bureau.memory.embedding').length ?? 0;

    done = 7;
    jest.advanceTimersByTime(5_000);
    await until(() => expect(text(line(container))).toContain('7 of 10 memories'));

    over = true;
    jest.advanceTimersByTime(5_000);
    await until(() => expect(line(container)?.getAttribute('data-state')).toBe('canceled'));
    const settled = reads();
    jest.advanceTimersByTime(30_000);
    await settle(20);
    expect(reads()).toBe(settled);
  });
});
