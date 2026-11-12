/**
 * `/workflows/:workflow/edit` (board PageWorkflowBuilder, "Edit workflow" and its states): the
 * builder over a file, saved through `bureau.workflows.update` against the hash the form was filled
 * from. The file's `name` is stripped before the update, because the update schema rejects keys it
 * does not know. Text that is not JSON saves nothing and takes the person to the line to fix; a
 * document the Bureau refuses shows its words above the footer. While the draft differs from the
 * file, the version a save makes is said above the footer (`bureau.workflows.impact`). A file that
 * changed on disk is "This file changed on disk." with Reload and Keep mine. An invalid file opens
 * on the JSON tab with where it stops being a workflow above it, so it can be fixed.
 */
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { STUB_REMOTE_WORKFLOW_DIRECTORY, StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import {
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  sourceDefinition,
  STUB_WORKFLOW_DIRECTORY,
  workflowFaults,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import Harness from './area-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;
const monitors: ConnectionMonitor[] = [];

const EDITOR = WORKFLOW_COPY.editor;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  for (const monitor of monitors.splice(0)) monitor.dispose();
  focusManager.setFocused(undefined);
});

function open(path: string, overrides: Partial<World> = {}, connection?: ConnectionMonitor) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [sourceDefinition('digest')],
      files: [readyFile('digest'), invalidFile('broken')],
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(Harness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES, connection },
  } as never);
}

const editorOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-page="workflow-editor"]');

/** The editor, once the file has been read and the editor filled, or its problem shown. */
async function ready(container: HTMLElement): Promise<HTMLElement> {
  // The heading and the tabs show while the file loads; the form is there once it has loaded.
  await waitFor(() =>
    expect(editorOf(container)?.dataset['condition'] ?? 'loading').not.toBe('loading'),
  );
  await waitFor(() =>
    expect(
      editorOf(container)?.querySelector('[role="tab"], [data-testid="workflow-problem"]'),
    ).toBeTruthy(),
  );
  const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === WORKFLOW_COPY.builder.jsonTab,
  );
  // The JSON tab holds the editor these specifications type into.
  if (tab !== undefined) {
    await fireEvent.click(tab);
    await waitFor(() => expect(textarea(container)).toBeTruthy());
  }
  return editorOf(container) as HTMLElement;
}

const textarea = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;

async function typeInto(container: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(textarea(container), { target: { value } });
}

const parsed = (text: string | null): Record<string, unknown> =>
  JSON.parse(text ?? 'null') as Record<string, unknown>;

const tabNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLElement;

/** The footer's sentence: the read-back, the version a save makes, or the line to fix. */
const footer = (container: HTMLElement) =>
  container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent?.trim() ?? '';

/** A breaking change from 1.3.0 to 1.4.0, as `bureau.workflows.impact` answers it (row 65t). */
const BREAKING = {
  version: '1.4.0',
  previousVersion: '1.3.0',
  changes: [
    { kind: 'step-signal', step: 2, from: 'approve', to: 'release-approved', breaking: true },
  ],
  compatibility: 'breaking',
  inFlight: 0,
};

