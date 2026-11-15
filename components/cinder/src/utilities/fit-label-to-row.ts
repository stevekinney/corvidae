import type { Attachment } from 'svelte/attachments';

/** What {@link createLabelFit} needs to know about the row it is attached to. */
export type LabelFitOptions = {
  /** A selector, within the row, for the control whose words give way to its icon. */
  control: string;
  /** The attribute set on that control while the row cannot hold its words on one line. */
  attribute: string;
  /**
   * A selector for parts of the row that are meant to take a line of their own (an arming hint),
   * which are not items of the line and so never count as a wrap.
   */
  ignore?: string | undefined;
};

/**
 * The boxes a row lays out as items of its lines. A wrapper with `display: contents` makes no box
 * of its own, so its children are the items; an absolutely positioned part (a visually hidden live
 * region) is out of the flow and sits on no line, so it is left out whatever its offset is.
 */
function itemsOf(parent: Element, ignore: string | undefined): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement) || child.hasAttribute('hidden')) continue;
    if (ignore !== undefined && child.matches(ignore)) continue;
    const style = getComputedStyle(child);
    if (style.display === 'none') continue;
    if (style.display === 'contents') {
      items.push(...itemsOf(child, ignore));
    } else if (style.position !== 'absolute' && style.position !== 'fixed') {
      if (child.getBoundingClientRect().width > 0) items.push(child);
    }
  }
  return items;
}

/**
 * Whether the items of a wrapping row sit on one line. Items on one line overlap vertically,
 * whatever their cross-axis alignment (a centred control is not at the stretched buttons' top); a
 * wrapped item sits wholly below the first, the row gap away.
 */
export function sitsOnOneLine(row: HTMLElement, ignore?: string): boolean {
  const items = itemsOf(row, ignore);
  const first = items[0]?.getBoundingClientRect();
  if (first === undefined) return true;
  return items.every((item) => {
    const box = item.getBoundingClientRect();
    return box.top < first.bottom - 1 && box.bottom > first.top + 1;
  });
}

/**
 * Makes an attachment for a wrapping action row. The control named by `control` shows its words
 * while the whole row fits on one line with them, and only when it cannot does it get `attribute`,
 * which the stylesheet turns into its icon-only form; its accessible name and tooltip stay. The
 * words are put back to measure, so the choice follows what the row needs, not a width the
 * container happens to have, and it is made again whenever the row, its items or the text change
 * size, and once the fonts have loaded.
 */
export function createLabelFit(options: LabelFitOptions): Attachment<HTMLElement> {
  return (row) => {
    const update = (): void => {
      const control = row.querySelector<HTMLElement>(options.control);
      if (control === null || row.clientWidth === 0) return;
      control.removeAttribute(options.attribute);
      if (!sitsOnOneLine(row, options.ignore)) control.setAttribute(options.attribute, '');
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    const watch = (): void => {
      observer.observe(row);
      for (const child of row.children) observer.observe(child);
    };
    watch();
    const mutations = new MutationObserver(() => {
      watch();
      update();
    });
    mutations.observe(row, { childList: true, subtree: true, characterData: true });
    // A web font that arrives after the first measure changes the words' width without touching
    // the row's size, so nothing else would measure again.
    let active = true;
    void document.fonts?.ready.then(() => (active ? update() : undefined));
    return () => {
      active = false;
      observer.disconnect();
      mutations.disconnect();
    };
  };
}
