import type { SelectionPopoverPosition } from '@lostgradient/cinder';
import { normalizeQuoteText } from '../utilities/quote-composition.ts';

/**
 * The attribute that marks an assistant message's content as quotable. Its
 * value is the message id. A selection is quotable only when it starts and ends
 * inside the same marked element.
 */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-quote-source';

type QuoteSelectionOptions = {
  /** The Chat root. Only selections inside it can open the popover. */
  getRoot: () => HTMLElement | null;
};

export interface UseChatQuoteSelectionReturn {
  /** Whether the Quote popover should be showing. */
  readonly open: boolean;
  /** Where to anchor it, in viewport coordinates. */
  readonly position: SelectionPopoverPosition | null;
  /** The text the popover would quote, as it stood when the popover opened. */
  readonly text: string;
  /** Hides the popover. */
  dismiss(): void;
}

function quoteSourceOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`) ?? null;
}

/** The part of the selection that is visible, as an anchor for the popover. */
function anchorFor(range: Range): SelectionPopoverPosition | null {
  const rect =
    Array.from(range.getClientRects()).find(
      (clientRect) => clientRect.width > 0 && clientRect.height > 0,
    ) ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top, height: rect.height };
}

/**
 * Watches the document selection and opens the Quote popover while it lies
 * wholly inside one assistant message's content. While a pointer is down the
 * selection is still being dragged, so the popover waits for its release.
 */
export function useChatQuoteSelection(options: QuoteSelectionOptions): UseChatQuoteSelectionReturn {
  let open = $state(false);
  let position = $state<SelectionPopoverPosition | null>(null);
  let text = $state('');
  let pointerDown = false;

  function dismiss(): void {
    open = false;
    position = null;
    text = '';
  }

  function evaluate(): void {
    if (pointerDown) return;
    const root = options.getRoot();
    const selection = document.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      dismiss();
      return;
    }
    const range = selection.getRangeAt(0);
    const source = quoteSourceOf(range.startContainer);
    if (!source || source !== quoteSourceOf(range.endContainer) || !root.contains(source)) {
      dismiss();
      return;
    }
    const selected = normalizeQuoteText(selection.toString());
    const anchor = anchorFor(range);
    if (selected === '' || anchor === null) {
      dismiss();
      return;
    }
    text = selected;
    position = anchor;
    open = true;
  }

  function handlePointerDown(): void {
    pointerDown = true;
  }

  function handlePointerUp(): void {
    pointerDown = false;
    evaluate();
  }

  $effect(() => {
    document.addEventListener('selectionchange', evaluate);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    document.addEventListener('pointercancel', handlePointerUp, true);
    return () => {
      document.removeEventListener('selectionchange', evaluate);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      document.removeEventListener('pointercancel', handlePointerUp, true);
      pointerDown = false;
    };
  });

  return {
    get open() {
      return open;
    },
    get position() {
      return position;
    },
    get text() {
      return text;
    },
    dismiss,
  };
}
