/**
 * A question that has choices, docked in place of the composer (COR-2278, row P3): the Needs you
 * warning, the fieldset named Question, radio cards with the keys 1, 2 and 3, Something
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
import { QuestionStore, type DockedQuestionTarget } from './question/question-store.svelte.ts';

setupHappyDom();

const observedElements: Element[] = [];
class TestResizeObserver {
  observe(element: Element): void {
    observedElements.push(element);
  }
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

function dockTarget(toolCallId: string): DockedQuestionTarget {
  return {
    toolCallId,
    schema: { enum: ['one', 'two'] },
    message: toolCallId,
    submit: async () => true,
    busy: false,
    failed: false,
    issues: [],
  };
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
    // The eyebrow is gone: the legend is read aloud, never drawn.
    const legend = dock.querySelector('fieldset > legend')!;
    expect(legend.classList.contains('cinder-sr-only')).toBe(true);
    expect(dock.textContent).not.toContain('The agent is asking');
    expect(dock.querySelector('.chat-question-dock-question')?.textContent?.trim()).toBe(
      'Which environment?',
    );
    // The composer is out of sight but kept, and the pending question is rendered only in the dock.
    expect(container.querySelector('.chat-input-area')!.hasAttribute('data-question-docked')).toBe(
      true,
    );
    expect(composerShell(container)).not.toBeNull();
    expect(
      Boolean(container.querySelector('[data-cinder-tool-input] .chat-question-choices')),
    ).toBe(false);
    expect(Boolean(container.querySelector('.chat-tool-input-heading'))).toBe(false);
    expect(Boolean(container.querySelector('.chat-tool-input-waiting'))).toBe(false);
    expect(container.querySelector('[data-cinder-tool-input]')).toBeNull();
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

  test('leaves its radios the height and rest border Cinder gives them', async () => {
    const source = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();

    expect(source).not.toContain('--_cinder-choice-card-min-block-size');
    expect(source).toContain('max-block-size: min(100%, 50dvh);');
    expect(source).toContain('chat-question-dock-options-scroll');
    expect(source).toContain('chat-question-dock-completion');
    expect(source).toContain('moreChoices(hiddenAbove)');
    expect(source).toContain('moreChoices(hiddenBelow)');
    expect(source).toContain('wholeRows');
    expect(source).toContain('--cinder-border-muted');
    expect(source).not.toContain('chat-question-dock-body cinder-_scroll-fade');
    expect(source).toContain('overflow-y: auto;');
    expect(source).toContain('@media (any-pointer: coarse)');
    expect(source).toContain('display: none;');
  });

  test('re-snaps the list when the own-answer field changes the room, and keeps its ring inside the body', async () => {
    const source = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();
    expect(source).toContain('padding-inline: var(--_dock-ring-room);');
    expect(source).toContain('margin-inline: calc(var(--_dock-ring-room) * -1);');
    expect(source).toContain('keepSelectedInView();');
  });

  test('the whole-rows sizing watches the fieldset and the scrolling body, not only the list', async () => {
    observedElements.length = 0;
    const { container } = mountDocked('dock-observed', ENVIRONMENT);
    await settle();
    const fieldset = container.querySelector('fieldset');
    const body = container.querySelector('.chat-question-dock-body');
    expect(fieldset).not.toBeNull();
    expect(body).not.toBeNull();
    expect(observedElements.includes(fieldset!)).toBe(true);
    expect(observedElements.includes(body!)).toBe(true);
  });

  test('keeps Answer off, with no helper line, until something is chosen', async () => {
    const { container } = mountDocked('dock-reason', ENVIRONMENT);
    await settle();

    const answer = buttonNamed(container, 'Answer')!;
    expect(answer.disabled).toBe(true);
    expect(container.querySelector('.chat-question-dock-hint')).toBeNull();
    expect(dockOf(container)!.textContent).not.toContain('Choose an answer to continue');

    await fireEvent.click(radiosOf(container)[1]!);
    expect(answer.disabled).toBe(false);
    expect(answer.hasAttribute('aria-describedby')).toBe(false);
  });

  test('puts the secondary Reply in chat instead before the primary Answer', async () => {
    const { container } = mountDocked('dock-actions', ENVIRONMENT);
    await settle();

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>('.chat-question-dock-actions button'),
    ];
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
    ).toEqual(['Reply in chat instead', 'Answer']);
    expect(buttons[0]!.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(buttons[0]!.getAttribute('data-cinder-icon-only')).toBe('');
    expect(buttons[0]!.closest('.cinder-tooltip-wrapper')).not.toBeNull();
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
    expect(field.placeholder).toBe('Type your answer');
    expect(container.querySelector('.chat-question-dock-hint')).toBeNull();

    // Keys typed into the field are words, not choices.
    await fireEvent.keyDown(field, { key: '1' });
    expect(radiosOf(container)[2]!.getAttribute('aria-checked')).toBe('true');
    field.value = 'canary-2';
    await fireEvent.input(field);
    await tick();
    expect(buttonNamed(container, 'Answer')?.disabled).toBe(false);

    sendDock(container);
    await settle();
    expect(answers).toEqual(['canary-2']);
  });

  test('keeps question context and custom answer outside the choice scroll boundary', async () => {
    const { container } = mountDocked('dock-scroll-boundary', ENVIRONMENT_OR_OTHER);
    await settle();

    const dock = dockOf(container)!;
    const optionsScroll = dock.querySelector('.chat-question-dock-options-scroll')!;
    const question = dock.querySelector('.chat-question-dock-question')!;
    expect(optionsScroll.contains(question)).toBe(false);

    await fireEvent.click(radiosOf(container)[2]!);
    await settle();

    const customAnswer = dock.querySelector('input[type="text"]')!;
    expect(optionsScroll.contains(customAnswer)).toBe(false);
    expect(dock.querySelector('.chat-question-dock-completion')?.contains(customAnswer)).toBe(true);
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

  test('a yes or no question uses host label overrides', async () => {
    const { container } = render(Chat, {
      id: 'dock-boolean-labels',
      conversation: single('dock-boolean-labels', { type: 'boolean' }),
      questionPlacement: 'docked',
      onInputSubmit: () => undefined,
      questionLabels: { yes: 'Approve it', no: 'Reject it' },
    });
    await settle();

    expect(
      radiosOf(container).map(
        (radio) => radio.querySelector('.chat-question-dock-choice-label')?.textContent,
      ),
    ).toEqual(['Approve it', 'Reject it']);
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
  test('resets progress for a genuinely later round after the dock stays empty', async () => {
    const store = new QuestionStore(() => false);
    const removeFirst = store.registerDockedQuestion(dockTarget('first-round'));
    store.noteDockedAnswer();
    removeFirst();
    await tick();

    store.registerDockedQuestion(dockTarget('second-round'));
    expect(store.dockedAnswered).toBe(0);
  });

  test('reset invalidates a pending round reset', async () => {
    const store = new QuestionStore(() => false);
    const remove = store.registerDockedQuestion(dockTarget('stale-round'));
    store.noteDockedAnswer();
    remove();
    store.reset();
    store.noteDockedAnswer();
    await tick();

    expect(store.dockedAnswered).toBe(1);
  });

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
    // Pending questions belong once in the dock; the transcript has no duplicate prompt or
    // "asked below" copy for the queued item.
    expect(container.querySelectorAll('.chat-tool-input-heading')).toHaveLength(0);
    expect(container.querySelectorAll('.chat-tool-input-waiting')).toHaveLength(0);
    expect(container.querySelectorAll('[data-cinder-tool-input]')).toHaveLength(0);

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
    const summary = container.querySelector('.chat-tool-call-summary')?.textContent ?? '';
    expect(summary).toContain('1 answered');
    expect(summary).not.toContain('2 waiting for input');
    expect(container.querySelectorAll('.chat-tool-input-waiting')).toHaveLength(0);

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
