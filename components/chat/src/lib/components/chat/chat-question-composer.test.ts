/**
 * A free-text question is answered through the composer when the host says so (`answerInComposer`,
 * the chat transcript) and through a field in the question when it does not (a reviews inbox).
 * Every other kind is answered in place either way, an answered question keeps its "You answered"
 * row after the run resumes, and a secret never reaches the rendered transcript.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
  replaceToolResult,
} from './builders.ts';
import type { ConversationHistory } from './conversation-model.ts';
import { ChatQuestionAnswerError } from './question/question-answer.ts';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = TestResizeObserver;

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { render, fireEvent, cleanup, screen } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

async function settle(): Promise<void> {
  // load-proof: Svelte effects, event handlers and promise continuations (a schema check compiles through a few) settle in the microtask queue, so these turns only drain them and await no timer or IO
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function composerOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

async function typeAndSend(container: HTMLElement, text: string): Promise<void> {
  const composer = composerOf(container);
  await fireEvent.input(composer, { target: { value: text } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  await settle();
}

function questionConversation(id: string, schema: Record<string, unknown>): ConversationHistory {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'deploy it'), {
      id: 'ask',
      name: 'requestHumanInput',
      arguments: {},
    }),
    {
      callId: 'ask',
      outcome: 'action_required',
      content: null,
      action: { type: 'input', message: 'Which environment?', schema },
    },
  );
}

const TEXT = { type: 'string', maxLength: 200 };

describe('free text answered through the composer', () => {
  test('answerInComposer: the question reads Answer below and the composer sends the answer', async () => {
    const answers: [string, unknown][] = [];
    const messages: unknown[] = [];
    const { container } = render(Chat, {
      id: 'q-composer',
      conversation: questionConversation('q-composer', TEXT),
      answerInComposer: true,
      onInputSubmit: (toolCallId: string, value: unknown) => {
        answers.push([toolCallId, value]);
      },
      onSubmit: (event: unknown) => messages.push(event),
    });
    await tick();

    expect(container.textContent).toContain('Answer below');
    expect(container.querySelector('[data-cinder-tool-input] textarea')).toBeNull();
    expect(composerOf(container).placeholder).toBe('Answer');

    await typeAndSend(container, 'staging please');

    expect(answers).toEqual([['ask', 'staging please']]);
    expect(messages).toEqual([]);
    expect(container.textContent).toContain('You answered');
    expect(container.textContent).toContain('staging please');
    // With nothing left to answer, the composer sends messages again.
    expect(composerOf(container).placeholder).not.toBe('Answer');
  });

  test('a refused composer answer leaves the question open with the reason on it', async () => {
    const { container } = render(Chat, {
      id: 'q-refused',
      conversation: questionConversation('q-refused', TEXT),
      answerInComposer: true,
      onInputSubmit: () =>
        Promise.reject(new ChatQuestionAnswerError([{ path: [], message: 'Too vague' }])),
    });
    await tick();

    await typeAndSend(container, 'maybe');

    expect(container.textContent).toContain('Too vague');
    expect(container.textContent).not.toContain('You answered');
    expect(composerOf(container).placeholder).toBe('Answer');
    // What was typed comes back, so a refusal does not cost the person their words.
    expect(composerOf(container).value).toBe('maybe');
  });

  test('without answerInComposer a text field is drawn in the question and the composer sends messages', async () => {
    const answers: [string, unknown][] = [];
    const messages: unknown[] = [];
    const { container } = render(Chat, {
      id: 'q-inbox',
      conversation: questionConversation('q-inbox', TEXT),
      onInputSubmit: (toolCallId: string, value: unknown) => {
        answers.push([toolCallId, value]);
      },
      onSubmit: (event: unknown) => messages.push(event),
    });
    await tick();

    expect(container.textContent).not.toContain('Answer below');
    const field = container.querySelector<HTMLTextAreaElement>('[data-cinder-tool-input] textarea');
    expect(field).not.toBeNull();
    expect(composerOf(container).placeholder).not.toBe('Answer');

    await fireEvent.input(field!, { target: { value: 'production' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(answers).toEqual([['ask', 'production']]);
    expect(messages).toEqual([]);
  });

  test('other kinds are answered in place even with answerInComposer', async () => {
    const answers: unknown[] = [];
    render(Chat, {
      id: 'q-choice',
      conversation: questionConversation('q-choice', {
        type: 'string',
        enum: ['staging', 'production'],
        'x-labels': { staging: 'Staging', production: 'Production' },
      }),
      answerInComposer: true,
      onInputSubmit: (_toolCallId: string, value: unknown) => {
        answers.push(value);
      },
    });
    await tick();

    await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
    await settle();

    expect(answers).toEqual(['staging']);
    expect(document.body.textContent).toContain('You answered');
  });
});

describe('answered questions', () => {
  test('keep their You answered row once the run resumes and the result is the tool output', async () => {
    const schema = {
      type: 'string',
      enum: ['staging', 'production'],
      'x-labels': { staging: 'Staging' },
    };
    const conversation = questionConversation('q-resume', schema);
    const view = render(Chat, {
      id: 'q-resume',
      conversation,
      onInputSubmit: () => undefined,
    });
    await tick();
    await fireEvent.click(screen.getByRole('button', { name: 'Staging' }));
    await settle();

    await view.rerender({
      conversation: replaceToolResult(conversation, 'ask', {
        callId: 'ask',
        outcome: 'success',
        content: { parked: true, signalName: 'environment', prompt: 'Which environment?' },
      }),
    });
    await tick();

    expect(view.container.textContent).toContain('You answered');
    expect(view.container.textContent).toContain('Staging');
    expect(view.container.querySelector('[data-cinder-tool-input]')).not.toBeNull();
    // The tool's own output ("parked true, signalName …") is not what the person reads.
    expect(view.container.textContent).not.toContain('parked');
    expect(view.container.textContent).not.toContain('signalName');
  });
});

describe('a question whose run has resumed', () => {
  function resumed(conversation: ConversationHistory): ConversationHistory {
    return replaceToolResult(conversation, 'ask', {
      callId: 'ask',
      outcome: 'success',
      content: { parked: true, signalName: 'why' },
    });
  }

  test('offers no Change, so the composer keeps sending messages', async () => {
    const answers: unknown[] = [];
    const messages: unknown[] = [];
    const conversation = questionConversation('q-resumed-text', TEXT);
    const view = render(Chat, {
      id: 'q-resumed-text',
      conversation,
      answerInComposer: true,
      onInputSubmit: (_id: string, value: unknown) => {
        answers.push(value);
      },
      onSubmit: (event: unknown) => messages.push(event),
    });
    await tick();
    await typeAndSend(view.container, 'first answer');
    await view.rerender({ conversation: resumed(conversation) });
    await tick();

    expect(view.container.textContent).toContain('You answered');
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(composerOf(view.container).placeholder).not.toBe('Answer');

    await typeAndSend(view.container, 'a brand new message');

    expect(answers).toEqual(['first answer']);
    expect(messages).toHaveLength(1);
  });

  test('offers no Change for any other kind either', async () => {
    const conversation = questionConversation('q-resumed-choice', {
      type: 'string',
      enum: ['staging', 'production'],
    });
    const view = render(Chat, {
      id: 'q-resumed-choice',
      conversation,
      onInputSubmit: () => undefined,
    });
    await tick();
    await fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeNull();

    await view.rerender({ conversation: resumed(conversation) });
    await tick();

    expect(view.container.textContent).toContain('You answered');
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  test('a Change that was open when the run resumed closes', async () => {
    const answers: unknown[] = [];
    const conversation = questionConversation('q-resumed-open', TEXT);
    const view = render(Chat, {
      id: 'q-resumed-open',
      conversation,
      onInputSubmit: (_id: string, value: unknown) => {
        answers.push(value);
      },
    });
    await tick();
    await fireEvent.input(view.container.querySelector('[data-cinder-tool-input] textarea')!, {
      target: { value: 'first' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await tick();
    expect(view.container.querySelector('[data-cinder-tool-input] textarea')).not.toBeNull();

    await view.rerender({ conversation: resumed(conversation) });
    await tick();

    expect(view.container.querySelector('[data-cinder-tool-input] textarea')).toBeNull();
    expect(view.container.textContent).toContain('You answered');
  });
});

describe('answers are held to the whole schema, and belong to their conversation', () => {
  test('an answer that breaks the schema never reaches the host, from the composer or a control', async () => {
    const answers: unknown[] = [];
    const strict = { type: 'string', minLength: 5, pattern: '^[a-z]+$' };
    const view = render(Chat, {
      id: 'q-strict',
      conversation: questionConversation('q-strict', { type: 'string', minLength: 5 }),
      answerInComposer: true,
      onInputSubmit: (_id: string, value: unknown) => {
        answers.push(value);
      },
    });
    await tick();

    await typeAndSend(view.container, 'abc');

    expect(answers).toEqual([]);
    expect(view.container.textContent).toContain('too short');
    // The refused text is back in the composer to fix.
    expect(composerOf(view.container).value).toBe('abc');
    expect(strict).toBeDefined();
  });

  test('an answer from a specialised control is checked too', async () => {
    const answers: unknown[] = [];
    render(Chat, {
      id: 'q-range',
      conversation: questionConversation('q-range', {
        type: 'integer',
        exclusiveMinimum: 10,
        title: 'Count',
      }),
      onInputSubmit: (_id: string, value: unknown) => {
        answers.push(value);
      },
    });
    await tick();
    const field = screen.getByRole('spinbutton', { name: /Count/ });
    await fireEvent.input(field, { target: { value: '3' } });
    await fireEvent.blur(field);
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(answers).toEqual([]);
    expect(document.body.textContent).not.toContain('You answered');
  });

  test('a different conversation does not inherit the answer to a call with the same id', async () => {
    const first = questionConversation('q-first', { type: 'boolean' });
    const view = render(Chat, {
      id: 'q-switch',
      conversation: first,
      onInputSubmit: () => undefined,
    });
    await tick();
    await fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await settle();
    expect(view.container.textContent).toContain('You answered');

    await view.rerender({ conversation: questionConversation('q-second', { type: 'boolean' }) });
    await settle();

    expect(view.container.textContent).not.toContain('You answered');
    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeNull();
  });

  test('an answer still in flight when the conversation changes does not land in the next one', async () => {
    let release: () => void = () => undefined;
    const view = render(Chat, {
      id: 'q-late',
      conversation: questionConversation('q-late-1', { type: 'boolean' }),
      onInputSubmit: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await tick();
    await fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await settle();

    await view.rerender({ conversation: questionConversation('q-late-2', { type: 'boolean' }) });
    await tick();
    release();
    await settle();

    expect(view.container.textContent).not.toContain('You answered');
  });
});

describe('long ratings and virtualized transcripts', () => {
  test('a rating over many steps takes any value in its range from a number field', async () => {
    const answers: unknown[] = [];
    render(Chat, {
      id: 'q-rating',
      conversation: questionConversation('q-rating', {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        'x-kind': 'rating',
        title: 'Score',
      }),
      onInputSubmit: (_id: string, value: unknown) => {
        answers.push(value);
      },
    });
    await tick();
    const field = screen.getByRole('spinbutton', { name: /Score/ });
    await fireEvent.input(field, { target: { value: '73' } });
    await fireEvent.blur(field);
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(answers).toEqual([73]);
  });

  test('the open question keeps answering from the composer when its row is out of the window', async () => {
    const answers: unknown[] = [];
    const messages: unknown[] = [];
    let conversation = questionConversation('q-virtual', TEXT);
    for (let index = 0; index < 120; index += 1) {
      conversation = appendAssistantMessage(conversation, `Filler ${index}`);
    }
    const view = render(Chat, {
      id: 'q-virtual',
      conversation,
      virtualized: true,
      answerInComposer: true,
      onInputSubmit: (_id: string, value: unknown) => {
        answers.push(value);
      },
      onSubmit: (event: unknown) => messages.push(event),
    });
    await settle();
    await typeAndSend(view.container, 'still an answer');

    expect(answers).toEqual(['still an answer']);
    expect(messages).toEqual([]);
  });
});

describe('a composer answer in flight when the conversation changes', () => {
  for (const outcome of ['accepted', 'refused', 'failed'] as const) {
    test(`${outcome}: the typed text is not put in the next conversation's composer`, async () => {
      let settleAnswer: () => void = () => undefined;
      const answers: unknown[] = [];
      const messages: unknown[] = [];
      const view = render(Chat, {
        id: 'q-switch-composer',
        conversation: questionConversation('q-a', TEXT),
        answerInComposer: true,
        onInputSubmit: (_id: string, value: unknown) =>
          new Promise<void>((resolve, reject) => {
            answers.push(value);
            settleAnswer = () => {
              if (outcome === 'accepted') resolve();
              else if (outcome === 'refused') {
                reject(new ChatQuestionAnswerError([{ path: [], message: 'Too vague' }]));
              } else reject(new Error('offline'));
            };
          }),
        onSubmit: (event: unknown) => messages.push(event),
      });
      await tick();
      await typeAndSend(view.container, 'words for A');
      expect(answers).toEqual(['words for A']);

      await view.rerender({ conversation: questionConversation('q-b', TEXT) });
      await settle();
      settleAnswer();
      await settle();

      expect(composerOf(view.container).value).toBe('');
      expect(answers).toEqual(['words for A']);
      expect(messages).toEqual([]);
    });
  }
});
