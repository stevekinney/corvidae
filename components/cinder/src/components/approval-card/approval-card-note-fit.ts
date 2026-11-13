import type { Attachment } from 'svelte/attachments';

/** The attribute that turns the "Add note" button into its icon-only form. */
export const NOTE_COMPACT_ATTRIBUTE = 'data-cinder-note-compact';

/**
 * Whether the items of a wrapping action row sit on one line. A flex row breaks lines by the items'
 * natural sizes, so the first top the items do not share says the row had to wrap. The arming hint
 * is meant to take a line of its own and is not an item of the row.
 */
function sitsOnOneLine(group: HTMLElement): boolean {
  const items = [...group.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      !child.classList.contains('cinder-inline-confirm__two-press-hint') &&
      !child.hasAttribute('hidden') &&
      child.offsetWidth > 0,
  );
  const first = items[0];
  if (first === undefined) return true;
  return items.every((item) => Math.abs(item.offsetTop - first.offsetTop) < 1);
}

/**
 * Attached to the card's action row. The note button shows its words while the whole row fits on
 * one line with them, and only when it cannot does it fall back to its icon, which keeps its name
 * and its tooltip. The words are put back to measure, so the choice follows what the row needs, not
 * a width the card happens to have; it is made again whenever the row or its items change size.
 */
export const fitNoteLabel: Attachment<HTMLElement> = (group) => {
  const update = (): void => {
    const toggle = group.querySelector<HTMLElement>('.cinder-approval-card__note-toggle');
    if (toggle === null || group.clientWidth === 0) return;
    toggle.removeAttribute(NOTE_COMPACT_ATTRIBUTE);
    if (!sitsOnOneLine(group)) toggle.setAttribute(NOTE_COMPACT_ATTRIBUTE, '');
  };
  update();
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(update);
  observer.observe(group);
  for (const child of group.children) observer.observe(child);
  const mutations = new MutationObserver(() => {
    for (const child of group.children) observer.observe(child);
    update();
  });
  mutations.observe(group, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    mutations.disconnect();
  };
};
