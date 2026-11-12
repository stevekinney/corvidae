/**
 * `/runs/new`: the picker offers the workflows a person built in one required field, goes to the
 * chosen one's run setup page, starts nothing itself, focuses the field when Continue is pressed
 * with nothing picked, and says so when there is nothing to run.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../../app/copy/workflows.ts';
import Harness from '../../../app/shell/route-outlet.test-harness.svelte';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  workflowFaults,
  type WorkflowStub,
  type World,
} from '../../../lib/workflow-world.test-support.ts';

const COPY = WORKFLOW_COPY.runPicker;
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

function open(overrides: Partial<World> = {}, before?: (installed: WorkflowStub) => void) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [codeDefinition('order-processing'), codeDefinition('agentRun')],
      files: [readyFile('digest'), readyFile('later', { paused: true }), invalidFile('broken')],
      ...overrides,
    }),
  );
  before?.(stub);
  router.navigate('/runs/new', { replace: true });
  return render(Harness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

describe('the start picker', () => {
  test('is headed Start a run, with its sentence and a required Workflow field', async () => {
    const { findByRole, getByText } = open();
    expect(await findByRole('heading', { level: 1, name: COPY.title })).not.toBeNull();
    expect(getByText(COPY.description)).not.toBeNull();
    const field = (await findByRole('combobox', { name: COPY.fieldLabel })) as HTMLSelectElement;
    expect(field.required).toBe(true);
    expect(field.value).toBe('');
  });

  test('offers the workflows you built, paused and unloadable ones off with their reason', async () => {
    const { findByRole } = open();
    const field = (await findByRole('combobox', { name: COPY.fieldLabel })) as HTMLSelectElement;
    const options = [...field.querySelectorAll('option')].map((option) => ({
      label: option.textContent?.trim(),
      disabled: option.disabled,
    }));
    expect(options).toEqual([
      { label: COPY.fieldPlaceholder, disabled: false },
      { label: `broken (${COPY.invalidReason})`, disabled: true },
      { label: 'digest', disabled: false },
      { label: `later (${COPY.pausedReason})`, disabled: true },
      { label: 'order-processing', disabled: false },
    ]);
    expect(options.some((option) => option.label?.includes('agentRun'))).toBe(false);
  });

  test('Continue goes to the chosen workflow’s run setup page, and starts nothing', async () => {
    const { findByRole } = open();
    const field = await findByRole('combobox', { name: COPY.fieldLabel });
    await fireEvent.change(field, { target: { value: 'order-processing' } });
    await fireEvent.click(await findByRole('button', { name: COPY.continue }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/order-processing/run'));
    expect(stub?.world.engineStarts).toEqual([]);
    expect(stub?.world.startedRuns).toEqual([]);
  });

  test('Continue with nothing picked stays enabled, focuses the field and says what is missing', async () => {
    const { findByRole, findByText } = open();
    const field = await findByRole('combobox', { name: COPY.fieldLabel });
    const button = (await findByRole('button', { name: COPY.continue })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    expect(await findByText(COPY.pickError)).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(router.pathname).toBe('/runs/new');
  });

  test('picking a workflow clears the message', async () => {
    const { findByRole, findByText, queryByText } = open();
    const field = await findByRole('combobox', { name: COPY.fieldLabel });
    await fireEvent.click(await findByRole('button', { name: COPY.continue }));
    await findByText(COPY.pickError);
    await fireEvent.change(field, { target: { value: 'digest' } });
    await waitFor(() => expect(queryByText(COPY.pickError)?.outerHTML ?? null).toBeNull());
  });

  test('goes back to the runs with Cancel', async () => {
    const { findByRole } = open();
    await fireEvent.click(await findByRole('link', { name: COPY.cancel }));
    await waitFor(() => expect(router.pathname).toBe('/runs'));
  });

  test('says nothing can run yet, with a way to make a workflow', async () => {
    const { findByRole } = open({ definitions: [codeDefinition('agentRun')], files: [] });
    expect(await findByRole('heading', { level: 2, name: COPY.emptyTitle })).not.toBeNull();
    const action = await findByRole('link', { name: COPY.emptyAction });
    expect(action.getAttribute('href')).toBe('/workflows/new');
    await fireEvent.click(action);
    await waitFor(() => expect(router.pathname).toBe('/workflows/new'));
  });

  test('says the workflows could not be loaded, and loads them again on retry', async () => {
    let reads = 0;
    const { findByText, findByRole, getByRole } = open({}, (installed) => {
      installed.on('weft.workflows.definitions.list', () => {
        reads += 1;
        if (reads === 1) throw workflowFaults.unavailable();
        return { definitions: [{ ...codeDefinition('order-processing') }] };
      });
    });
    expect(await findByText(COPY.loadFailedTitle)).not.toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    expect(await findByRole('combobox', { name: COPY.fieldLabel })).not.toBeNull();
  });
});
