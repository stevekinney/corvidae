import type { Attachment } from 'svelte/attachments';

/** A focusable element a cut value can hold, such as the link a table cell wraps its text in. */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]';

/**
 * Tracks whether an element's content is actually cut off, so a value that fits has no tab stop and
 * no tooltip. The element is measured on mount, on every resize and when its content changes.
 *
 * - `axis: 'inline'` (default) is a one-line ellipsis: cut when `scrollWidth > clientWidth + 1`.
 * - `axis: 'block'` is a line clamp: cut when `scrollHeight > clientHeight + 1`.
 *
 * `trigger` is the element the full-text tooltip anchors to while the value is cut: a focusable
 * element inside the value (a link) when there is one, otherwise the element itself. `tabbable`
 * says whether the element itself should take the tab stop: only when it is cut and holds nothing
 * focusable, so a cut link is one stop, not two.
 */
export function createCutText(axis: 'inline' | 'block' = 'inline') {
  let element = $state<HTMLElement | null>(null);
  let cut = $state(false);
  let inner = $state<HTMLElement | null>(null);

  const attach: Attachment<HTMLElement> = (node) => {
    element = node;
    const measure = (): void => {
      cut =
        axis === 'inline'
          ? node.scrollWidth > node.clientWidth + 1
          : node.scrollHeight > node.clientHeight + 1;
      inner = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    };
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(node, { childList: true, characterData: true, subtree: true });
    const resizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    resizes?.observe(node);
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
      if (element === node) {
        element = null;
        inner = null;
        cut = false;
      }
    };
  };

  return {
    attach,
    get element() {
      return element;
    },
    get cut() {
      return cut;
    },
    get inner() {
      return inner;
    },
    get trigger() {
      return inner ?? element;
    },
    get tabbable() {
      return cut && inner === null;
    },
  };
}
