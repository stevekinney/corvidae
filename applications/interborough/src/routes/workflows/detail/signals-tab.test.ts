import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';

import SignalsTabHarness from './signals-tab.test-harness.svelte';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'signal-stepped',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('SignalsTab', () => {
  test('shows an empty message when no signal has been delivered to a wait point', async () => {
    const client = {
      operations: {
        'weft.workflows.signal': async () => ({ ok: true as const }),
        'weft.workflows.timeline.get': async (): Promise<WorkflowTimelineEntry[]> => [],
      },
    };

    const { getByText } = render(SignalsTabHarness, {
      props: { client, workflow: workflow() },
    });

    await waitFor(() => {
      expect(getByText('No signals delivered to a wait point yet.')).not.toBeNull();
    });
  });

  test('lists wait-signal timeline entries as received signals', async () => {
    const client = {
      operations: {
        'weft.workflows.signal': async () => ({ ok: true as const }),
        'weft.workflows.timeline.get': async (): Promise<WorkflowTimelineEntry[]> => [
          {
            step: 1,
            operationType: 'wait-signal',
            operationLabel: 'advance',
            inputSummary: '{}',
            timestamp: 1_000,
            status: 'completed',
          },
        ],
      },
    };

    const { getByText } = render(SignalsTabHarness, {
      props: { client, workflow: workflow() },
    });

    await waitFor(() => {
      expect(getByText('advance')).not.toBeNull();
    });
  });

  test('sends a signal with the entered name and JSON payload', async () => {
    const sent: unknown[] = [];
    const client = {
      operations: {
        'weft.workflows.signal': async (input: unknown) => {
          sent.push(input);
          return { ok: true as const };
        },
        'weft.workflows.timeline.get': async (): Promise<WorkflowTimelineEntry[]> => [],
      },
    };

    const { getByLabelText, getByRole } = render(SignalsTabHarness, {
      props: { client, workflow: workflow() },
    });

    await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'addItem' } });
    await fireEvent.input(getByLabelText('Payload'), { target: { value: '{"sku":"ABC-123"}' } });
    await fireEvent.click(getByRole('button', { name: 'Send signal' }));

    expect(sent).toEqual([
      { workflowId: 'wf_1', signalName: 'addItem', payload: { sku: 'ABC-123' } },
    ]);

    await waitFor(() => expect((getByLabelText('Signal name') as HTMLInputElement).value).toBe(''));
    await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'advance' } });
    await fireEvent.click(getByRole('button', { name: 'Send signal' }));
    expect(sent[1]).toEqual({ workflowId: 'wf_1', signalName: 'advance' });
  });

  test('rejects invalid JSON payloads without sending the catalog operation', async () => {
    const outcome: { called: boolean } = { called: false };
    const client = {
      operations: {
        'weft.workflows.signal': async () => {
          outcome.called = true;
          return { ok: true as const };
        },
        'weft.workflows.timeline.get': async (): Promise<WorkflowTimelineEntry[]> => [],
      },
    };

    const { getByLabelText, getByRole, getByText } = render(SignalsTabHarness, {
      props: { client, workflow: workflow() },
    });

    await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'addItem' } });
    await fireEvent.input(getByLabelText('Payload'), { target: { value: '{not json' } });
    await fireEvent.click(getByRole('button', { name: 'Send signal' }));

    expect(outcome.called).toBe(false);
    expect(getByText(/Payload must be valid JSON/)).not.toBeNull();
  });

  test('disables Send signal when the principal lacks signals:write', async () => {
    const outcome: { called: boolean } = { called: false };
    const client = {
      operations: {
        'weft.workflows.signal': async () => {
          outcome.called = true;
          return { ok: true as const };
        },
        'weft.workflows.timeline.get': async (): Promise<WorkflowTimelineEntry[]> => [],
      },
    };

    const { getByLabelText, getByRole } = render(SignalsTabHarness, {
      props: {
        client,
        workflow: workflow(),
        sendGate: { disabled: true, title: 'Requires signals:write' },
      },
    });

    await fireEvent.input(getByLabelText('Signal name'), { target: { value: 'addItem' } });
    const send = getByRole('button', { name: 'Send signal' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(send);
    expect(outcome.called).toBe(false);
  });
});
