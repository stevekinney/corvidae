/**
 * The bar docked under a chat's run that is going (COR-2424, row 06b): "Send a message" sends the
 * words into the run's session (`bureau.contexts.input`), as one input for each message written.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import RunSendMessageHarness from './run-send-message.test-harness.svelte';
import { canSendMessage } from './run-send-message.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

describe('which runs take a message', () => {
  test.each([
    ['a chat run that is working', { kind: 'chat', status: 'working', openWaits: [] }, true],
    [
      'a chat run waiting on a person',
      { kind: 'chat', status: 'input-required', openWaits: [{}] },
      false,
    ],
    ['a chat run that is over', { kind: 'chat', status: 'completed', openWaits: [] }, false],
    [
      'a run that is not a chat’s',
      { kind: 'schedule-fire', status: 'working', openWaits: [] },
      false,
    ],
    ['a run that has not started', { kind: 'chat', status: 'submitted', openWaits: [] }, false],
  ])('%s', (_name, task, expected) => {
    expect(canSendMessage(task)).toBe(expected);
  });
});

describe('the Send a message bar', () => {
  function mount() {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [] }));
    return render(RunSendMessageHarness, {
      props: { contextId: 'session-1', runId: 'run-1' },
    } as never);
  }

  const inputsSent = () =>
    (stub?.callsTo('bureau.contexts.input') ?? []).map((call) => call.params);

  async function send(view: ReturnType<typeof mount>, text: string): Promise<void> {
    await fireEvent.input(view.getByPlaceholderText('Send a message'), { target: { value: text } });
    await fireEvent.click(view.getByRole('button', { name: 'Send' }));
  }

  test('sends the words into the run’s session and empties the field', async () => {
    const view = mount();
    stub?.on('bureau.contexts.input', () => ({
      outcome: 'admitted',
      receipt: { id: 'receipt-1', state: 'queued' },
    }));

    await send(view, 'Also check order 4473');

    await waitFor(() => expect(inputsSent()).toHaveLength(1));
    expect(inputsSent()[0]).toMatchObject({
      contextId: 'session-1',
      input: { payload: 'Also check order 4473' },
    });
    await waitFor(() =>
      expect((view.getByPlaceholderText('Send a message') as HTMLInputElement).value).toBe(''),
    );
  });

  test('keeps Send off until there are words', () => {
    const view = mount();

    expect(view.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });

  test('sends the same words again, after a failure, as the same input, and other words as another', async () => {
    const view = mount();
    let answers = 0;
    stub?.on('bureau.contexts.input', () => {
      answers += 1;
      if (answers < 3) throw new StubFault('Unavailable', 503, 'The Bureau did not answer.');
      return { outcome: 'admitted', receipt: { id: 'receipt-1', state: 'queued' } };
    });

    await send(view, 'First words');
    await waitFor(() => expect(inputsSent()).toHaveLength(1));
    await waitFor(() => expect(answers).toBe(1));
    // The same words, sent again, are the input the Bureau may already hold.
    await fireEvent.click(view.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(inputsSent()).toHaveLength(2));
    const [first, second] = inputsSent().map((params) =>
      Reflect.get(params['input'] as object, 'id'),
    );
    expect(second).toBe(first);

    // Other words are another input, which the Bureau would refuse under the identifier of the first.
    await send(view, 'Other words');
    await waitFor(() => expect(inputsSent()).toHaveLength(3));
    const third = Reflect.get(inputsSent()[2]?.['input'] as object, 'id');
    expect(third).not.toBe(first);
  });
});
