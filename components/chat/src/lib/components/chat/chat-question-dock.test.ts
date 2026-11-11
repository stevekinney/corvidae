/**
 * A question that has choices, docked in place of the composer (COR-2278, row P3): the Needs you
 * warning, the fieldset named The agent is asking, radio cards with the keys 1, 2 and 3, Something
 * else with its field, a secondary Reply in chat instead and a primary Answer, progress through
 * several questions, and the answer receipt that stays in the transcript.
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
} from './builders.ts';
import type { ConversationHistory } from './conversation-model.ts';

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

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
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
  await tick();
}

const ENVIRONMENT = {
  enum: ['staging', 'production', 'canary'],
  'x-labels': { staging: 'Staging', production: 'Production', canary: 'Canary' },
  'x-descriptions': {
    staging: 'Safe to break',
    production: 'Customers see it',
    canary: 'A tenth of customers',
  },
};

const ENVIRONMENT_OR_OTHER = {
  anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 80 }],
  'x-allowOther': true,
  'x-labels': { staging: 'Staging', production: 'Production' },
};

function conversationWith(
  id: string,
  questions: readonly { id: string; message: string; schema: Record<string, unknown> }[],
): ConversationHistory {
  let conversation = appendUserMessage(createConversationHistory({ id }), 'deploy it');
  for (const question of questions) {
    conversation = appendToolResult(
      appendToolCall(conversation, { id: question.id, name: 'requestHumanInput', arguments: {} }),
      {
        callId: question.id,
        outcome: 'action_required',
        content: null,
        action: { type: 'input', message: question.message, schema: question.schema },
      },
    );
  }
  return conversation;
}

function single(id: string, schema: Record<string, unknown>): ConversationHistory {
  return conversationWith(id, [{ id: 'ask', message: 'Which environment?', schema }]);
}

function dockOf(container: HTMLElement): HTMLFormElement | null {
  return container.querySelector<HTMLFormElement>('[data-chat-question-dock]');
}

function radiosOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-chat-question-dock] [role="radio"]')];
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === name,
  );
}

function sendDock(container: HTMLElement): void {
  dockOf(container)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function composerShell(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.chat-input-area > .chat-input-shell')!;
}

describe('with the default placement', () => {
  test('draws a question that has choices in its row and no dock', async () => {
    const { container } = render(Chat, {
      id: 'dock-inline',
      conversation: single('dock-inline', ENVIRONMENT),
      onInputSubmit: () => undefined,
    });
    await settle();

    expect(dockOf(container)).toBeNull();
    expect(
      container.querySelector('[data-cinder-tool-input] .chat-question-choices'),
    ).not.toBeNull();
    expect(container.querySelector('.chat-input-area')!.hasAttribute('data-question-docked')).toBe(
      false,
    );
  });
});

describe('a docked question', () => {
  function mountDocked(
    id: string,
    schema: Record<string, unknown>,
    onInputSubmit: (toolCallId: string, value: unknown) => void | Promise<void> = () => undefined,
  ) {
    return render(Chat, {
      id,
      conversation: single(id, schema),
      questionPlacement: 'docked',
      onInputSubmit,
    });
  }

  test('takes the composer place with a warning, a fieldset named for the agent and the question', async () => {
    const { container } = mountDocked('dock-shape', ENVIRONMENT);
    await settle();

    const dock = dockOf(container)!;
    expect(dock.querySelector('[data-chat-question-needs]')?.textContent?.trim()).toBe('Needs you');
    expect(dock.querySelector('fieldset > legend')?.textContent?.trim()).toBe(
      'The agent is asking',
    );
    expect(dock.querySelector('.chat-question-dock-question')?.textContent?.trim()).toBe(
      'Which environment?',
    );
    // The composer is out of sight but kept, and the row holds only the question.
    expect(container.querySelector('.chat-input-area')!.hasAttribute('data-question-docked')).toBe(
      true,
    );
    expect(composerShell(container)).not.toBeNull();
    expect(container.querySelector('[data-cinder-tool-input] .chat-question-choices')).toBeNull();
    expect(container.querySelector('.chat-tool-input-waiting')?.textContent?.trim()).toBe(
      'Waiting for your answer below',
    );
  });

  test('draws a radio card per choice with its description and the key that chooses it', async () => {
    const { container } = mountDocked('dock-radios', ENVIRONMENT);
    await settle();

    const radios = radiosOf(container);
    expect(radios).toHaveLength(3);
    expect(
      radios.map((radio) => radio.querySelector('.chat-question-dock-choice-label')?.textContent),
    ).toEqual(['Staging', 'Production', 'Canary']);
    expect(
      radios.map(
        (radio) => radio.querySelector('.cinder-choice-grid-item__description')?.textContent,
      ),
    ).toEqual(['Safe to break', 'Customers see it', 'A tenth of customers']);
    expect(radios.map((radio) => radio.querySelector('kbd')?.textContent)).toEqual(['1', '2', '3']);
    const group = dockOf(container)!.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe(
      dockOf(container)!.querySelector('.chat-question-dock-question')!.id,
    );
  });

  test('sets the minimum height of its radios to 52 px', async () => {
    const source = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();

    expect(source).toContain('--_cinder-choice-card-min-block-size: 3.25rem;');
  });

  test('keeps Answer off, with its reason in view and named, until something is chosen', async () => {
    const { container } = mountDocked('dock-reason', ENVIRONMENT);
    await settle();

    const answer = buttonNamed(container, 'Answer')!;
    expect(answer.disabled).toBe(true);
    const hint = container.querySelector('.chat-question-dock-hint')!;
    expect(hint.textContent?.trim()).toBe('Choose an answer to continue');
    expect(answer.getAttribute('aria-describedby')).toBe(hint.id);

    await fireEvent.click(radiosOf(container)[1]!);
    expect(answer.disabled).toBe(false);
    expect(container.querySelector('.chat-question-dock-hint')).toBeNull();
    expect(answer.hasAttribute('aria-describedby')).toBe(false);
  });

  test('puts the secondary Reply in chat instead before the primary Answer', async () => {
    const { container } = mountDocked('dock-actions', ENVIRONMENT);
    await settle();

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>('.chat-question-dock-actions button'),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Reply in chat instead',
      'Answer',
    ]);
    expect(buttons[0]!.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(buttons[1]!.getAttribute('data-cinder-variant')).toBe('primary');
  });

  test('a choice only selects; Answer sends it, and the row keeps the receipt', async () => {
    const answers: [string, unknown][] = [];
    const { container } = mountDocked('dock-send', ENVIRONMENT, (toolCallId, value) => {
      answers.push([toolCallId, value]);
    });
    await settle();

    await fireEvent.click(radiosOf(container)[1]!);
    await settle();
    expect(answers).toEqual([]);
    expect(radiosOf(container)[1]!.getAttribute('aria-checked')).toBe('true');

    sendDock(container);
    await settle();

    expect(answers).toEqual([['ask', 'production']]);
    // The dock is gone, the composer is back, and the row says what was answered.
    expect(dockOf(container)).toBeNull();
    expect(container.querySelector('.chat-input-area')!.hasAttribute('data-question-docked')).toBe(
      false,
    );
    expect(container.querySelector('[data-cinder-tool-input]')!.textContent).toContain(
      'You answered',
    );
    expect(container.querySelector('[data-question-answer]')?.textContent).toContain('Production');
  });

  test('the keys 1, 2 and 3 choose a card without sending it', async () => {
    const answers: unknown[] = [];
    const { container } = mountDocked('dock-keys', ENVIRONMENT, (_toolCallId, value) => {
      answers.push(value);
    });
    await settle();

    const first = radiosOf(container)[0]!;
    await fireEvent.keyDown(first, { key: '3' });
    expect(radiosOf(container).map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    await fireEvent.keyDown(first, { key: '1' });
    expect(radiosOf(container)[0]!.getAttribute('aria-checked')).toBe('true');
    // A key past the last card, and a key with a modifier, do nothing.
    await fireEvent.keyDown(first, { key: '7' });
    await fireEvent.keyDown(first, { key: '2', ctrlKey: true });
    expect(radiosOf(container)[0]!.getAttribute('aria-checked')).toBe('true');
    expect(answers).toEqual([]);
  });

  test('Something else opens a field, keeps Answer off until it has words, and sends them', async () => {
    const answers: unknown[] = [];
    const { container } = mountDocked('dock-other', ENVIRONMENT_OR_OTHER, (_toolCallId, value) => {
      answers.push(value);
    });
    await settle();

    const radios = radiosOf(container);
    expect(radios).toHaveLength(3);
    expect(radios[2]!.querySelector('.chat-question-dock-choice-label')?.textContent).toBe(
      'Something else',
    );
    expect(dockOf(container)!.querySelector('input[type="text"]')).toBeNull();

    // The key after the last choice opens it.
    await fireEvent.keyDown(radios[0]!, { key: '3' });
    await settle();
    const field = dockOf(container)!.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(field).not.toBeNull();
    expect(field.getAttribute('aria-label') ?? field.labels?.[0]?.textContent).toContain(
      'Your own answer',
    );
    const answer = buttonNamed(container, 'Answer')!;
    expect(answer.disabled).toBe(true);
    expect(container.querySelector('.chat-question-dock-hint')?.textContent?.trim()).toBe(
      'Type your answer to continue',
    );

    // Keys typed into the field are words, not choices.
    await fireEvent.keyDown(field, { key: '1' });
    expect(radiosOf(container)[2]!.getAttribute('aria-checked')).toBe('true');
    await fireEvent.input(field, { target: { value: 'canary-2' } });
    expect(answer.disabled).toBe(false);

    sendDock(container);
    await settle();
    expect(answers).toEqual(['canary-2']);
  });

  test('a yes or no question has a Yes card and a No card', async () => {
    const answers: unknown[] = [];
    const { container } = mountDocked('dock-boolean', { type: 'boolean' }, (_toolCallId, value) => {
      answers.push(value);
    });
    await settle();

    expect(
      radiosOf(container).map(
        (radio) => radio.querySelector('.chat-question-dock-choice-label')?.textContent,
      ),
    ).toEqual(['Yes', 'No']);
    await fireEvent.click(radiosOf(container)[1]!);
    sendDock(container);
    await settle();

    expect(answers).toEqual([false]);
  });

  test('Reply in chat instead gives the composer back and returns the question to its row', async () => {
    const answers: unknown[] = [];
    const { container } = mountDocked('dock-reply', ENVIRONMENT, (_toolCallId, value) => {
      answers.push(value);
    });
    await settle();

    await fireEvent.click(buttonNamed(container, 'Reply in chat instead')!);
    await settle();

    expect(dockOf(container)).toBeNull();
    expect(container.querySelector('.chat-input-area')!.hasAttribute('data-question-docked')).toBe(
      false,
    );
    expect(document.activeElement).toBe(
      container.querySelector('textarea.chat-input-editor') as HTMLElement,
    );
    // The question is still open, and can still be answered in place.
    expect(
      container.querySelector('[data-cinder-tool-input] .chat-question-choices'),
    ).not.toBeNull();
    expect(answers).toEqual([]);
  });

  test('a refused answer leaves the dock open and says it could not be sent', async () => {
    const { container } = mountDocked('dock-failed', ENVIRONMENT, () =>
      Promise.reject(new Error('offline')),
    );
    await settle();

    await fireEvent.click(radiosOf(container)[0]!);
    sendDock(container);
    await settle();

    expect(dockOf(container)).not.toBeNull();
    expect(dockOf(container)!.querySelector('.chat-question-dock-error')?.textContent?.trim()).toBe(
      'The answer could not be sent. Try again.',
    );
  });

  test('says the host words instead of the defaults', async () => {
    const { container } = render(Chat, {
      id: 'dock-labels',
      conversation: single('dock-labels', ENVIRONMENT),
      questionPlacement: 'docked',
      questionLabels: { needsYou: 'Se requiere su respuesta', replyInChat: 'Responder en el chat' },
      onInputSubmit: () => undefined,
    });
    await settle();

    expect(container.querySelector('[data-chat-question-needs]')?.textContent?.trim()).toBe(
      'Se requiere su respuesta',
    );
    expect(buttonNamed(container, 'Responder en el chat')).not.toBeUndefined();
  });
});

describe('several docked questions', () => {
  test('ask one at a time with Question 1 of 2, then Question 2 of 2, and show no progress for one', async () => {
    const answers: [string, unknown][] = [];
    const { container } = render(Chat, {
      id: 'dock-many',
      conversation: conversationWith('dock-many', [
        { id: 'first', message: 'Which environment?', schema: ENVIRONMENT },
        { id: 'second', message: 'Which region?', schema: { enum: ['east', 'west'] } },
      ]),
      questionPlacement: 'docked',
      onInputSubmit: (toolCallId: string, value: unknown) => {
        answers.push([toolCallId, value]);
      },
    });
    await settle();

    expect(dockOf(container)!.dataset['chatQuestionId']).toBe('first');
    expect(container.querySelector('[data-chat-question-progress]')?.textContent?.trim()).toBe(
      'Question 1 of 2',
    );
    // Only the question the dock asks says to answer below; the next one says it comes after (C#8).
    expect(
      [...container.querySelectorAll('.chat-tool-input-waiting')].map((line) =>
        line.textContent?.trim(),
      ),
    ).toEqual(['Waiting for your answer below', 'Asked below after the current question']);

    await fireEvent.click(radiosOf(container)[0]!);
    sendDock(container);
    await settle();

    expect(dockOf(container)!.dataset['chatQuestionId']).toBe('second');
    expect(dockOf(container)!.querySelector('.chat-question-dock-question')?.textContent).toBe(
      'Which region?',
    );
    expect(container.querySelector('[data-chat-question-progress]')?.textContent?.trim()).toBe(
      'Question 2 of 2',
    );

    await fireEvent.click(radiosOf(container)[1]!);
    sendDock(container);
    await settle();

    expect(answers).toEqual([
      ['first', 'staging'],
      ['second', 'west'],
    ]);
    expect(dockOf(container)).toBeNull();
    // Each answer keeps its own receipt in the transcript.
    expect(container.querySelectorAll('[data-question-answer]')).toHaveLength(2);
  });

  test('a single question shows no progress', async () => {
    const { container } = render(Chat, {
      id: 'dock-one',
      conversation: single('dock-one', ENVIRONMENT),
      questionPlacement: 'docked',
      onInputSubmit: () => undefined,
    });
    await settle();

    expect(container.querySelector('[data-chat-question-progress]')).toBeNull();
  });
});

describe('a composer that is replaced', () => {
  test('keeps a question in its row rather than docking it over a blocked bar', async () => {
    const { container } = render(Chat, {
      id: 'dock-blocked',
      conversation: single('dock-blocked', ENVIRONMENT),
      questionPlacement: 'docked',
      composerStatus: { kind: 'blocked', reason: 'Connect a model provider to chat' },
      onInputSubmit: () => undefined,
    });
    await settle();

    expect(dockOf(container)).toBeNull();
    expect(
      container.querySelector('[data-cinder-tool-input] .chat-question-choices'),
    ).not.toBeNull();
  });

  test('keeps a question in its row for a read-only chat', async () => {
    const { container } = render(Chat, {
      id: 'dock-read-only',
      conversation: single('dock-read-only', ENVIRONMENT),
      questionPlacement: 'docked',
      composerStatus: { kind: 'read-only' },
      onInputSubmit: () => undefined,
    });
    await settle();

    expect(dockOf(container)).toBeNull();
  });
});