/** Changes the signal step 2 waits for, in the JSON tab, so the draft differs from the file. */
async function changeTheSignal(container: HTMLElement): Promise<void> {
  const edited = parsed(textarea(container).value);
  edited['steps'] = [
    { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Write it.' } },
    { kind: 'await-signal', signal: 'release-approved' },
  ];
  await typeInto(container, JSON.stringify(edited, null, 2));
}

/** A promise the test settles by hand, for an answer that must stay pending for a while. */
function held<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe('the editor', () => {
  test('opens with the file’s text and its path, and has no action to leave unsaved', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    const root = await ready(container);

    // A file with no title is named by its identifier.
    expect(root.querySelector('h1')?.textContent).toContain(EDITOR.heading('digest'));
    expect(parsed(textarea(container).value)['name']).toBe('digest');
    expect(root.querySelector('[data-testid="workflow-file-path"]')?.textContent).toBe(
      `${STUB_WORKFLOW_DIRECTORY}/digest.json`,
    );
    expect(getByRole('button', { name: EDITOR.saveAction })).not.toBeNull();
  });

  test('is headed by the file’s title, with Save as its one primary action (row 65p)', async () => {
    const { container, getByRole } = open('/workflows/digest/edit', {
      files: [readyFile('digest', { title: 'Release notes' })],
    });
    const root = await ready(container);
    expect(root.querySelector('h1')?.textContent).toContain('Edit Release notes');
    expect(getByRole('button', { name: 'Save' })).not.toBeNull();
    expect(getByRole('button', { name: EDITOR.cancelAction })).not.toBeNull();
  });

  test('saves the document without its name, against the hash it read, and lands on the workflow', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    const edited = parsed(textarea(container).value);
    edited['trigger'] = { kind: 'schedule', spec: '2h' };
    await typeInto(container, JSON.stringify(edited));
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    const call = stub?.callsTo('bureau.workflows.update')[0];
    expect(call?.params['id']).toBe('digest');
    expect(call?.params['expectedHash']).toBe('hash-1');
    const definition = call?.params['definition'] as Record<string, unknown>;
    expect(definition).not.toHaveProperty('name');
    expect(definition['trigger']).toEqual({ kind: 'schedule', spec: '2h' });
    expect(definition['agent']).toBe('writer');
  });

  test('says the line to fix for text that is not JSON, keeps Save on, and saves nothing', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await typeInto(container, '{ "trigger": ');
    const save = getByRole('button', { name: EDITOR.saveAction }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);

    await waitFor(() => expect(footer(container)).toBe(WORKFLOW_COPY.builder.json.fixLine(1)));
    expect(tabNamed(container, WORKFLOW_COPY.builder.builderTab).hasAttribute('disabled')).toBe(
      true,
    );
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
    expect(router.pathname).toBe('/workflows/digest/edit');
  });

  test('says the line to fix for JSON that is not an object, and saves nothing', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await typeInto(container, '[1, 2]');
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(footer(container)).toBe(WORKFLOW_COPY.builder.json.fixLine(1)));
    expect(container.textContent).toContain(WORKFLOW_COPY.builder.json.notWorkflow);
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
  });

  test('shows the Bureau’s words for a document it refuses, and the file is unchanged', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    stub?.on('bureau.workflows.update', () => {
      throw workflowFaults.unprocessable('trigger.spec: Not a schedule specification.');
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));

    expect(await findByText(/Not a schedule specification\./)).not.toBeNull();
    expect(await findByText(EDITOR.saveFailed('digest'))).not.toBeNull();
    expect(router.pathname).toBe('/workflows/digest/edit');
    expect(stub?.file('digest')?.hash).toBe('hash-1');
  });

  test('is the not-found state when the file is gone', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    if (stub !== undefined) stub.world.files = [];
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await findByRole('heading', { level: 1, name: /doesn’t exist/i });
    await waitFor(() =>
      expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
  });

  test('cancel goes back to the workflow, without saving', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await fireEvent.click(getByRole('button', { name: EDITOR.cancelAction }));
    expect(router.pathname).toBe('/workflows/digest');
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
  });
});

