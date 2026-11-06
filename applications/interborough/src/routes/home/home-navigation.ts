/**
 * Opening a page from a button on Home. A plain click opens the page inside the application; a
 * modified click (a new tab, a new window, a download) is left to the browser.
 */
import { router } from '../../lib/router.svelte.ts';

/** Opens `path` in place for a plain click, and leaves a modified or non-primary click to the browser. */
export function openInApplication(event: MouseEvent, path: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  router.navigate(path);
}
