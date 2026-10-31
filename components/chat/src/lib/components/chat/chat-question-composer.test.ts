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

function composerOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

async function typeAndSend(container: HTMLElement, text: string): Promise<void> {
  const composer = composerOf(container);
  await fireEvent.input(composer, { target: { value: text } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  await tick();
  await tick();
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
    await tick();
    await tick();

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
    await tick();
    await tick();

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
    await tick();
    await tick();

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