describe('the version a save makes', () => {
  test('asks what saving the draft would do, and says a breaking change above the footer (row 65t)', async () => {
    const { container } = open('/workflows/digest/edit', { impacts: { digest: BREAKING } });
    await ready(container);
    // An untouched form makes no version, so it asks nothing and the footer reads the workflow back.
    expect(stub?.callsTo('bureau.workflows.impact')).toEqual([]);

    await changeTheSignal(container);
    const notice = await waitFor(() => {
      const found = container.querySelector('[data-testid="workflow-editor-impact"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(notice.textContent).toContain('Saving makes version 1.4.0. This is a breaking change.');
    expect(notice.textContent).toContain(
      'Step 2 now waits for release-approved instead of approve.',
    );
    expect(notice.textContent).toContain(EDITOR.impact.noneInFlight);
    expect(notice.textContent).toContain('Later runs use 1.4.0.');
    expect(notice.textContent).toContain(EDITOR.impact.renameNote);
    expect(footer(container)).toBe('Save as version 1.4.0.');

    const call = stub?.callsTo('bureau.workflows.impact').at(-1);
    expect(call?.params['id']).toBe('digest');
    const definition = call?.params['definition'] as Record<string, unknown>;
    expect(definition).not.toHaveProperty('name');
    expect(definition['steps']).toEqual([
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Write it.' } },
      { kind: 'await-signal', signal: 'release-approved' },
    ]);
  });

  test('says a compatible change in one line', async () => {
    const { container } = open('/workflows/digest/edit', {
      impacts: {
        digest: { ...BREAKING, changes: [], compatibility: 'compatible' },
      },
    });
    await ready(container);
    await changeTheSignal(container);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-editor-impact"]')?.textContent?.trim(),
      ).toBe(EDITOR.impact.compatible('1.4.0')),
    );
  });

  test('asks again when the draft changes, and has no notice once the draft is the file again', async () => {
    const { container } = open('/workflows/digest/edit', { impacts: { digest: BREAKING } });
    await ready(container);
    const original = textarea(container).value;
    await changeTheSignal(container);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="workflow-editor-impact"]')).toBeTruthy(),
    );
    const asked = stub?.callsTo('bureau.workflows.impact').length ?? 0;

    const edited = parsed(textarea(container).value);
    edited['description'] = 'Collects merged changes into a draft.';
    await typeInto(container, JSON.stringify(edited, null, 2));
    await waitFor(() =>
      expect(stub?.callsTo('bureau.workflows.impact').length ?? 0).toBeGreaterThan(asked),
    );

    await typeInto(container, original);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-editor-impact"]')?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(footer(container)).not.toContain('Save as version');
  });

  test('never says the version an earlier draft made while a newer one is typed', async () => {
    const { container } = open('/workflows/digest/edit', { impacts: { digest: BREAKING } });
    await ready(container);
    await changeTheSignal(container);
    await waitFor(() => expect(footer(container)).toBe('Save as version 1.4.0.'));
    if (stub !== undefined) stub.world.impacts['digest'] = { ...BREAKING, version: '1.5.0' };

    const edited = parsed(textarea(container).value);
    edited['description'] = 'Collects merged changes into a draft.';
    await typeInto(container, JSON.stringify(edited, null, 2));
    // The answer for the earlier draft is gone as soon as the text changes, before it settles.
    expect(footer(container)).not.toContain('1.4.0');
    expect(
      container.querySelector('[data-testid="workflow-editor-impact"]')?.outerHTML ?? null,
    ).toBeNull();
    await waitFor(() => expect(footer(container)).toBe('Save as version 1.5.0.'));
  });

  test('reads Saving with the version while it writes, with Cancel off, and lands on the workflow (row 65v)', async () => {
    const { container, getByRole } = open('/workflows/digest/edit', {
      impacts: { digest: BREAKING },
    });
    await ready(container);
    await changeTheSignal(container);
    await waitFor(() => expect(footer(container)).toBe('Save as version 1.4.0.'));

    const answer = held<{ id: string; hash: string }>();
    stub?.on('bureau.workflows.update', () => answer.promise);
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));

    const saving = await waitFor(() => {
      const found = getByRole('button', { name: EDITOR.savingAction }) as HTMLButtonElement;
      expect(found.disabled).toBe(true);
      return found;
    });
    expect(saving).toBeTruthy();
    expect((getByRole('button', { name: EDITOR.cancelAction }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(footer(container)).toBe('Saving version 1.4.0…');
    expect(container.querySelector('.weft-workflow-builder__json')?.hasAttribute('inert')).toBe(
      true,
    );

    answer.settle({ id: 'digest', hash: 'hash-saved' });
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
  });

  test('says a failed write above the footer, keeps what was typed, and Save is the retry (row 65w)', async () => {
    const { container, getByRole, queryByRole } = open('/workflows/digest/edit', {
      files: [readyFile('digest', { title: 'Release notes' })],
      impacts: { digest: BREAKING },
    });
    await ready(container);
    await changeTheSignal(container);
    await waitFor(() => expect(footer(container)).toBe('Save as version 1.4.0.'));
    const typed = textarea(container).value;

    stub?.on('bureau.workflows.update', () => {
      throw workflowFaults.unprocessable(
        'release-notes.json couldn’t be written: permission denied.',
      );
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));

    await waitFor(() => expect(container.textContent).toContain('Couldn’t save Release notes.'));
    expect(container.textContent).toContain(
      'release-notes.json couldn’t be written: permission denied. Nothing was saved.',
    );
    expect(footer(container)).toBe('Save as version 1.4.0.');
    expect(textarea(container).value).toBe(typed);
    expect(queryByRole('button', { name: 'Try again' })).toBeNull();

    // Save is the retry.
    stub?.on('bureau.workflows.update', () => ({ id: 'digest', hash: 'hash-saved' }));
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
  });
});

