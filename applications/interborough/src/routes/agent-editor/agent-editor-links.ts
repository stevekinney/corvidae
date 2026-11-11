import { router } from '../../lib/router.svelte.ts';

/**
 * Follows a link to another page of the app with the router, unless the click asks for a new tab or
 * window (a modifier, or a button other than the first), which the browser handles itself. The
 * Edit form's lines that send a person to the Settings or Access tab use it.
 */
export function followInApp(event: MouseEvent, path: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  router.navigate(path);
}
