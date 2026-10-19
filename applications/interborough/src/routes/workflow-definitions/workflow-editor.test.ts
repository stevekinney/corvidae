/**
 * `/workflows/:type/edit`: a file's JSON in Cinder's editor, saved through `bureau.workflows.update`
 * against the hash it was read at. The file's `name` is stripped before the update, because the
 * update schema rejects keys it does not know. Text that is not JSON, and a document the Bureau
 * refuses, show the error and save nothing. A file that changed on disk is the "changed outside
 * Interborough" state, and reloading discards the edits. An invalid file opens in the editor with
 * its problem above it, so it can be fixed.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
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

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(path: string, overrides: Partial<World> = {}) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [sourceDefinition('digest')],
      files: [readyFile('digest'), invalidFile('broken')],
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(Harness, { props: { client: stub.client, scopes: AUTHORIZATION_SCOPES } } as never);
}

const editorOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-page="workflow-editor"]');

/** The editor, once the file has been read and the editor filled, or its problem shown. */
async function ready(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      editorOf(container)?.querySelector('textarea, [data-testid="workflow-problem"]'),
    ).toBeTruthy(),
  );
  return editorOf(container) as HTMLElement;
}

const textarea = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;

async function typeInto(container: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(textarea(container), { target: { value } });
}

const parsed = (text: string | null): Record<string, unknown> =>
  JSON.parse(text ?? 'null') as Record<string, unknown>;

describe('the editor', () => {
  test('opens with the file’s text and its path, and has no action to leave unsaved', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    const root = await ready(container);

    expect(root.querySelector('h1')?.textContent).toContain(WORKFLOW_COPY.editor.heading('digest'));
    expect(parsed(textarea(container).value)['name']).toBe('digest');
    expect(root.querySelector('[data-testid="workflow-file-path"]')?.textContent).toBe(
      `${STUB_WORKFLOW_DIRECTORY}/digest.json`,
    );
    expect(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction })).not.toBeNull();
  });

  test('saves the document without its name, against the hash it read, and lands on the workflow', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    const edited = parsed(textarea(container).value);
    edited['trigger'] = { kind: 'schedule', spec: '2h' };
    await typeInto(container, JSON.stringify(edited));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    const call = stub?.callsTo('bureau.workflows.update')[0];
    expect(call?.params['id']).toBe('digest');
    expect(call?.params['expectedHash']).toBe('hash-1');
    const definition = call?.params['definition'] as Record<string, unknown>;
    expect(definition).not.toHaveProperty('name');
    expect(definition['trigger']).toEqual({ kind: 'schedule', spec: '2h' });
    expect(definition['agent']).toBe('writer');
  });

  test('shows the error for text that is not JSON, and saves nothing', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await typeInto(container, '{ "trigger": ');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));

    expect(await findByText(WORKFLOW_COPY.editor.notJson)).not.toBeNull();
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
    expect(router.pathname).toBe('/workflows/digest/edit');
  });

  test('shows the error for JSON that is not an object, and saves nothing', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await typeInto(container, '[1, 2]');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    expect(await findByText(WORKFLOW_COPY.editor.notObject)).not.toBeNull();
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
  });

  test('shows the Bureau’s words for a document it refuses, and the file is unchanged', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    stub?.on('bureau.workflows.update', () => {
      throw workflowFaults.unprocessable('trigger.spec: Not a schedule specification.');
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));

    expect(await findByText(/Not a schedule specification\./)).not.toBeNull();
    expect(await findByText(WORKFLOW_COPY.editor.saveFailed)).not.toBeNull();
    expect(router.pathname).toBe('/workflows/digest/edit');
    expect(stub?.file('digest')?.hash).toBe('hash-1');
  });

  test('is the changed-outside state when the file changed after the page loaded, and reloading discards the edits', async () => {
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
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    const reload = await findByRole('button', { name: WORKFLOW_COPY.stale.action });
    expect(root.textContent).toContain(WORKFLOW_COPY.stale.title);
    expect(root.dataset['condition']).toBe('stale');
    expect(stub?.file('digest')?.hash).toBe('hash-by-hand');

    await fireEvent.click(reload);
    await waitFor(() =>
      expect(
        queryByRole('button', { name: WORKFLOW_COPY.stale.action })?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(textarea(container).value).toContain('9h');
    expect(textarea(container).value).not.toContain('"1h"');

    // The next save names the hash that was reloaded.
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    expect(stub?.callsTo('bureau.workflows.update').at(-1)?.params['expectedHash']).toBe(
      'hash-by-hand',
    );
  });

  test('is the not-found state when the file is gone', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    if (stub !== undefined) stub.world.files = [];
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    await findByRole('heading', { level: 1, name: /not found/i });
    await waitFor(() =>
      expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
  });

  test('cancel goes back to the workflow, without saving', async () => {
    const { container, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.cancelAction }));
    expect(router.pathname).toBe('/workflows/digest');
    expect(stub?.callsTo('bureau.workflows.update')).toEqual([]);
  });
});

