import { tick, untrack } from 'svelte';
import type { Message } from '../conversation-model.ts';
import { approvalPlacementHeld } from './chat-approval-review.ts';
import { commandFailureHeld } from './command-failure-reveal.ts';
import {
  keepPinnedThroughResize,
  startSideRest,
  type PinnedThroughResize,
} from './keep-pinned-through-resize.ts';
import { isAtBottom as checkIsAtBottom } from './scroll-utilities.ts';
import type { useChatHistoryLifecycle } from './use-chat-history-lifecycle.svelte.ts';
import type { useChatHistoryRestoration } from './use-chat-history-restoration.svelte.ts';
import type { UseChatScrollStateReturn } from './use-chat-scroll-state.svelte.ts';
import type { ChatVirtualizer } from './use-chat-virtualizer.svelte.ts';

type AutoScrollState = Pick<
  UseChatScrollStateReturn,
  'atBottom' | 'isUserScrolling' | 'recomputeFromViewport'
>;
type AutoScrollVirtualizer = Pick<ChatVirtualizer, 'scrollSize' | 'scrollToOffset'>;
type AutoScrollHistoryLifecycle = Pick<ReturnType<typeof useChatHistoryLifecycle>, 'pending'>;
type AutoScrollHistoryRestoration = Pick<
  ReturnType<typeof useChatHistoryRestoration>,
  'historyAnchorMessageId' | 'waitForLayoutFrame'
>;

export interface UseChatAutoScrollOptions {
  getViewport: () => HTMLElement | null;
  getMessages: () => Message[];
  getIsVirtualized: () => boolean;
  getBottomThreshold: () => number;
  getVirtualizationInitialHeight: () => number;
  getScrollState: () => AutoScrollState;
  getVirtualizer: () => AutoScrollVirtualizer;
  getHistoryLifecycle: () => AutoScrollHistoryLifecycle;
  getHistoryRestoration: () => AutoScrollHistoryRestoration;
  getIsEditing: () => boolean;
  /**
   * Whether a row resting at the end of the reading box is clear of the transcript's end fade:
   * true where the fade is a mask (the stylesheet keeps the fade's size clear) or nothing fades,
   * false where an overlay fades the end with no room kept clear (the default surface with
   * `scrollFadeVisible`), where the transcript rests at its true end.
   */
  getStartSideRestAllowed: () => boolean;
}

export interface UseChatAutoScrollReturn {
  resetPrependSuppression(): void;
  /**
   * Where `viewport` rests now: the smallest scroll that clears its last row, or its true end where
   * it cannot rest from its start. Jump to latest lands here, so it rests where every other rest
   * does and a reply that streams after it moves the transcript on and never back.
   */
  restingTop(viewport: HTMLElement): number;
  /**
   * The page scrolled the transcript itself (Jump to latest): that scroll is not a person taking
   * the transcript to its end, whatever they pressed to ask for it.
   */
  pageScrolled(): void;
}

type TranscriptGrowth = {
  currentCount: number;
  currentScrollExtent: number;
  previousVirtualExtent: number | null;
  isTranscriptGrowth: boolean;
  isHistoryPrepend: boolean;
  isTranscriptAppend: boolean;
};

