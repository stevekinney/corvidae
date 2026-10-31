/**
 * One worker's diagnostics inside its detail: the read is narrowed by the worker's id, a clean
 * worker says so, a task opens its ledger, and a failed read is a failure with a way to read again.
 */
import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { diagnosticItem, EMPTY_DIAGNOSTICS_SUMMARY } from './index-actions.test-support.ts';
import TaskEvidenceHarness from './task-evidence-harness.test-harness.svelte';
import WorkerDiagnosticsSection from './worker-diagnostics-section.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderSection(onInspectTask: (operationId: string) => void = () => {}) {
  return render(TaskEvidenceHarness, {
    props: {
      client: realClient(),
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      component: WorkerDiagnosticsSection,
      componentProps: { workerId: 'wkr_1', onInspectTask, now: 1_700_000_100_000 },
    },
  });
}

/** The `workerId` each diagnostics read carried. */
function workerIdsRead(script: ScriptedFetch): unknown[] {
  return script.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    const body = parseJsonObject(call.init.body);
    const params = body?.['params'];
    return body?.['method'] === 'weft.tasks.diagnostics' &&
      params !== null &&
      typeof params === 'object'
      ? [Reflect.get(params, 'workerId')]
      : [];
  });
}

describe('WorkerDiagnosticsSection', () => {
  test('asks the server for this worker’s diagnostics only, and lists what it reports', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [diagnosticItem({ operationId: 'op_dead_1', workerId: 'wkr_1' })],
      summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    const opened: string[] = [];

    const view = renderSection((operationId) => opened.push(operationId));

    await fireEvent.click(await view.findByRole('button', { name: 'Inspect ledger' }));
    expect(opened).toEqual(['op_dead_1']);
    expect(workerIdsRead(scripted)).toEqual(['wkr_1']);
  });

  test('a worker with nothing to report says so instead of showing an empty list', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: EMPTY_DIAGNOSTICS_SUMMARY,
    });

    const view = renderSection();

    expect(await view.findByText('No diagnostics for this worker')).not.toBeNull();
  });

  test('a failed read is shown as a fault, and Retry reads again', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethodError(
      'weft.tasks.diagnostics',
      401,
      'authentication required',
      'Unauthorized',
    );

    const view = renderSection();

    expect(await view.findByText('Not authorized')).not.toBeNull();
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: EMPTY_DIAGNOSTICS_SUMMARY,
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    expect(await view.findByText('No diagnostics for this worker')).not.toBeNull();
  });
});