describe('an invalid file', () => {
  test('opens in the editor with its problem, its issues, and its path above it', async () => {
    const { container } = open('/workflows/broken/edit');
    const root = await ready(container);
    expect(root.dataset['condition']).toBe('invalid');
    expect(root.querySelector('[data-testid="workflow-problem"]')?.textContent).toContain(
      'The document is not a workflow.',
    );
    expect(root.querySelector('[data-testid="workflow-issues"]')?.textContent).toContain(
      'trigger.spec',
    );
    expect(root.querySelector('[data-testid="workflow-file-path"]')?.textContent).toBe(
      `${STUB_WORKFLOW_DIRECTORY}/broken.json`,
    );
    expect(textarea(container).value).toContain('"never"');
  });

  test('can be fixed and saved, and then shows no problem', async () => {
    const { container, getByRole } = open('/workflows/broken/edit');
    await ready(container);
    await typeInto(
      container,
      JSON.stringify({ name: 'broken', trigger: { kind: 'schedule', spec: '1h' }, steps: [] }),
    );
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/broken'));
    expect(stub?.callsTo('bureau.workflows.update')[0]?.params['expectedHash']).toBe('hash-bad');
    expect(stub?.file('broken')?.state).toBe('ready');
  });

  test('reloads from disk, and shows the form once the file is fixed outside', async () => {
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

    await fireEvent.click(
      await findByRole('button', { name: WORKFLOW_COPY.editor.invalid.action }),
    );
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
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    expect(await findByText(WORKFLOW_COPY.forbidden)).not.toBeNull();
    expect(stub?.file('digest')?.hash).toBe('hash-1');
  });

  test('shows the Bureau’s own words when it could not apply a save', async () => {
    const { container, findByText, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    stub?.on('bureau.workflows.update', () => {
      throw workflowFaults.unavailable();
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    expect(await findByText('The engine did not answer.')).not.toBeNull();
    expect(router.pathname).toBe('/workflows/digest/edit');
  });

  test('is a failure to reload, in words, when the file cannot be read again', async () => {
    const { container, findByRole, getByRole } = open('/workflows/digest/edit');
    await ready(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    const reload = await findByRole('button', { name: WORKFLOW_COPY.stale.action });
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
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    const reload = await findByRole('button', { name: WORKFLOW_COPY.stale.action });
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
    expect(root.textContent).toContain(WORKFLOW_COPY.editor.unreadable.title);
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
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));

    expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
    expect(root.dataset['condition']).toBe('unapplied');
    expect(container.textContent).not.toContain(WORKFLOW_COPY.editor.saveFailed);
    expect(router.pathname).toBe('/workflows/digest/edit');
    // What is on disk is in the editor, and a retry names its hash instead of the old one.
    await waitFor(() => expect(textarea(container).value).toContain('3h'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
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
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    expect(await findByText('Cannot read it.')).not.toBeNull();
    expect(container.textContent).not.toContain(WORKFLOW_COPY.editor.saveFailed);
  });
});
