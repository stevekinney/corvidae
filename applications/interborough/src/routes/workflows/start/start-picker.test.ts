/**
 * `/runs?view=start`: the picker lists the workflows a person can run, goes to the chosen one's
 * run setup page, starts nothing itself, and says so when there is nothing to run.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../../app/copy.ts';
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
  router.navigate('/runs?view=start', { replace: true });
  return render(Harness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

describe('the start picker', () => {
  test('offers the workflows that can run, each a link to its run setup page', async () => {
    const { findByRole } = open();
    const list = await findByRole('list', { name: COPY.listLabel });
    const links = [...list.querySelectorAll('a')];
    expect(links.map((link) => link.textContent?.trim())).toEqual(['digest', 'order-processing']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/workflows/digest/run',
      '/workflows/order-processing/run',
    ]);
  });

  test('goes to the chosen workflow’s run setup page, and starts nothing', async () => {
    const { findByRole } = open();
    await fireEvent.click(await findByRole('link', { name: 'order-processing' }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/order-processing/run'));
    expect(stub?.world.engineStarts).toEqual([]);
    expect(stub?.world.startedRuns).toEqual([]);
  });

  test('offers no filter for a short list', async () => {
    const { findByRole, queryByRole } = open();
    await findByRole('list', { name: COPY.listLabel });
    expect(queryByRole('searchbox', { name: COPY.filterLabel })).toBeNull();
  });

  test('filters a long list by name and description, and says when nothing matches', async () => {
    const many = Array.from({ length: 9 }, (_, index) => codeDefinition(`flow-${String(index)}`));
    const { findByRole, getByRole, getByText } = open({ definitions: many, files: [] });
    const filter = await findByRole('searchbox', { name: COPY.filterLabel });
    await fireEvent.input(filter, { target: { value: 'flow-4' } });
    await waitFor(() =>
      expect(
        [...getByRole('list', { name: COPY.listLabel }).querySelectorAll('a')].map((link) =>
          link.textContent?.trim(),
        ),
      ).toEqual(['flow-4']),
    );
    await fireEvent.input(filter, { target: { value: 'nothing like it' } });
    expect(await findByRole('heading', { level: 2, name: COPY.noMatchTitle })).not.toBeNull();
    await fireEvent.click(getByText('Clear filters'));
    expect(await findByRole('list', { name: COPY.listLabel })).not.toBeNull();
  });

  test('goes back to the runs with Cancel', async () => {
    const { findByRole } = open();
    await findByRole('list', { name: COPY.listLabel });
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
    expect(await findByRole('list', { name: COPY.listLabel })).not.toBeNull();
  });
});
