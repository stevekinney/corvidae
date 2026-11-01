import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
import type { DeadLetterTarget } from './dead-letter-guard.ts';
import TaskDeadLetterPanel from './task-dead-letter-panel.svelte';
import TaskEvidenceHarness from './task-evidence-harness.test-harness.svelte';
import type { TaskLedgerDetail } from './worker-catalog-types.ts';
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

const NOW = 1_700_000_000_000;

const TASK: TaskLedgerDetail = {
  state: 'deadLettered',
  operationId: 'op_dead',
  workflowType: 'orders',
  activityName: 'charge',
  queue: 'payments',
  headerKeys: [],
  visibilityTimeoutMilliseconds: 30_000,
  createdAt: NOW - 100_000,
  attempt: 2,
  attempts: [],
  pendingStatus: 'completed',
  resultDigest: 'sha256:result-digest',
  deadLetteredAt: NOW,
  persistenceFailureReason: 'result-resolution-storage-exhausted',
};

const RETAINED = {
  operationId: 'op_dead',
  workflowType: 'orders',
  activityName: 'charge',
  queue: 'payments',
  attempt: 2,
  attemptTokenDigest: 'sha256:t2',
  pendingStatus: 'completed',
  resultDigest: 'sha256:result-digest',
  deadLetteredAt: NOW,
  persistenceFailureReason: 'result-resolution-storage-exhausted',
};

function renderPanel(
  task: TaskLedgerDetail = TASK,
  principalScopes: readonly AuthorizationScope[] = ['system:read', 'system:admin'],
  actions: {
    readonly retrying?: boolean;
    readonly onRetryDeadLetter?: (target: DeadLetterTarget) => void;
    readonly onClearDeadLetter?: (target: DeadLetterTarget) => void;
  } = {},
) {
  return render(TaskEvidenceHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: TaskDeadLetterPanel,
      componentProps: {
        task,
        retrying: actions.retrying ?? false,
        onRetryDeadLetter: actions.onRetryDeadLetter ?? (() => {}),
        onClearDeadLetter: actions.onClearDeadLetter ?? (() => {}),
      },
      principalScopes,
    },
  });
}

function readCalls(script: ScriptedFetch): number {
  return script.calls.filter(
    (call) =>
      typeof call.init?.body === 'string' &&
      parseJsonObject(call.init.body)?.['method'] === 'weft.tasks.deadletters.get',
  ).length;
}

const DEAD_ATTEMPT = {
  attempt: 2,
  attemptTokenDigest: 'sha256:t2',
  claimedAt: NOW - 90_000,
  disposition: 'deadLettered',
  dispositionAt: NOW,
} as const;

