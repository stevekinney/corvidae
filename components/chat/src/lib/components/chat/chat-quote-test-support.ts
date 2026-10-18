/**
 * Shared helpers for the Chat quote tests: building selections inside rendered
 * messages and reading the quote popover and chip row.
 */

/// <reference lib="dom" />

/** The first text node under `root` whose text contains `text`. */
function textNodeContaining(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.textContent.includes(text)) return node;
  }
  throw new Error(`No text node under the given element contains "${text}"`);
}

function applyRange(range: Range): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('This document has no selection');
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Selects exactly `text` inside `root`. */
export function selectText(root: Element, text: string): void {
  const node = textNodeContaining(root, text);
  const start = node.textContent.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  applyRange(range);
}

/** Selects from `startText` inside `startRoot` through `endText` inside `endRoot`. */
export function selectBetween(
  startRoot: Element,
  startText: string,
  endRoot: Element,
  endText: string,
): void {
  const startNode = textNodeContaining(startRoot, startText);
  const endNode = textNodeContaining(endRoot, endText);
  const range = document.createRange();
  range.setStart(startNode, startNode.textContent.indexOf(startText));
  range.setEnd(endNode, endNode.textContent.indexOf(endText) + endText.length);
  applyRange(range);
}

/**
 * happy-dom lays nothing out, so every range reports a zero rectangle, which
 * Chat treats as an invisible selection. Gives ranges a visible rectangle for
 * the duration of a test file. Returns a function that restores the originals.
 */
export function giveRangesGeometry(): () => void {
  const rect = {
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 220,
    bottom: 120,
    width: 120,
    height: 20,
    toJSON: () => ({}),
  };
  const names = ['getBoundingClientRect', 'getClientRects'] as const;
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(Range.prototype, name));
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => Object.assign([rect], { item: () => rect }),
  });
  return () => {
    names.forEach((name, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(Range.prototype, name, original);
    });
  };
}

/** The Quote popover's toolbar, whether or not it is open. */
export function quotePopover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Quote selection"]');
}

/** Whether the Quote popover is currently shown. */
export function isQuotePopoverOpen(): boolean {
  const toolbar = quotePopover();
  return (
    toolbar !== null &&
    toolbar.hasAttribute('data-cinder-visible') &&
    !toolbar.hasAttribute('data-cinder-closing')
  );
}

/** The Quote button inside the popover. */
export function popoverQuoteButton(): HTMLButtonElement | null {
  return (
    quotePopover()?.querySelector<HTMLButtonElement>('button[aria-label="Quote"], button') ?? null
  );
}

/** The chips above the composer, in order. */
export function quoteChips(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[aria-label="Quoted excerpts"] [data-quote-chip]'),
  );
}

/** Every per-message "Quote message" button, in transcript order. */
export function quoteMessageButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-label="Quote message"]'),
  );
}
