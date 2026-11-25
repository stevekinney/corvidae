import { flushSync, mount, unmount } from 'svelte';
import Browser from './Browser.svelte';
export { flushSync, unmount };
export function mountFixture(target: Element) {
  return mount(Browser, { target });
}
