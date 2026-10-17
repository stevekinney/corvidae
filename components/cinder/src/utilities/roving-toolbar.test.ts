/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { createRovingToolbar, ROVING_TOOLBAR_MUTATION_OPTIONS } =
  await import('./roving-toolbar.ts');

afterEach(() => {
  document.body.replaceChildren();
});

function mountToolbar(markup: string) {
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  const controller = createRovingToolbar({ root });
  controller.sync();
  const detach = controller.attach();
  return { root, controller, detach };
}

function keydown(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('createRovingToolbar', () => {
  test('makes the first enabled item the single Tab stop', () => {
    const { root, controller } = mountToolbar(
      '<button id="a" disabled>A</button><button id="b">B</button><button id="c">C</button>',
    );

    const stops = Array.from(root.querySelectorAll('button')).filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.id)).toEqual(['b']);
    expect(controller.firstEnabledItem()?.id).toBe('b');
  });

  test('re-syncing after a disabled change leaves exactly one Tab stop', () => {
    const { root, controller } = mountToolbar('<button id="a">A</button><button id="b">B</button>');
    const [a, b] = Array.from(root.querySelectorAll('button')) as [
      HTMLButtonElement,
      HTMLButtonElement,
    ];

    a.disabled = true;
    controller.sync();
    expect([a.tabIndex, b.tabIndex]).toEqual([-1, 0]);

    a.disabled = false;
    controller.sync();
    const stops = [a, b].filter((button) => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  test('arrow keys, Home and End move focus between enabled items and skip disabled ones', () => {
    const { root } = mountToolbar(
      '<button id="a">A</button><button id="b" disabled>B</button><button id="c">C</button>',
    );
    const a = root.querySelector<HTMLElement>('#a')!;
    const c = root.querySelector<HTMLElement>('#c')!;
    a.focus();

    keydown(a, 'ArrowRight');
    expect(document.activeElement === c).toBe(true);
    keydown(c, 'Home');
    expect(document.activeElement === a).toBe(true);
    keydown(a, 'End');
    expect(document.activeElement === c).toBe(true);
  });

  test('editable controls keep Home and End and rove sideways only at the caret boundary', () => {
    const { root } = mountToolbar(
      '<button id="a">A</button><input id="e" value="abc" /><button id="z">Z</button>',
    );
    const a = root.querySelector<HTMLElement>('#a')!;
    const editor = root.querySelector<HTMLInputElement>('#e')!;
    const z = root.querySelector<HTMLElement>('#z')!;
    editor.focus();

    expect(keydown(editor, 'Home').defaultPrevented).toBe(false);
    expect(keydown(editor, 'End').defaultPrevented).toBe(false);

    editor.setSelectionRange(1, 1);
    keydown(editor, 'ArrowRight');
    expect(document.activeElement === editor).toBe(true);

    editor.setSelectionRange(3, 3);
    keydown(editor, 'ArrowRight');
    expect(document.activeElement === z).toBe(true);

    editor.focus();
    editor.setSelectionRange(0, 0);
    keydown(editor, 'ArrowLeft');
    expect(document.activeElement === a).toBe(true);
  });

  test('detaching restores the authored tabindex of managed items', () => {
    const { root, detach } = mountToolbar(
      '<button id="a" tabindex="0">A</button><button id="b">B</button>',
    );
    const b = root.querySelector<HTMLElement>('#b')!;
    expect(b.getAttribute('tabindex')).toBe('-1');

    detach();

    expect(b.hasAttribute('tabindex')).toBe(false);
  });

  test('observes the attributes that change focusability', () => {
    expect(ROVING_TOOLBAR_MUTATION_OPTIONS.attributeFilter).toEqual(
      expect.arrayContaining(['disabled', 'aria-disabled', 'hidden', 'inert', 'aria-hidden']),
    );
  });
});
