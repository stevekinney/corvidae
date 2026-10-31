/**
 * UI-only state the transcript's questions share: which are answered, and which free-text
 * question the composer answers.
 *
 * Like the approval states, none of it is written back to the transcript. {@link Chat} makes one
 * store and offers it through Svelte context; a question rendered without one (a reviews inbox, a
 * test) keeps its own.
 */

import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import type { QuestionAnswerRecord } from './question-answer.ts';

/** The largest file a file question takes when the host sets no limit: the composer's own default. */
export const DEFAULT_MAXIMUM_FILE_SIZE = 10 * 1024 * 1024;

/** A free-text question the composer answers. */
export interface ComposerQuestionTarget {
  /** The tool call the question parked. */
  readonly toolCallId: string;
  /** Submits `text` as the answer; resolves `true` when the host accepted it. */
  readonly submit: (text: string) => Promise<boolean>;
}

/** The shared state of a transcript's questions. */
export class QuestionStore {
  /** The answered questions, by tool call id. */
  readonly answers = new SvelteMap<string, QuestionAnswerRecord>();

  readonly #composerTargets = new SvelteMap<string, ComposerQuestionTarget>();
  readonly #answerInComposer: () => boolean;
  readonly #uploadFile: () => ((file: File, signal: AbortSignal) => Promise<string>) | undefined;
  readonly #maxFileSize: () => number | undefined;

  /**
   * @param answerInComposer - Whether the host answers free text through the composer.
   * @param uploadFile - Stores a file for a file question and answers its asset id, when the host can.
   * @param maxFileSize - Largest file a file question takes, in bytes; the composer's limit.
   */
  constructor(
    answerInComposer: () => boolean,
    uploadFile: () => ((file: File, signal: AbortSignal) => Promise<string>) | undefined = () =>
      undefined,
    maxFileSize: () => number | undefined = () => undefined,
  ) {
    this.#maxFileSize = maxFileSize;
    this.#answerInComposer = answerInComposer;
    this.#uploadFile = uploadFile;
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

  /** The free-text question the composer answers now: the most recent one that is still open. */
  get composerTarget(): ComposerQuestionTarget | undefined {
    if (!this.#answerInComposer()) return undefined;
    let latest: ComposerQuestionTarget | undefined;
    for (const target of this.#composerTargets.values()) latest = target;
    return latest;
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
