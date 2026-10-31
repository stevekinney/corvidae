/**
 * Input and output: the workflow's input, its result, why it failed, or that it has not finished.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState } from '@lostgradient/weft';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import RunInputOutput from './run-input-output.svelte';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'order-fulfillment',
    status: 'running',
    input: { orderId: 'ord-1' },
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('Input and output', () => {
  test('running workflow shows the pending-result message, not a result panel', async () => {
    const { getByText, queryByText } = render(RunInputOutput, {
      props: { workflow: workflow({ status: 'running' }) },
    });

    expect(getByText(/Result pending — workflow still running/)).not.toBeNull();
    expect(queryByText('Result')).toBeNull();
  });

  test('completed workflow shows a Result panel', async () => {
    const { getByText } = render(RunInputOutput, {
      props: {
        workflow: workflow({ status: 'completed', result: { ok: true } }),
      },
    });

    expect(getByText('Result')).not.toBeNull();
  });

  test('failed workflow shows the failure-category badge and plain-language explanation', async () => {
    const { getByText } = render(RunInputOutput, {
      props: {
        workflow: workflow({
          status: 'failed',
          failureCategory: 'timeout',
          error: 'the activity took too long',
        }),
      },
    });

    expect(getByText('timeout')).not.toBeNull();
    expect(getByText(/exceeded its configured deadline/)).not.toBeNull();
    expect(getByText('the activity took too long')).not.toBeNull();
  });

  test('cancelled workflow shows a neutral no-result message', async () => {
    const { getByText } = render(RunInputOutput, {
      props: { workflow: workflow({ status: 'cancelled' }) },
    });

    expect(getByText(/no result value/)).not.toBeNull();
  });

  test('timed-out workflow shows a neutral no-result message', async () => {
    const { getByText } = render(RunInputOutput, {
      props: { workflow: workflow({ status: 'timed-out' }) },
    });

    expect(getByText(/timed out/)).not.toBeNull();
  });

  test('a failed workflow with no failure category shows neither the badge nor the explanation', async () => {
    const { getByText, queryByText } = render(RunInputOutput, {
      props: {
        workflow: workflow({ status: 'failed', error: 'boom' }),
      },
    });

    expect(getByText('Failed')).not.toBeNull();
    expect(getByText('boom')).not.toBeNull();
    expect(queryByText(/could not be classified/)).toBeNull();
  });

  test('a failed workflow with an error stack renders a collapsible trigger for it', async () => {
    // Cinder's `Collapsible` toggles via a `transition:` directive whose
    // lifecycle event dispatch happy-dom can't construct cross-realm — no
    // test in this repo drives a transitioning Cinder trigger via
    // `fireEvent.click` (see `advanced-options.test.ts`'s identical note).
    // This only asserts the trigger itself renders (the `errorStack.length >
    // 0` branch), not the post-expand content.
    const { getByRole } = render(RunInputOutput, {
      props: {
        workflow: workflow({
          status: 'failed',
          error: 'boom',
          errorStack: 'Error: boom\n    at doThing (file.ts:1:1)',
        }),
      },
    });

    expect(getByRole('button', { name: 'Show full stack trace' })).not.toBeNull();
  });

  test('a task’s answer is shown as the Markdown it was rendered to, and says when it was cut short', () => {
    const view = render(RunInputOutput, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'working' }),
        answerHtml: '<p>The release is <strong>ready</strong>.</p>',
        answerTruncated: true,
      },
    });

    expect(view.container.querySelector('.ib-run__answer strong')?.textContent).toBe('ready');
    expect(view.getByText('The answer was cut short.')).not.toBeNull();
    expect(view.queryByText('The agent has not answered yet.')).toBeNull();
  });

  test('a task with no answer says whether it is still to come', () => {
    const running = render(RunInputOutput, {
      props: { task: taskFixture({ id: 'run-1', status: 'working' }) },
    });
    expect(running.getByText('The agent has not answered yet.')).not.toBeNull();
    running.unmount();

    const over = render(RunInputOutput, {
      props: { task: taskFixture({ id: 'run-1', status: 'completed' }) },
    });
    expect(over.getByText('The agent finished without a written answer.')).not.toBeNull();
  });

  test('a task that cannot be followed live says so under its answer', () => {
    const view = render(RunInputOutput, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'working' }),
        followState: 'reconnecting',
      },
    });

    expect(view.getByRole('status').textContent).toContain('Reconnecting');
  });

  test('the Bureau’s record of a workflow file’s run shows its trigger, result and error', () => {
    const view = render(RunInputOutput, {
      props: {
        record: {
          id: 'run-1',
          workflow: 'e2e-approval',
          workflowVersion: 'sha256:abc',
          status: 'failed',
          createdAt: '2026-10-31T11:26:19.437Z',
          updatedAt: '2026-10-31T11:26:20.437Z',
          trigger: { kind: 'signal' },
          result: { done: false },
          error: 'The approval was refused.',
        },
      },
    });

    expect(view.getByRole('heading', { level: 3, name: 'Input' })).not.toBeNull();
    expect(view.getByRole('heading', { level: 3, name: 'Result' })).not.toBeNull();
    expect(view.getByText('The approval was refused.')).not.toBeNull();
  });
});