describe('TaskDeadLetterPanel — Retry and Clear', () => {
  test('an admin retries or clears this dead letter, which is named with the attempt that was dead-lettered', async () => {
    scripted = new ScriptedFetch();
    const retried: DeadLetterTarget[] = [];
    const cleared: DeadLetterTarget[] = [];
    const task = {
      ...TASK,
      attempts: [
        { ...DEAD_ATTEMPT, attempt: 1, attemptTokenDigest: 'sha256:t1', disposition: 'requeued' },
        DEAD_ATTEMPT,
      ],
    } as const;
    const { getByRole } = renderPanel(task, ['system:read', 'system:admin'], {
      onRetryDeadLetter: (target) => retried.push(target),
      onClearDeadLetter: (target) => cleared.push(target),
    });

    await fireEvent.click(getByRole('button', { name: 'Retry this dead letter' }));
    await fireEvent.click(getByRole('button', { name: 'Clear this dead letter' }));

    const expected = {
      operationId: 'op_dead',
      queue: 'payments',
      activityName: 'charge',
      deadLetteredAt: NOW,
      attemptTokenDigest: 'sha256:t2',
    };
    expect(retried).toEqual([expected]);
    expect(cleared).toEqual([expected]);
    expect(readCalls(scripted)).toBe(0);
  });

  test('both are native buttons a keyboard reaches', () => {
    scripted = new ScriptedFetch();
    const { getByRole } = renderPanel();
    for (const name of ['Retry this dead letter', 'Clear this dead letter']) {
      const button = getByRole('button', { name });
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('tabindex')).not.toBe('-1');
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  test('without system:admin both are disabled, with the reason, and neither acts', () => {
    scripted = new ScriptedFetch();
    const { getByRole } = renderPanel(TASK, ['system:read'], {
      onRetryDeadLetter: () => {
        throw new Error('must not retry without system:admin');
      },
      onClearDeadLetter: () => {
        throw new Error('must not clear without system:admin');
      },
    });
    expect(getByRole('button', { name: 'Retry this dead letter' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(getByRole('button', { name: 'Clear this dead letter' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  test('while a retry of this task is in flight Retry is disabled and cannot send a second one', async () => {
    scripted = new ScriptedFetch();
    const { getByRole } = renderPanel(TASK, ['system:read', 'system:admin'], {
      retrying: true,
      onRetryDeadLetter: () => {
        throw new Error('a retry in flight must not be sent twice');
      },
    });
    const retry = getByRole('button', { name: 'Retry this dead letter' });
    expect(retry.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(retry);
    expect(getByRole('button', { name: 'Clear this dead letter' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  test('a task that is not dead-lettered offers neither', () => {
    scripted = new ScriptedFetch();
    const { queryByRole } = renderPanel({ ...TASK, state: 'queued' });
    expect(queryByRole('button', { name: 'Retry this dead letter' })).toBeNull();
    expect(queryByRole('button', { name: 'Clear this dead letter' })).toBeNull();
  });
});

describe('TaskDeadLetterPanel', () => {
  test('shows the digest, reason, and time without reading the value', () => {
    scripted = new ScriptedFetch();
    const { getByText } = renderPanel();
    expect(getByText('sha256:result-digest')).not.toBeNull();
    expect(getByText('result-resolution-storage-exhausted')).not.toBeNull();
    expect(getByText(new Date(NOW).toISOString())).not.toBeNull();
    expect(readCalls(scripted)).toBe(0);
  });

  test('without system:admin the inspect control is disabled, with the reason, and nothing is read', () => {
    scripted = new ScriptedFetch();
    const { getByRole, getByText } = renderPanel(TASK, ['system:read']);
    const button = getByRole('button', { name: 'Inspect retained result' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(getByText(/to read the retained value/)).not.toBeNull();
    expect(readCalls(scripted)).toBe(0);
  });

  test('an admin reads the retained value only on request and inspects it', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.get', {
      ...RETAINED,
      payload: { kind: 'value', value: { receiptNumber: 'R-77' }, serializedBytes: 24 },
    });
    const { getByRole, findByText } = renderPanel();

    expect(readCalls(scripted)).toBe(0);
    await fireEvent.click(getByRole('button', { name: 'Inspect retained result' }));

    expect(await findByText(/Retained value · 24 B serialized/)).not.toBeNull();
    expect(await findByText('R-77', { exact: false })).not.toBeNull();
    expect(readCalls(scripted)).toBe(1);
  });

  test('an over-limit value is named, not shown', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.get', {
      ...RETAINED,
      payload: {
        kind: 'omitted',
        reason: 'exceeds-max-bytes',
        serializedBytes: 200_000,
        maxBytes: 65_536,
      },
    });
    const { getByRole, findByText } = renderPanel();
    await fireEvent.click(getByRole('button', { name: 'Inspect retained result' }));
    expect(
      await findByText(/over the 64 KB this view reads inline|over the .* this view reads inline/),
    ).not.toBeNull();
  });

  test('an absent value says whether a failure or an empty result was retained', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.get', {
      ...RETAINED,
      pendingStatus: 'failed',
      payload: { kind: 'absent' },
    });
    const failed = renderPanel({ ...TASK, pendingStatus: 'failed' });
    await fireEvent.click(failed.getByRole('button', { name: 'Inspect retained result' }));
    expect(await failed.findByText(/its error text is the whole result/)).not.toBeNull();
    failed.unmount();

    scripted.restore();
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.get', {
      ...RETAINED,
      payload: { kind: 'absent' },
    });
    const empty = renderPanel();
    await fireEvent.click(empty.getByRole('button', { name: 'Inspect retained result' }));
    expect(await empty.findByText(/completed with no value/)).not.toBeNull();
  });

  test('a failed read is a fault with Retry, and Retry reads the retained result again', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethodError(
      'weft.tasks.deadletters.get',
      401,
      'authentication required',
      'Unauthorized',
    );
    const view = renderPanel();
    await fireEvent.click(view.getByRole('button', { name: 'Inspect retained result' }));
    expect(await view.findByText('Not authorized')).not.toBeNull();

    scripted.routeJsonRpcMethod('weft.tasks.deadletters.get', {
      ...RETAINED,
      payload: { kind: 'absent' },
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    expect(await view.findByText(/completed with no value/)).not.toBeNull();
  });

  test('loading, denied, not-retained, malformed, and server-fault states are each explicit', async () => {
    scripted = new ScriptedFetch();
    const pending = scripted.deferJsonRpcMethod('weft.tasks.deadletters.get');
    const loading = renderPanel();
    await fireEvent.click(loading.getByRole('button', { name: 'Inspect retained result' }));
    expect(await loading.findByRole('status', { name: 'Loading retained result' })).not.toBeNull();
    pending.resolve({ ...RETAINED, payload: { kind: 'absent' } });
    scripted.restore();

    const cases: [() => void, string][] = [
      [
        () =>
          scripted?.routeJsonRpcMethodError(
            'weft.tasks.deadletters.get',
            403,
            'forbidden',
            'Forbidden',
          ),
        'Retained result is locked',
      ],
      [
        () =>
          scripted?.routeJsonRpcMethodError('weft.tasks.deadletters.get', 404, 'gone', 'NotFound'),
        'Dead letter no longer retained',
      ],
      [
        () =>
          scripted?.routeJsonRpcMethod('weft.tasks.deadletters.get', { operationId: 'op_dead' }),
        'Malformed server response',
      ],
      [
        () =>
          scripted?.routeJsonRpcMethodError(
            'weft.tasks.deadletters.get',
            401,
            'authentication required',
            'Unauthorized',
          ),
        'Not authorized',
      ],
    ];
    for (const [route, title] of cases) {
      scripted = new ScriptedFetch();
      route();
      const view = renderPanel();
      await fireEvent.click(view.getByRole('button', { name: 'Inspect retained result' }));
      expect(await view.findByText(title)).not.toBeNull();
      view.unmount();
      scripted.restore();
    }
    scripted = undefined;
  });
});