describe('a file that changed on disk', () => {
  test('says so when a save finds it changed, writes nothing until a choice, and Reload discards the edits (row 65x)', async () => {
    const { container, findByRole, getByRole, queryByRole } = open('/workflows/digest/edit');
    const root = await ready(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    file.text = JSON.stringify({
      name: 'digest',
      trigger: { kind: 'schedule', spec: '9h' },
      steps: [],
    });

    await typeInto(container, '{"trigger":{"kind":"schedule","spec":"1h"},"steps":[]}');
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    const reload = await findByRole('button', { name: EDITOR.changedOnDisk.reload });
    expect(root.querySelector('[data-testid="workflow-editor-changed"]')?.textContent).toContain(
      EDITOR.changedOnDisk.title,
    );
    expect(root.dataset['condition']).toBe('stale');
    expect(stub?.file('digest')?.hash).toBe('hash-by-hand');

    // Nothing is written until the person chooses.
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    expect(stub?.callsTo('bureau.workflows.update')).toHaveLength(1);

    await fireEvent.click(reload);
    await waitFor(() =>
      expect(
        queryByRole('button', { name: EDITOR.changedOnDisk.reload })?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(textarea(container).value).toContain('9h');
    expect(textarea(container).value).not.toContain('"1h"');

    // The next save names the hash that was reloaded.
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    expect(stub?.callsTo('bureau.workflows.update').at(-1)?.params['expectedHash']).toBe(
      'hash-by-hand',
    );
  });

  test('says so when the window takes focus, and Keep mine writes the form over the file', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await typeInto(container, '{"trigger":{"kind":"schedule","spec":"1h"},"steps":[]}');
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    file.text = JSON.stringify({
      name: 'digest',
      trigger: { kind: 'schedule', spec: '9h' },
      steps: [],
    });

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await fireEvent.click(await findByRole('button', { name: EDITOR.changedOnDisk.keepMine }));
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-editor-changed"]')?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(textarea(container).value).toContain('"1h"');

    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    const call = stub?.callsTo('bureau.workflows.update').at(-1);
    expect(call?.params['expectedHash']).toBe('hash-by-hand');
    expect(call?.params['definition']).toHaveProperty('trigger', {
      kind: 'schedule',
      spec: '1h',
    });
  });

  test('says no version while the file changed, and Keep mine asks again what saving would do', async () => {
    const { container, findByRole } = open('/workflows/digest/edit', {
      impacts: { digest: { ...BREAKING, changes: [], compatibility: 'compatible' } },
    });
    await ready(container);
    await changeTheSignal(container);
    await waitFor(() => expect(footer(container)).toBe('Save as version 1.4.0.'));
    const asked = stub?.callsTo('bureau.workflows.impact').length ?? 0;

    // Someone else saves a file over which this draft is a breaking change to a new version.
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    if (stub !== undefined) {
      stub.world.impacts['digest'] = { ...BREAKING, version: '2.0.0', previousVersion: '1.4.0' };
    }

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    const keepMine = await findByRole('button', { name: EDITOR.changedOnDisk.keepMine });
    // The answer was for the file the form was filled from, so it is not said over the new one.
    expect(
      container.querySelector('[data-testid="workflow-editor-impact"]')?.outerHTML ?? null,
    ).toBeNull();
    expect(footer(container)).not.toContain('Save as version');
    expect(stub?.callsTo('bureau.workflows.impact')).toHaveLength(asked);

    await fireEvent.click(keepMine);
    await waitFor(() =>
      expect(stub?.callsTo('bureau.workflows.impact').length ?? 0).toBeGreaterThan(asked),
    );
    await waitFor(() => expect(footer(container)).toBe('Save as version 2.0.0.'));
    expect(
      container.querySelector('[data-testid="workflow-editor-impact"]')?.textContent,
    ).toContain('Saving makes version 2.0.0. This is a breaking change.');
  });
});

describe('an invalid file', () => {
  test('opens on the JSON tab with its problem, its issues, and its path above it', async () => {
    const { container } = open('/workflows/broken/edit');
    const root = await ready(container);
    expect(root.dataset['condition']).toBe('invalid');
    expect(
      root
        .querySelector('[data-testid="workflow-problem"]')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      `${EDITOR.invalid.sentence('broken.json', 'The document is not a workflow')} ${EDITOR.invalid.fix}`,
    );
    expect(root.querySelector('[data-testid="workflow-issues"]')?.textContent).toContain(
      'trigger.spec',
    );
    expect(root.querySelector('[data-testid="workflow-file-path"]')?.textContent).toBe(
      `${STUB_WORKFLOW_DIRECTORY}/broken.json`,
    );
    expect(textarea(container).value).toContain('"never"');
  });

  test('opens on the JSON tab even when its JSON parses', async () => {
    const { container } = open('/workflows/broken/edit');
    await waitFor(() =>
      expect(editorOf(container)?.dataset['condition'] ?? 'loading').toBe('invalid'),
    );
    await waitFor(() =>
      expect(tabNamed(container, WORKFLOW_COPY.builder.jsonTab).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });

  test('opens a file whose JSON is broken on the JSON tab, says the line, and Save goes to it (rows 66e, 66f)', async () => {
    const broken = [
      '{',
      '  "name": "order-refund",',
      '  "trigger": { "kind": "manual" }',
      '  "steps": []',
      '}',
    ].join('\n');
    const { container, getByRole } = open('/workflows/order-refund/edit', {
      files: [
        invalidFile('order-refund', {
          text: broken,
          problem: { code: 'invalid-json', message: 'Unexpected string.', issues: null },
        }),
      ],
    });
    await waitFor(() =>
      expect(editorOf(container)?.dataset['condition'] ?? 'loading').toBe('invalid'),
    );
    const root = editorOf(container) as HTMLElement;

    // The file has no title, so the identifier shows.
    expect(root.querySelector('h1')?.textContent).toContain('Edit order-refund');
    expect(
      root
        .querySelector('[data-testid="workflow-problem"]')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      'order-refund.json can’t be read as a workflow: line 4 expected a comma. Fix it here, or Cancel and open the file in your editor.',
    );
    await waitFor(() =>
      expect(tabNamed(container, WORKFLOW_COPY.builder.jsonTab).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(tabNamed(container, WORKFLOW_COPY.builder.builderTab).hasAttribute('disabled')).toBe(
      true,
    );
    // The comma is missing at the end of line 3; the parser stops at line 4.
    expect(footer(container)).toBe(WORKFLOW_COPY.builder.json.fixLine(3));

    const save = getByRole('button', { name: EDITOR.saveAction }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
    expect(footer(container)).toBe(WORKFLOW_COPY.builder.json.fixLine(3));
  });

  test('can be fixed and saved, and then shows no problem', async () => {
    const { container, getByRole } = open('/workflows/broken/edit');
    await ready(container);
    await typeInto(
      container,
      JSON.stringify({ name: 'broken', trigger: { kind: 'schedule', spec: '1h' }, steps: [] }),
    );
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/broken'));
    expect(stub?.callsTo('bureau.workflows.update')[0]?.params['expectedHash']).toBe('hash-bad');
    expect(stub?.file('broken')?.state).toBe('ready');
  });

  test('says the file changed on disk once it is fixed outside, and Reload shows the form', async () => {
    const { container, findByRole } = open('/workflows/broken/edit');
    const root = await ready(container);
    const file = stub?.file('broken');
    if (file === undefined) throw new Error('The file is missing.');
    file.state = 'ready';
    file.problem = null;
    file.hash = 'hash-fixed';
    file.text = JSON.stringify({
      name: 'broken',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [],
    });

    // The page reads the file again when the window takes focus.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await fireEvent.click(await findByRole('button', { name: EDITOR.changedOnDisk.reload }));
    await waitFor(() => expect(root.dataset['condition']).toBe('ready'));
    expect(textarea(container).value).toContain('"1h"');
  });

  test('has no editor when the file has no hash, because nothing can be written against it', async () => {
    const { container } = open('/workflows/broken/edit', {
      files: [invalidFile('broken', { hash: null, text: null })],
    });
    const root = await ready(container);
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('[data-testid="workflow-problem"]')).not.toBeNull();
  });
});

describe('while the file loads', () => {
  test('shows the heading and the tabs at once, with Save off (row 65u)', async () => {
    let reads = 0;
    const answer = held<unknown>();
    const { container, getByRole } = open('/workflows/digest/edit');
    const file = stub?.file('digest');
    stub?.on('bureau.workflows.get', () => {
      reads += 1;
      // The frame's probe reads first and finds the file; the page's own read waits.
      return reads === 1 ? file : answer.promise;
    });

    await waitFor(() => expect(editorOf(container)?.dataset['condition']).toBe('loading'));
    const root = editorOf(container) as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain(EDITOR.heading('digest'));
    expect(tabNamed(container, WORKFLOW_COPY.builder.builderTab)).toBeTruthy();
    expect(tabNamed(container, WORKFLOW_COPY.builder.jsonTab)).toBeTruthy();
    expect((getByRole('button', { name: EDITOR.saveAction }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    answer.settle(file);
    await waitFor(() => expect(editorOf(container)?.dataset['condition']).toBe('ready'));
  });
});

describe('a read or a write that fails', () => {
  test('says the workflow could not be loaded when the page’s read fails after the frame’s, and reads again on retry', async () => {
    const { container, findByRole } = open('/workflows/digest/edit');
    let reads = 0;
    const original = stub?.world.files[0];
    stub?.on('bureau.workflows.get', () => {
      reads += 1;
      // The frame's probe reads first and finds the file; the page's read is refused.
      if (reads === 1 || reads > 2) return original;
      throw workflowFaults.unprocessable('Refused.');
    });
    await waitFor(() => expect(container.textContent).toContain(WORKFLOW_COPY.loadFailed.title));
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await ready(container);
    expect(container.textContent).not.toContain(WORKFLOW_COPY.loadFailed.title);
  });

  test('says the installation does not let you, for a forbidden save, and writes nothing', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    stub?.on('bureau.workflows.update', () => {
      throw new StubFault('Forbidden', 403, 'No.');
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    expect(await findByText(WORKFLOW_COPY.forbidden, { exact: false })).not.toBeNull();
    expect(stub?.file('digest')?.hash).toBe('hash-1');
  });

  test('shows the Bureau’s own words when it could not apply a save', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    stub?.on('bureau.workflows.update', () => {
      throw workflowFaults.unavailable();
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    expect(await findByText('The engine did not answer.', { exact: false })).not.toBeNull();
    expect(router.pathname).toBe('/workflows/digest/edit');
  });

  test('is a failure to reload, in words, when the file cannot be read again', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    const reload = await findByRole('button', { name: EDITOR.changedOnDisk.reload });
    stub?.on('bureau.workflows.get', () => {
      throw workflowFaults.unprocessable('Cannot read it.');
    });
    await fireEvent.click(reload);
    await waitFor(() => expect(container.textContent).toContain('Cannot read it.'));
  });

  test('is the not-found state when reloading finds the file gone', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    const reload = await findByRole('button', { name: EDITOR.changedOnDisk.reload });
    if (stub !== undefined) stub.world.files = [];
    await fireEvent.click(reload);
    await waitFor(() =>
      expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
  });

  test('says a file with a hash and no text cannot be edited, and shows its problem', async () => {
    const { container } = open('/workflows/broken/edit', {
      files: [invalidFile('broken', { text: null })],
    });
    const root = await ready(container);
    expect(root.textContent).toContain(EDITOR.unreadable.title);
    expect(root.querySelector('textarea')).toBeNull();
  });
});

describe('a save the Bureau made and the engine could not apply', () => {
  test('is shown as saved but not yet applied, takes the new text and hash, and the next save names them', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    const root = await ready(container);
    let calls = 0;
    stub?.on('bureau.workflows.update', (params) => {
      calls += 1;
      const file = stub?.file('digest');
      if (file === undefined) throw new Error('The file is missing.');
      if (calls === 1) {
        // The Bureau replaced the file, and then the engine could not follow.
        file.text = JSON.stringify({
          name: 'digest',
          trigger: { kind: 'schedule', spec: '3h' },
          steps: [{ kind: 'sleep', duration: '1m' }],
        });
        file.hash = 'hash-written';
        throw workflowFaults.applyFailed();
      }
      return { id: 'digest', hash: `after-${String(params['expectedHash'])}` };
    });
    await typeInto(
      container,
      '{"trigger":{"kind":"schedule","spec":"3h"},"steps":[{"kind":"sleep","duration":"1m"}]}',
    );
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));

    expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
    expect(root.dataset['condition']).toBe('unapplied');
    expect(container.textContent).not.toContain(EDITOR.saveFailed('digest'));
    expect(router.pathname).toBe('/workflows/digest/edit');
    // What is on disk is in the editor, and a retry names its hash instead of the old one.
    await waitFor(() => expect(textarea(container).value).toContain('3h'));
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    expect(stub?.callsTo('bureau.workflows.update').at(-1)?.params['expectedHash']).toBe(
      'hash-written',
    );
  });
});

describe('a save the engine could not apply, and a file that cannot then be read', () => {
  test('says why the page cannot show what is on disk', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    stub?.on('bureau.workflows.update', () => {
      stub?.on('bureau.workflows.get', () => {
        throw workflowFaults.unprocessable('Cannot read it.');
      });
      throw workflowFaults.applyFailed();
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    expect(await findByText('Cannot read it.', { exact: false })).not.toBeNull();
    expect(container.textContent).not.toContain(EDITOR.saveFailed('digest'));
  });
});

describe('the "not applied yet" banner in the editor', () => {
  test('stays while a later save fails for another reason', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    const root = await ready(container);
    let calls = 0;
    stub?.on('bureau.workflows.update', () => {
      calls += 1;
      if (calls === 1) {
        const file = stub?.file('digest');
        if (file === undefined) throw new Error('The file is missing.');
        file.hash = 'hash-written';
        throw workflowFaults.applyFailed();
      }
      throw workflowFaults.unavailable();
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.update').length).toBe(2));
    expect(await findByText(EDITOR.saveFailed('digest'))).not.toBeNull();
    // The first save is still on disk and the engine has still not followed it.
    expect(root.textContent).toContain(WORKFLOW_COPY.applyFailed.title);
  });
});

describe('offline', () => {
  test('says the edits are kept and Save is off, in the edit form’s own words (row 66c)', async () => {
    const monitor = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      // A clock that stands still, so the countdown reads the same however long the test takes.
      now: () => 0,
      browserOffline: true,
    });
    monitors.push(monitor);
    const { container } = open('/workflows/digest/edit', {}, monitor);
    await ready(container);
    monitor.reportUnreachable();

    await waitFor(() => expect(container.textContent).toContain('You’re offline.'));
    expect(container.textContent).toContain(
      'Your edits are kept in the form. Save is off until you’re back. Retrying in 60 s.',
    );
    expect(container.textContent).toContain('Retry now');
    // What was typed stays in the form.
    expect(parsed(textarea(container).value)['name']).toBe('digest');
  });
});

describe.each(['local', 'remote'] as const)('the editor of a workflow on a %s host', (mode) => {
  test('labels the file with the words of its mode, and shows the host’s location verbatim', async () => {
    const { container } = open('/workflows/digest/edit', { hostMode: mode });
    const root = await ready(container);

    const [present, absent] =
      mode === 'remote'
        ? [WORKFLOW_COPY.remote.fileLabel, WORKFLOW_COPY.fileLabel]
        : [WORKFLOW_COPY.fileLabel, WORKFLOW_COPY.remote.fileLabel];
    const label = root.querySelector('.weft-workflow-editor__path span')?.textContent;
    expect(label).toBe(present);
    expect(label).not.toBe(absent);
    await waitFor(() =>
      expect(root.querySelector('[data-testid="workflow-file-path"]')?.textContent).toBe(
        mode === 'remote'
          ? `${STUB_REMOTE_WORKFLOW_DIRECTORY}digest.json`
          : `${STUB_WORKFLOW_DIRECTORY}/digest.json`,
      ),
    );
  });
});

describe('the step builder in the editor', () => {
  const field = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;

  /** The editor, once it is filled and showing the Builder tab. */
  async function builderReady(container: HTMLElement): Promise<void> {
    await ready(container);
    await fireEvent.click(tabNamed(container, WORKFLOW_COPY.builder.builderTab));
    await waitFor(() => expect(field(container, 'workflow-builder-title')).toBeTruthy());
  }

  test('shows the file as rows with a read-only ID, and saves a row edit against the hash it read (row 65p)', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await builderReady(container);
    // The ID is a read-only line, with no field to type in and no Change.
    const idLine = container.querySelector('[data-testid="workflow-builder-id-line"]');
    expect(idLine?.querySelector('code')?.textContent).toBe('digest');
    expect(idLine?.textContent).toContain(WORKFLOW_COPY.builder.idFixed);
    expect(idLine?.querySelector('input, button')).toBeNull();

    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: '3h' },
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    const call = stub?.callsTo('bureau.workflows.update')[0];
    expect(call?.params['expectedHash']).toBe('hash-1');
    const definition = call?.params['definition'] as Record<string, unknown>;
    expect(definition['trigger']).toEqual({ kind: 'schedule', spec: '3h' });
    expect(definition['agent']).toBe('writer');
    expect(definition).not.toHaveProperty('name');
  });

  test('keeps the draft in the builder when the file changed underneath it', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await builderReady(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';

    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: '4h' },
    });
    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await findByRole('button', { name: EDITOR.changedOnDisk.reload });
    expect(field(container, 'workflow-builder-trigger-field').value).toBe('4h');
    expect(stub?.file('digest')?.hash).toBe('hash-by-hand');
  });

  test('registers ⌘Enter on the edit route, which saves, and removes it when the page goes', async () => {
    const { container, unmount } = open('/workflows/digest/edit');
    await builderReady(container);
    const press = (): boolean =>
      shortcuts.handleKey(
        { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
        { routePattern: '/workflows/:workflow/edit', regions: [] },
        Date.now(),
      );

    expect(press()).toBe(true);
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.update')).toHaveLength(1));

    unmount();
    expect(press()).toBe(false);
  });

  test('does not save when the form submits from Enter in a field, only from Save or ⌘Enter', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await builderReady(container);
    const form = container.querySelector('form') as HTMLFormElement;
    const submitted = new window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitted);
    expect(submitted.defaultPrevented).toBe(true);
    expect(form.querySelector('button[type="submit"]')).toBeNull();
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);

    await fireEvent.click(getByRole('button', { name: EDITOR.saveAction }));
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.update')).toHaveLength(1));
  });

  test('marks Save as a control that changes something', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await builderReady(container);
    expect(getByRole('button', { name: EDITOR.saveAction }).hasAttribute('data-changes')).toBe(
      true,
    );
  });
});
