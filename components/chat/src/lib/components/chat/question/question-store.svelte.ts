/**
 * UI-only state the transcript's questions share: which are answered, and which free-text
 * question the composer answers.
 *
 * Like the approval states, none of it is written back to the transcript. {@link Chat} makes one
 * store and offers it through Svelte context; a question rendered without one (a reviews inbox, a
 * test) keeps its own.
 */

import { getContext, setContext } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { ChatQuestionIssue, QuestionAnswerRecord } from './question-answer.ts';
/** The largest file a file question takes when the host sets no limit: the composer's own default. */
export const DEFAULT_MAXIMUM_FILE_SIZE = 10 * 1024 * 1024;

/** A question the composer answers: free text, or a choice that also takes the person's own answer. */
export interface ComposerQuestionTarget {
  /** The tool call the question parked. */
  readonly toolCallId: string;
  /** What the question asks: `text`, or `choice-other`, picked from choices or typed in the composer. */
  readonly kind: 'text' | 'choice-other';
  /** Submits `text` as the answer; resolves `true` when the host accepted it. */
  readonly submit: (text: string) => Promise<boolean>;
}

/** Where a question that has choices is answered: in the transcript row, or docked in place of the composer. */
export type QuestionPlacement = 'inline' | 'docked';

/**
 * A choice question the dock asks in place of the composer. It stays in the dock's round after it
 * is answered, so the person can step back to it and change the answer, until the run moves on or
 * the person replies in chat instead.
 */
export interface DockedQuestionTarget {
  /** The tool call the question parked. */
  readonly toolCallId: string;
  /** The answer that was sent, or `undefined` while the question is open. */
  readonly answer: QuestionAnswerRecord | undefined;
  /** The answer schema, which says which choices to draw. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** What the question asks. */
  readonly message: string | undefined;
  /** Submits `value` as the answer; resolves `true` when the host accepted it. */
  readonly submit: (value: unknown) => Promise<boolean>;
  /** Whether an answer is being sent. */
  readonly busy: boolean;
  /** Whether the last answer could not be sent for a reason the person cannot fix by editing. */
  readonly failed: boolean;
  /** Why the host refused the last answer. */
  readonly issues: readonly ChatQuestionIssue[];
}

/** The shared state of a transcript's questions. */
export class QuestionStore {
  /** The answered questions, by tool call id. */
  readonly answers = new SvelteMap<string, QuestionAnswerRecord>();

  #generation = 0;

  readonly #composerTargets = new SvelteMap<string, ComposerQuestionTarget>();
  readonly #dockTargets = new SvelteMap<string, DockedQuestionTarget>();
  readonly #dismissedDocks = new SvelteSet<string>();
  // The questions of rounds that ended: every one in them was answered and the dock closed.
  readonly #retiredDocks = new SvelteSet<string>();
  #viewedDock = $state<string | undefined>();
  readonly #placement: () => QuestionPlacement;
  readonly #answerInComposer: () => boolean;
  readonly #uploadFile: () => ((file: File, signal: AbortSignal) => Promise<string>) | undefined;
  readonly #maxFileSize: () => number | undefined;

  /**
   * @param answerInComposer - Whether the host answers free text through the composer.
   * @param uploadFile - Stores a file for a file question and answers its asset id, when the host can.
   * @param maxFileSize - Largest file a file question takes, in bytes; the composer's limit.
   * @param placement - Where a question that has choices is answered; `docked` puts it in place of the composer.
   */
  constructor(
    answerInComposer: () => boolean,
    uploadFile: () => ((file: File, signal: AbortSignal) => Promise<string>) | undefined = () =>
      undefined,
    maxFileSize: () => number | undefined = () => undefined,
    placement: () => QuestionPlacement = () => 'inline',
  ) {
    this.#placement = placement;
    this.#maxFileSize = maxFileSize;
    this.#answerInComposer = answerInComposer;
    this.#uploadFile = uploadFile;
  }

  /**
   * Counts the conversations this store has served. An answer in flight remembers the number it
   * started under and is dropped if the store has moved on, so a late completion cannot write into
   * the next conversation.
   */
  get generation(): number {
    return this.#generation;
  }