export function useChatAutoScroll(options: UseChatAutoScrollOptions): UseChatAutoScrollReturn {
  let previousMessageCount = untrack(() => options.getMessages().length);
  let previousFirstMessageId = untrack(() => options.getMessages()[0]?.id);
  let previousLastMessageId = untrack(() => options.getMessages().at(-1)?.id);
  let previousVirtualExtent: number | null = null;
  let prependSuppressed = false;
  // The record of where the transcript that is mounted now rests (`keepPinnedThroughResize`).
  let pin: PinnedThroughResize | null = null;

  const resetPrependSuppression = (): void => {
    prependSuppressed = false;
  };

  const captureTranscriptGrowth = (
    viewport: HTMLElement,
    virtualized: boolean,
    virtualizer: AutoScrollVirtualizer,
  ): TranscriptGrowth => {
    const messages = options.getMessages();
    const currentCount = messages.length;
    const isTranscriptGrowth = currentCount > previousMessageCount;
    previousMessageCount = currentCount;
    const currentFirstMessageId = messages[0]?.id;
    const currentLastMessageId = messages.at(-1)?.id;
    const isHistoryPrepend =
      isTranscriptGrowth &&
      currentFirstMessageId !== previousFirstMessageId &&
      currentLastMessageId === previousLastMessageId;
    previousFirstMessageId = currentFirstMessageId;
    previousLastMessageId = currentLastMessageId;
    const isTranscriptAppend = isTranscriptGrowth && !isHistoryPrepend;
    if (isTranscriptAppend) prependSuppressed = false;
    const currentScrollExtent = virtualized ? virtualizer.scrollSize : viewport.scrollHeight;
    const previousExtent = previousVirtualExtent;
    previousVirtualExtent = virtualized ? currentScrollExtent : null;
    return {
      currentCount,
      currentScrollExtent,
      previousVirtualExtent: previousExtent,
      isTranscriptGrowth,
      isHistoryPrepend,
      isTranscriptAppend,
    };
  };

  const correctVirtualizedViewport = (viewport: HTMLElement): void => {
    const virtualizer = options.getVirtualizer();
    const maximumOffset = Math.max(
      0,
      virtualizer.scrollSize - (viewport.clientHeight || options.getVirtualizationInitialHeight()),
    );
    if (Math.abs((viewport.scrollTop || 0) - maximumOffset) <= 1) return;
    virtualizer.scrollToOffset(virtualizer.scrollSize, { behavior: 'instant' });
  };

  // Rests the transcript where the layout as it is now says it rests: from its start, at the
  // smallest scroll that clears its last row, or at its true end where it cannot rest from its
  // start (an overlay fades the end, the transcript is virtualized, no row is laid out). A message
  // that arrives and a layout that changes both come here, so the same rows in the same box rest
  // in the same place whichever came first, and every rest is recorded.
  const applyBottomCorrection = (): void => {
    const viewport = options.getViewport();
    if (!viewport) return;
    if (
      options.getHistoryLifecycle().pending ||
      options.getHistoryRestoration().historyAnchorMessageId !== null
    ) {
      return;
    }
    if (options.getIsEditing()) {
      options.getScrollState().recomputeFromViewport(viewport);
      return;
    }
    if (options.getScrollState().isUserScrolling) return;
    // A waiting approval's arrival placement rests the transcript by its own rule.
    if (approvalPlacementHeld(viewport)) return;
    if (options.getIsVirtualized()) {
      correctVirtualizedViewport(viewport);
      pin?.rested();
      return;
    }
    // A transcript a person took to its true end is theirs there: it is followed to its end.
    const top = pin?.takenToEnd() === true ? viewport.scrollHeight : restingTop(viewport);
    viewport.scrollTo({ top, behavior: 'instant' });
    pin?.rested();
  };

  const restingTop = (viewport: HTMLElement): number =>
    (!options.getIsVirtualized() && options.getStartSideRestAllowed()
      ? startSideRest(viewport)
      : null) ?? viewport.scrollHeight;

  const scheduleBottomCorrection = (isTranscriptAppend: boolean): (() => void) => {
    let cancelled = false;
    const waitForBottomTarget = isTranscriptAppend
      ? options.getHistoryRestoration().waitForLayoutFrame()
      : tick();
    void waitForBottomTarget.then(() => {
      if (cancelled) return undefined;
      applyBottomCorrection();
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  };

  const shouldAcceptPrepend = (
    viewport: HTMLElement,
    growth: TranscriptGrowth,
    virtualized: boolean,
  ): boolean => {
    if (!growth.isHistoryPrepend) return true;
    const extent =
      virtualized && growth.previousVirtualExtent !== null
        ? growth.previousVirtualExtent
        : growth.currentScrollExtent;
    const genuinelyAtBottom = checkIsAtBottom(
      {
        scrollTop: viewport.scrollTop,
        scrollHeight: extent,
        clientHeight: viewport.clientHeight,
      },
      options.getBottomThreshold(),
    );
    prependSuppressed = !genuinelyAtBottom;
    return genuinelyAtBottom;
  };

  const hasActiveHistoryAnchor = (): boolean =>
    untrack(
      () =>
        options.getHistoryLifecycle().pending !== null ||
        options.getHistoryRestoration().historyAnchorMessageId !== null,
    );

  const shouldSkipCorrection = (
    viewport: HTMLElement,
    growth: TranscriptGrowth,
    virtualized: boolean,
    scrollState: AutoScrollState,
  ): boolean =>
    scrollState.isUserScrolling ||
    !shouldAcceptPrepend(viewport, growth, virtualized) ||
    hasActiveHistoryAnchor() ||
    (!growth.isTranscriptGrowth && prependSuppressed);

  $effect.pre(() => {
    const viewport = options.getViewport();
    if (!viewport) return undefined;
    const virtualized = options.getIsVirtualized();
    const virtualizer = options.getVirtualizer();
    const growth = captureTranscriptGrowth(viewport, virtualized, virtualizer);
    const scrollState = options.getScrollState();
    const atBottom = untrack(() => scrollState.atBottom);
    if (shouldSkipCorrection(viewport, growth, virtualized, scrollState)) return undefined;

    const activeEditNeedsScrollRecompute =
      growth.isTranscriptAppend && untrack(() => options.getIsEditing());
    if ((atBottom || activeEditNeedsScrollRecompute) && growth.currentCount > 0)
      return scheduleBottomCorrection(growth.isTranscriptAppend);

    return undefined;
  });

  // The transcript is rested again whenever its layout changes with no message arriving: its own
  // box (a notice that grows the composer, a keyboard, a smaller window) or the box of any row (a
  // panel that sizes itself after it loads, highlighted code, a font, an image).
  $effect(() => {
    const viewport = options.getViewport();
    if (!viewport) return undefined;
    const kept = keepPinnedThroughResize(viewport, () => {
      // An empty or welcome transcript has no last row to rest on: it is never moved.
      if (options.getMessages().length === 0) return;
      // Earlier messages were put before a transcript that was not at its end: the rows that
      // changed are the ones a person is reading, and their place is kept, as a message's own
      // correction keeps it.
      if (prependSuppressed) return;
      // A refusal being kept in view rests the transcript itself (`commandFailureHeld`).
      if (commandFailureHeld(viewport)) return;
      applyBottomCorrection();
    });
    pin = kept;
    return () => {
      kept.stop();
      if (pin === kept) pin = null;
    };
  });

  return { resetPrependSuppression, restingTop, pageScrolled: () => pin?.pageScrolled() };
}
