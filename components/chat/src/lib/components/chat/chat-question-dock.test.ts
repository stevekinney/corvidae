/**
 * A question that has choices, docked in place of the composer (COR-2278, row P3): the Needs you
 * warning, the fieldset named Question, flat radio rows with the keys 1, 2 and 3, Something
 * else with its field, a quiet Reply in chat and a primary Answer, progress through
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
import type { QuestionAnswerRecord } from './question/question-answer.ts';
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

const ANSWER_TO_FIRST: QuestionAnswerRecord = {
  toolCallId: 'first',
  toolName: 'requestHumanInput',
  message: 'first',
  schema: { enum: ['one', 'two'] },
  summary: 'one',
  value: 'one',
  secret: false,
};

function dockTarget(toolCallId: string): DockedQuestionTarget {
  return {
    toolCallId,
    answer: undefined,
    locked: false,
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

  test('draws a flat radio row per choice, with no card of its own, its description and the key that chooses it (COR-2402)', async () => {
    const { container } = mountDocked('dock-radios', ENVIRONMENT);
    await settle();

    const radios = radiosOf(container);
    expect(radios).toHaveLength(3);
    // The dock is the one box: its choices are rows on its surface, not bordered cards.
    expect(radios.map((radio) => radio.getAttribute('data-cinder-variant'))).toEqual([
      'row',
      'row',
      'row',
    ]);
    const dockSource = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();
    const actions = /\.chat-question-dock-actions \{([^}]*)\}/u.exec(dockSource)?.[1] ?? '';
    expect(actions).not.toContain('border-block-start');
    expect(actions).not.toContain('background');
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
    expect(source).toContain('max-block-size: min(100%, 80dvh);');
    expect(source).toContain('chat-question-dock-options-scroll');
    expect(source).toContain('chat-question-dock-completion');
    expect(source).toContain('--cinder-border-muted');
    expect(source).not.toContain('chat-question-dock-body cinder-_scroll-fade');
    expect(source).toContain('overflow-y: auto;');
    expect(source).toContain('@media (any-pointer: coarse)');
    expect(source).toContain('display: none;');
  });

  test('draws the pager as a row of its own at the leading edge, not a slot at the trailing end', async () => {
    const source = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();
    const block = /\.chat-question-dock-steps \{([^}]*)\}/u.exec(source)?.[1] ?? '';
    expect(block).toContain('flex: 1 0 100%;');
    expect(block).toContain('justify-content: flex-start;');
    expect(block).not.toContain('margin-inline-start: auto');
  });

  test('shows every choice: no "N more" count, no whole-row sizing, no scroll snap', async () => {
    const source = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();
    expect(source).not.toContain('moreChoices');
    expect(source).not.toContain('wholeRows');
    expect(source).not.toContain('scroll-snap');
    expect(source).not.toContain('50dvh');

    const choices = Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`);
    const { container } = mountDocked('dock-many', { enum: choices });
    await settle();
    expect(radiosOf(container).map((radio) => radio.textContent?.match(/Option \d+/)?.[0])).toEqual(
      choices,
    );
    expect(dockOf(container)!.textContent).not.toMatch(/\d+ more/);
  });

  test('only the list of choices scrolls, and the question and its choices read at 14px', async () => {
    const source = await Bun.file(
      new URL('./question/chat-question-dock.svelte', import.meta.url),
    ).text();
    const body = /\.chat-question-dock-body \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(body).not.toContain('overflow');
    const scroller = /\.chat-question-dock-options-scroll \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(scroller).toContain('overflow-y: auto;');
    // The ring stays inside the scroller, which clips on both axes.
    expect(scroller).toContain('padding: var(--_dock-ring-room);');
    expect(scroller).toContain('margin: calc(var(--_dock-ring-room) * -1);');
    const question = /\n {2}\.chat-question-dock-question \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(question).toContain(
      'font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));',
    );
    expect(question).toContain('font-weight: var(--cinder-font-semibold);');
    const choice = /\.chat-question-dock-choice \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(choice).toContain('font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));');
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

  test('puts a quiet Reply in chat, glyph and words, before the primary Answer', async () => {
    const { container } = mountDocked('dock-actions', ENVIRONMENT);
    await settle();

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>('.chat-question-dock-actions button'),
    ];
    const words = container.querySelector<HTMLButtonElement>('.chat-question-dock-reply-words')!;
    const icon = container.querySelector<HTMLButtonElement>('.chat-question-dock-reply-icon')!;
    const answer = buttons[buttons.length - 1]!;
    expect(buttons.indexOf(words)).toBeLessThan(buttons.indexOf(answer));
    // The visible words are the accessible name, with the glyph beside them.
    expect(words.getAttribute('data-cinder-variant')).toBe('ghost');
    expect(words.textContent?.trim()).toBe('Reply in chat');
    expect(words.getAttribute('aria-label')).toBeNull();
    expect(words.querySelector('svg')).not.toBeNull();
    expect(words.closest('.cinder-tooltip-wrapper')).not.toBeNull();
    // The icon-only fallback is the secondary outline with the same name; it shows only when the
    // row cannot hold the words.
    expect(icon.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(icon.getAttribute('data-cinder-icon-only')).toBe('');
    expect(icon.getAttribute('aria-label') ?? icon.textContent?.trim()).toBe('Reply in chat');
    // Both sit in the wrapper the row's fit marks compact (there is no layout here to measure; the
    // stress guard `readLabelFitProblems` proves the fit in a browser).
    const tip = words.closest('.chat-question-dock-reply-tip');
    expect(tip).not.toBeNull();
    expect(tip?.contains(icon)).toBe(true);
    expect(tip?.hasAttribute('data-chat-reply-compact')).toBe(false);
    expect(answer.textContent?.trim()).toBe('Answer');
    expect(answer.getAttribute('data-cinder-variant')).toBe('primary');
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

  test('Reply in chat gives the composer back and returns the question to its row', async () => {
    const answers: unknown[] = [];
    const { container } = mountDocked('dock-reply', ENVIRONMENT, (_toolCallId, value) => {
      answers.push(value);
    });
    await settle();

    await fireEvent.click(buttonNamed(container, 'Reply in chat')!);
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
  test('keeps an answered question in the round, so the dock can step back to it', () => {
    const store = new QuestionStore(() => false);
    let answer: QuestionAnswerRecord | undefined;
    store.registerDockedQuestion({
      ...dockTarget('first'),
      get answer() {
        return answer;
      },
    });
    store.registerDockedQuestion(dockTarget('second'));
    expect(store.dockRound.map((target) => target.toolCallId)).toEqual(['first', 'second']);

    answer = ANSWER_TO_FIRST;
    expect(store.dockRound.map((target) => target.toolCallId)).toEqual(['first', 'second']);
    expect(store.dockedQuestions.map((target) => target.toolCallId)).toEqual(['second']);
  });

  test('ends the round only once nothing in it is open, so a later question starts a new one', () => {
    const store = new QuestionStore(() => false);
    let answered: QuestionAnswerRecord | undefined;
    store.registerDockedQuestion({
      ...dockTarget('first-round'),
      get answer() {
        return answered;
      },
    });
    store.registerDockedQuestion(dockTarget('still-open'));
    answered = ANSWER_TO_FIRST;

    // A question is still open: the round goes on.
    store.closeDockRound();
    expect(store.dockRound).toHaveLength(2);
  });

  test('closing a round with every question answered empties it, and a new question starts another', () => {
    const store = new QuestionStore(() => false);
    store.registerDockedQuestion({ ...dockTarget('first-round'), answer: ANSWER_TO_FIRST });
    store.viewDock('first-round');
    store.closeDockRound();
    expect(store.dockRound).toEqual([]);
    expect(store.viewedDock).toBeUndefined();

    store.registerDockedQuestion(dockTarget('second-round'));
    expect(store.dockRound.map((target) => target.toolCallId)).toEqual(['second-round']);
  });

  test('reset forgets the round, the question being viewed and the retired questions', () => {
    const store = new QuestionStore(() => false);
    store.registerDockedQuestion({ ...dockTarget('stale-round'), answer: ANSWER_TO_FIRST });
    store.closeDockRound();
    store.viewDock('stale-round');
    store.reset();

    expect(store.viewedDock).toBeUndefined();
    expect(store.dockRound).toEqual([]);
  });

  test('a question that leaves the round is no longer counted', () => {
    const store = new QuestionStore(() => false);
    const removeFirst = store.registerDockedQuestion(dockTarget('first'));
    store.registerDockedQuestion(dockTarget('second'));
    removeFirst();

    expect(store.dockRound.map((target) => target.toolCallId)).toEqual(['second']);
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
    expect(container.querySelector('[data-chat-question-previous]')).toBeNull();
    expect(container.querySelector('[data-chat-question-next]')).toBeNull();
  });

  describe('moving between them', () => {
    const REGION = { enum: ['east', 'west'] };

    async function mountThree(answers: [string, unknown][]) {
      const mounted = render(Chat, {
        id: 'dock-steps',
        conversation: conversationWith('dock-steps', [
          { id: 'first', message: 'Which environment?', schema: ENVIRONMENT },
          { id: 'second', message: 'Which region?', schema: REGION },
          { id: 'third', message: 'Which tier?', schema: { enum: ['free', 'paid'] } },
        ]),
        questionPlacement: 'docked',
        onInputSubmit: (toolCallId: string, value: unknown) => {
          answers.push([toolCallId, value]);
        },
      });
      await settle();
      return mounted;
    }

    const previousOf = (container: HTMLElement) =>
      container.querySelector<HTMLButtonElement>('[data-chat-question-previous]')!;
    const nextOf = (container: HTMLElement) =>
      container.querySelector<HTMLButtonElement>('[data-chat-question-next]')!;
    const shownOf = (container: HTMLElement) => dockOf(container)!.dataset['chatQuestionId'];

    test('puts the tag, the progress and the two buttons in the header before the choices, with the question under them', async () => {
      const { container } = await mountThree([]);

      const heading = dockOf(container)!.querySelector('[data-chat-question-heading]')!;
      expect(
        [...heading.children].map((child) => child.getAttribute('class')?.split(' ')[0]),
      ).toEqual([
        'chat-question-dock-needs',
        'chat-question-dock-steps',
        'chat-question-dock-question',
      ]);
      expect(heading.querySelector('[data-chat-question-progress]')?.textContent?.trim()).toBe(
        'Question 1 of 3',
      );
      // The buttons come after the tag and before the choices in the tab order.
      const order = [
        ...dockOf(container)!.querySelectorAll(
          '[data-chat-question-needs], [data-chat-question-previous], [data-chat-question-next], [role="radio"]',
        ),
      ];
      expect(order[0]!.hasAttribute('data-chat-question-needs')).toBe(true);
      expect(order[1]).toBe(previousOf(container));
      expect(order[2]).toBe(nextOf(container));
      expect(order[3]!.getAttribute('role')).toBe('radio');
      expect(
        previousOf(container).getAttribute('aria-label') ?? previousOf(container).textContent,
      ).toContain('Previous question');
      expect(
        nextOf(container).getAttribute('aria-label') ?? nextOf(container).textContent,
      ).toContain('Next question');
    });

    test('turns previous off on the first question and next off on the last', async () => {
      const { container } = await mountThree([]);

      expect(previousOf(container).disabled).toBe(true);
      expect(nextOf(container).disabled).toBe(false);

      await fireEvent.click(nextOf(container));
      await settle();
      expect(shownOf(container)).toBe('second');
      expect(previousOf(container).disabled).toBe(false);
      expect(nextOf(container).disabled).toBe(false);

      await fireEvent.click(nextOf(container));
      await settle();
      expect(shownOf(container)).toBe('third');
      expect(nextOf(container).disabled).toBe(true);
      expect(previousOf(container).disabled).toBe(false);
    });

    test('moves between the questions without sending anything, and keeps the question as the name of the choices', async () => {
      const answers: [string, unknown][] = [];
      const { container } = await mountThree(answers);

      await fireEvent.click(nextOf(container));
      await settle();
      expect(container.querySelector('[data-chat-question-progress]')?.textContent?.trim()).toBe(
        'Question 2 of 3',
      );
      expect(dockOf(container)!.querySelector('.chat-question-dock-question')?.textContent).toBe(
        'Which region?',
      );
      const group = dockOf(container)!.querySelector('[role="radiogroup"]')!;
      expect(group.getAttribute('aria-labelledby')).toBe(
        dockOf(container)!.querySelector('.chat-question-dock-question')!.id,
      );
      // The choices of the question now shown, and no selection carried over.
      expect(radiosOf(container)).toHaveLength(2);
      expect(
        radiosOf(container).every((radio) => radio.getAttribute('aria-checked') === 'false'),
      ).toBe(true);

      await fireEvent.click(previousOf(container));
      await settle();
      expect(shownOf(container)).toBe('first');
      expect(answers).toEqual([]);
    });

    test('keeps focus on a navigation button that is still on when the one pressed turns off', async () => {
      const { container } = await mountThree([]);

      await fireEvent.click(nextOf(container));
      await settle();
      nextOf(container).focus();
      await fireEvent.click(nextOf(container));
      await settle();

      expect(nextOf(container).disabled).toBe(true);
      expect(document.activeElement).toBe(previousOf(container));
    });

    test('shows an answered question with its answer selected, and sends a changed one the way Change does', async () => {
      const answers: [string, unknown][] = [];
      const { container } = await mountThree(answers);

      await fireEvent.click(radiosOf(container)[1]!);
      sendDock(container);
      await settle();
      // The dock moved on to the first open question and counts the answered one.
      expect(shownOf(container)).toBe('second');
      expect(container.querySelector('[data-chat-question-progress]')?.textContent?.trim()).toBe(
        'Question 2 of 3',
      );

      await fireEvent.click(previousOf(container));
      await settle();
      expect(shownOf(container)).toBe('first');
      expect(radiosOf(container).map((radio) => radio.getAttribute('aria-checked'))).toEqual([
        'false',
        'true',
        'false',
      ]);
      // Nothing to send until the answer is changed.
      expect(buttonNamed(container, 'Answer')?.disabled).toBe(true);

      await fireEvent.click(radiosOf(container)[2]!);
      expect(buttonNamed(container, 'Answer')?.disabled).toBe(false);
      sendDock(container);
      await settle();

      expect(answers).toEqual([
        ['first', 'production'],
        ['first', 'canary'],
      ]);
      // The changed answer is what the receipt now says, and the dock is on the open question again.
      expect(shownOf(container)).toBe('second');
      expect(container.querySelector('[data-question-answer]')?.textContent).toContain('Canary');
    });

    test('keeps an answered question in the round, read only with one line saying it was sent, once its call resolves', async () => {
      const answers: [string, unknown][] = [];
      const view = await mountThree(answers);
      const container = view.container;

      await fireEvent.click(radiosOf(container)[0]!);
      sendDock(container);
      await settle();

      // The run took the first answer: its call now has the tool's own result, while the other two
      // questions are still open.
      let resumed = appendUserMessage(createConversationHistory({ id: 'dock-steps' }), 'deploy it');
      resumed = appendToolResult(
        appendToolCall(resumed, { id: 'first', name: 'requestHumanInput', arguments: {} }),
        { callId: 'first', outcome: 'success', content: 'staging' },
      );
      for (const [id, message, schema] of [
        ['second', 'Which region?', REGION],
        ['third', 'Which tier?', { enum: ['free', 'paid'] }],
      ] as const) {
        resumed = appendToolResult(
          appendToolCall(resumed, { id, name: 'requestHumanInput', arguments: {} }),
          {
            callId: id,
            outcome: 'action_required',
            content: null,
            action: { type: 'input', message, schema: { ...schema } },
          },
        );
      }
      await view.rerender({ conversation: resumed });
      await settle();

      // The count does not shrink and the way back to the answered question stays.
      expect(shownOf(container)).toBe('second');
      expect(container.querySelector('[data-chat-question-progress]')?.textContent?.trim()).toBe(
        'Question 2 of 3',
      );
      await fireEvent.click(previousOf(container));
      await settle();
      expect(shownOf(container)).toBe('first');
      expect(radiosOf(container).map((radio) => radio.getAttribute('aria-checked'))).toEqual([
        'true',
        'false',
        'false',
      ]);
      expect(dockOf(container)!.querySelector('[data-chat-question-sent]')?.textContent).toBe(
        'This answer was sent.',
      );
      // Read only: the choices and Answer are off, and the keys choose nothing.
      expect(
        radiosOf(container).every(
          (radio) =>
            radio.getAttribute('aria-disabled') === 'true' || radio.hasAttribute('disabled'),
        ),
      ).toBe(true);
      expect(buttonNamed(container, 'Answer')?.disabled).toBe(true);
      await fireEvent.keyDown(radiosOf(container)[0]!, { key: '2' });
      expect(radiosOf(container)[1]!.getAttribute('aria-checked')).toBe('false');
      sendDock(container);
      await settle();
      expect(answers).toEqual([['first', 'staging']]);
    });

    test('the keys still choose a card of the question shown, and add no shortcut of their own', async () => {
      const { container } = await mountThree([]);

      await fireEvent.click(nextOf(container));
      await settle();
      await fireEvent.keyDown(radiosOf(container)[0]!, { key: '2' });
      expect(radiosOf(container)[1]!.getAttribute('aria-checked')).toBe('true');
      // Arrow keys on a navigation button do not move between questions.
      await fireEvent.keyDown(nextOf(container), { key: 'ArrowRight' });
      await settle();
      expect(shownOf(container)).toBe('second');
    });

    test('ends the round when the last question is answered, so a later question reads one of one', async () => {
      const { container } = render(Chat, {
        id: 'dock-round',
        conversation: single('dock-round', ENVIRONMENT),
        questionPlacement: 'docked',
        onInputSubmit: () => undefined,
      });
      await settle();

      await fireEvent.click(radiosOf(container)[0]!);
      sendDock(container);
      await settle();

      expect(dockOf(container)).toBeNull();
    });
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

describe('a question the host draws (questionDock, COR-2437)', () => {
  const hostQuestion = createRawSnippet(() => ({
    render: () => '<fieldset data-host-question><legend>Which environment?</legend></fieldset>',
  }));

  test('docks in the composer’s place in one panel, keeping the composer mounted', async () => {
    const { container } = render(Chat, {
      id: 'host-dock',
      conversation: appendUserMessage(createConversationHistory({ id: 'host-dock' }), 'deploy'),
      questionDock: hostQuestion,
    });
    await settle();

    const dock = container.querySelector<HTMLElement>('[data-chat-question-dock="host"]');
    expect(dock?.querySelector('[data-host-question]')).not.toBeNull();
    expect(container.querySelector('.chat-input-area')?.hasAttribute('data-question-docked')).toBe(
      true,
    );
    // The composer is out of sight but still there, so a draft survives.
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  test('gives way to a blocked composer, which has nothing to give back', async () => {
    const { container } = render(Chat, {
      id: 'host-dock-blocked',
      conversation: appendUserMessage(
        createConversationHistory({ id: 'host-dock-blocked' }),
        'deploy',
      ),
      questionDock: hostQuestion,
      composerStatus: { kind: 'blocked', reason: 'Sending is off' },
    });
    await settle();

    expect(container.querySelector('[data-chat-question-dock="host"]')).toBeNull();
  });
});
