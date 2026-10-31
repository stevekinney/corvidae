/**
 * One question with its one text field and Send, as `/reviews` shows it: Send waits for text, sends
 * it trimmed, holds while it is sending, and tells a failure under the field.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { REVIEWS_COPY } from '../../app/copy.ts';
import QuestionDecision from './question-decision.svelte';

afterEach(() => cleanup());

function renderQuestion(props: Record<string, unknown> = {}) {
  return render(QuestionDecision, {
    props: {
      id: 'question-1',
      question: 'Which environment should the release go to?',
      identifiers: [],
      sending: false,
      onSend: () => {},
      ...props,
    },
  } as never);
}

describe('a question to answer', () => {
  test('sends the trimmed text once there is some, and says what the agent does with it', async () => {
    const sent: string[] = [];
    const view = renderQuestion({ onSend: (text: string) => void sent.push(text) });
    const send = view.getByRole('button', { name: REVIEWS_COPY.sendAnswer });
    expect(send.hasAttribute('disabled')).toBe(true);

    await fireEvent.input(view.getByLabelText(REVIEWS_COPY.answerLabel), {
      target: { value: '  staging  ' },
    });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    await fireEvent.click(send);

    expect(sent).toEqual(['staging']);
    expect(view.getByText(REVIEWS_COPY.answerHint)).not.toBeNull();
  });

  test('sends nothing for blank text or while an answer is already being sent', async () => {
    const sent: string[] = [];
    const view = renderQuestion({ onSend: (text: string) => void sent.push(text) });

    await fireEvent.input(view.getByLabelText(REVIEWS_COPY.answerLabel), {
      target: { value: '   ' },
    });
    await fireEvent.submit(view.container.querySelector('form') as HTMLFormElement);
    expect(sent).toEqual([]);
    cleanup();

    const sending = renderQuestion({
      sending: true,
      onSend: (text: string) => void sent.push(text),
    });
    await fireEvent.input(sending.getByLabelText(REVIEWS_COPY.answerLabel), {
      target: { value: 'staging' },
    });
    await fireEvent.submit(sending.container.querySelector('form') as HTMLFormElement);
    expect(sent).toEqual([]);
  });

  test('tells why an answer was not sent', () => {
    const view = renderQuestion({ failure: 'The Bureau broke.' });

    expect(view.getByText('The Bureau broke.')).not.toBeNull();
  });
});