  /** Forgets every answer and open question, for a different conversation. */
  reset(): void {
    this.#generation += 1;
    this.answers.clear();
    this.#composerTargets.clear();
    this.#dockTargets.clear();
    this.#dismissedDocks.clear();
    this.#retiredDocks.clear();
    this.#viewedDock = undefined;
  }

  /** Whether free text is answered through the composer. */
  get answerInComposer(): boolean {
    return this.#answerInComposer();
  }

  /** The host's file store for a file question, if it has one. */
  get uploadFile(): ((file: File, signal: AbortSignal) => Promise<string>) | undefined {
    return this.#uploadFile();
  }

  /** Largest file a file question takes, in bytes. */
  get maxFileSize(): number {
    return this.#maxFileSize() ?? DEFAULT_MAXIMUM_FILE_SIZE;
  }

  /** The question the composer answers now: the most recent one that is still open. */
  get composerTarget(): ComposerQuestionTarget | undefined {
    if (!this.#answerInComposer()) return undefined;
    let latest: ComposerQuestionTarget | undefined;
    for (const target of this.#composerTargets.values()) latest = target;
    return latest;
  }

  /** Where a question that has choices is answered. */
  get placement(): QuestionPlacement {
    return this.#placement();
  }

  /** Whether the person chose to reply in chat instead of answering the docked question `toolCallId`. */
  isDockDismissed(toolCallId: string): boolean {
    return this.#dismissedDocks.has(toolCallId);
  }

  /** Puts the docked question `toolCallId` back in its transcript row, so the composer is free for a reply. */
  dismissDock(toolCallId: string): void {
    this.#dismissedDocks.add(toolCallId);
  }

  /**
   * The questions asked together, in the order they were asked: the open ones and the ones already
   * answered that can still be changed. The dock's `Question 2 of 4` counts through this list.
   */
  get dockRound(): DockedQuestionTarget[] {
    return [...this.#dockTargets.values()].filter(
      (target) => !this.#retiredDocks.has(target.toolCallId),
    );
  }

  /** The docked questions that are still open, in the order they were asked. */
  get dockedQuestions(): DockedQuestionTarget[] {
    return this.dockRound.filter((target) => target.answer === undefined);
  }

  /** The question the dock was moved to with its previous and next buttons, or `undefined` to show the first open one. */
  get viewedDock(): string | undefined {
    return this.#viewedDock;
  }

  /** Moves the dock to the question `toolCallId`, or back to the first open one with `undefined`. Nothing is sent. */
  viewDock(toolCallId: string | undefined): void {
    this.#viewedDock = toolCallId;
  }

  /**
   * Ends the round once nothing in it is open: its answered questions leave the dock, so a question
   * asked later starts a new round and reads `Question 1 of 1`, not the next of an old one.
   */
  closeDockRound(): void {
    if (this.dockedQuestions.length > 0) return;
    for (const target of this.dockRound) this.#retiredDocks.add(target.toolCallId);
    this.#viewedDock = undefined;
  }

  /** Makes `target` a question of the dock's round, until the returned function is called. */
  registerDockedQuestion(target: DockedQuestionTarget): () => void {
    this.#dockTargets.set(target.toolCallId, target);
    return () => {
      if (this.#dockTargets.get(target.toolCallId) === target) {
        this.#dockTargets.delete(target.toolCallId);
        this.#retiredDocks.delete(target.toolCallId);
      }
    };
  }

  /** Makes `target` the open question the composer answers, until the returned function is called. */
  registerComposerTarget(target: ComposerQuestionTarget): () => void {
    this.#composerTargets.set(target.toolCallId, target);
    return () => {
      if (this.#composerTargets.get(target.toolCallId) === target) {
        this.#composerTargets.delete(target.toolCallId);
      }
    };
  }
}

const QUESTION_STORE_KEY = Symbol('chat-question-store');

/** Offers `store` to the questions rendered below the calling component. */
export function provideQuestionStore(store: QuestionStore): void {
  setContext(QUESTION_STORE_KEY, store);
}

/** The store {@link Chat} offered, or `undefined` outside one. */
export function useQuestionStore(): QuestionStore | undefined {
  return getContext<QuestionStore | undefined>(QUESTION_STORE_KEY);
}
