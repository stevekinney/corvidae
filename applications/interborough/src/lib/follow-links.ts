/**
 * An attachment that makes the links inside an element open their pages without leaving the
 * application: a plain left click on an anchor goes through the router, and a click with a
 * modifier, a middle click, or a link that opens elsewhere is the browser's own. A list of rows
 * that are links (Cinder's `StackedListItem` draws its title as an anchor and takes no click
 * handler) puts this on the element around the list.
 */
import { router } from './router.svelte.ts';

/** Follows an anchor's address through the router when the click is a plain one. */
export function followLinks(node: HTMLElement): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link === null || !node.contains(link)) return;
    const target = link.getAttribute('target');
    if (link.hasAttribute('download') || (target !== null && target !== '_self')) return;
    const href = link.getAttribute('href');
    if (href === null || !href.startsWith('/')) return;
    event.preventDefault();
    router.navigate(href);
  };
  node.addEventListener('click', onClick);
  return () => node.removeEventListener('click', onClick);
}
