/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { ToolInputMessagePart } from '../utilities/types.ts';
import { ChatQuestionAnswerError } from './question-answer.ts';

setupHappyDom();

const { render, cleanup, fireEvent, screen } = await import('@testing-library/svelte');
const { default: ToolInputPart } = await import('../message/parts/tool-input-part.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function question(schema: Record<string, unknown>, message = 'Question?'): ToolInputMessagePart {
  return {
    type: 'tool-input',
    key: 'm:tool-input:ask',
    toolCallId: 'ask',
    toolName: 'requestHumanInput',
    message,
    schema,
  };
}

const SECRET = { type: 'string', writeOnly: true, 'x-secret': true, title: 'API token' };

describe('a question outside a chat (the reviews inbox)', () => {
  test('a server-side refusal shows on the field it names, and the question stays open', async () => {
    const part = question({
      type: 'object',
      properties: { room: { type: 'string', title: 'Room' } },
    });
    const { container } = render(ToolInputPart, {
      props: {
        part,
        onInputSubmit: () =>
          Promise.reject(
            new ChatQuestionAnswerError([{ path: ['room'], message: 'Room is already booked' }]),
          ),
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText(/Room/), { target: { value: 'Atlas' } });
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();

    const room = screen.getByLabelText(/Room/);
    expect(room.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Room is already booked');
    expect(container.textContent).not.toContain('You answered');
  });

  test('a refusal of a single value shows on that control and the next answer is accepted', async () => {
    let attempts = 0;
    const { container } = render(ToolInputPart, {
      props: {
        part: question({ type: 'string', format: 'date', title: 'Day' }),
        onInputSubmit: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(
                new ChatQuestionAnswerError([{ path: [], message: '"Day" is a holiday' }]),
              )
            : undefined;
        },
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText('Day'), { target: { value: '2026-02-26' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    await flush();
    await flush();
    expect(screen.getByLabelText('Day').getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('is a holiday');

    await fireEvent.input(screen.getByLabelText('Day'), { target: { value: '2026-02-27' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    await flush();
    expect(container.textContent).toContain('You answered');
    expect(container.textContent).toContain('2026-02-27');
    expect(container.textContent).not.toContain('is a holiday');
  });

  test('a rejection that is not a refusal reads as could not be sent, with no field error', async () => {
    const { container } = render(ToolInputPart, {
      props: {
        part: question({ type: 'boolean' }),
        onInputSubmit: () => Promise.reject(new Error('offline')),
      },
    });
    await flush();

    await fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await flush();
    await flush();

    expect(container.textContent).toContain('could not be sent');
    expect(container.textContent).not.toContain('You answered');
  });

  test('Change reopens the question, pre-filled, and resubmits', async () => {
    const answers: unknown[] = [];
    const { container } = render(ToolInputPart, {
      props: {
        part: question({ type: 'string', maxLength: 50, title: 'Reason' }),
        onInputSubmit: (_id: string, value: unknown) => {
          answers.push(value);
        },
      },
    });
    await flush();
    await fireEvent.input(screen.getByLabelText('Reason'), { target: { value: 'first' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    await flush();
    expect(container.textContent).toContain('You answered');
    expect(container.querySelector('textarea')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await flush();
    const field = screen.getByLabelText<HTMLTextAreaElement>('Reason');
    expect(field.value).toBe('first');
    await fireEvent.input(field, { target: { value: 'second' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    await flush();

    expect(answers).toEqual(['first', 'second']);
    expect(container.textContent).toContain('second');
  });
});

describe('a secret answer', () => {
  test('is sent once and is never rendered afterwards, nor kept for Change', async () => {
    const received: unknown[] = [];
    const { container } = render(ToolInputPart, {
      props: {
        part: question(SECRET),
        onInputSubmit: (_id: string, value: unknown) => {
          received.push(value);
        },
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText('API token'), { target: { value: 'sk-live-123' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    await flush();

    expect(received).toEqual(['sk-live-123']);
    expect(container.innerHTML).not.toContain('sk-live-123');
    expect(container.textContent).toContain('You answered');
    expect(container.textContent).toContain('a secret');
    for (const element of container.querySelectorAll('input, textarea')) {
      expect((element as HTMLInputElement).value).not.toContain('sk-live-123');
    }

    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await flush();
    expect(container.innerHTML).not.toContain('sk-live-123');
    expect((screen.getByLabelText('API token') as HTMLInputElement).value).toBe('');
  });

  test('a secret field inside a few fields is masked in the answer', async () => {
    const { container } = render(ToolInputPart, {
      props: {
        part: question({
          type: 'object',
          properties: {
            user: { type: 'string', title: 'User' },
            token: { type: 'string', title: 'Token', writeOnly: true, 'x-secret': true },
          },
          required: ['user', 'token'],
        }),
        onInputSubmit: () => undefined,
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText(/User/), { target: { value: 'ada' } });
    await fireEvent.input(screen.getByLabelText(/Token/), { target: { value: 'tok-999' } });
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();

    expect(container.textContent).toContain('You answered');
    expect(container.textContent).toContain('ada');
    expect(container.innerHTML).not.toContain('tok-999');
  });

  test('a client check that fails never quotes the secret in what it shows', async () => {
    const calls: unknown[] = [];
    const { container } = render(ToolInputPart, {
      props: {
        part: question({ ...SECRET, enum: ['only-this'] }),
        onInputSubmit: (_id: string, value: unknown) => {
          calls.push(value);
        },
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText('API token'), { target: { value: 'sk-live-123' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    await flush();
    await flush();

    expect(calls).toEqual([]);
    expect(container.textContent).toContain('not valid');
    expect(container.textContent).not.toContain('sk-live-123');
    expect(container.innerHTML).not.toContain('sk-live-123');
  });
});
