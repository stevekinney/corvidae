/**
 * `followLinks` makes the links inside an element open their pages through the router on a plain
 * click, and leaves everything else (a modified click, a link that opens elsewhere, a link to
 * another site) to the browser.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { followLinks } from './follow-links.ts';
import { router } from './router.svelte.ts';

let previousMainFrameNavigation: boolean | undefined;

afterEach(async () => {
  // Modified and new-tab clicks intentionally remain browser-default. Happy DOM starts a
  // navigation for those defaults; abort it before the shared test window can leak a refused
  // localhost request into a later file.
  if (window instanceof Window) await window.happyDOM.abort();
  if (window instanceof Window && previousMainFrameNavigation !== undefined) {
    window.happyDOM.settings.navigation.disableMainFrameNavigation = previousMainFrameNavigation;
    previousMainFrameNavigation = undefined;
  }
  document.body.replaceChildren();
});

function listWith(markup: string): { list: HTMLElement; stop: () => void } {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  previousMainFrameNavigation = window.happyDOM.settings.navigation.disableMainFrameNavigation;
  window.happyDOM.settings.navigation.disableMainFrameNavigation = true;
  router.navigate('/schedules', { replace: true });
  const list = document.createElement('div');
  list.innerHTML = markup;
  document.body.append(list);
  return { list, stop: followLinks(list) };
}

function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('followLinks', () => {
  test('opens an application address through the router and stops the browser following it', () => {
    const { list, stop } = listWith('<a href="/schedules/daily"><span>Daily summary</span></a>');
    const event = click(list.querySelector('span') as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(router.pathname).toBe('/schedules/daily');
    stop();
  });

  test('leaves a modified click, a middle click and a new-tab link to the browser', () => {
    const { list, stop } = listWith(
      '<a id="plain" href="/schedules/daily">a</a><a id="tab" href="/schedules/other" target="_blank">b</a>',
    );
    const plain = list.querySelector('#plain') as Element;
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(click(plain, init).defaultPrevented).toBe(false);
    }
    expect(click(list.querySelector('#tab') as Element).defaultPrevented).toBe(false);
    expect(router.pathname).toBe('/schedules');
    stop();
  });

  test('leaves an address that is not the application’s to the browser, and stops listening when removed', () => {
    const { list, stop } = listWith(
      '<a id="out" href="https://example.com/">x</a><a id="in" href="/a">y</a>',
    );
    expect(click(list.querySelector('#out') as Element).defaultPrevented).toBe(false);
    stop();
    expect(click(list.querySelector('#in') as Element).defaultPrevented).toBe(false);
  });
});
