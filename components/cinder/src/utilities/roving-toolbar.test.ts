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

  test('a contenteditable item keeps its arrow keys', () => {
    const { root } = mountToolbar(
      '<button id="a">A</button><div id="e" contenteditable="true" tabindex="0">abc</div>',
    );
    const editor = root.querySelector<HTMLElement>('#e')!;
    editor.focus();

    keydown(editor, 'ArrowLeft');

    expect(document.activeElement === editor).toBe(true);
  });

  test('an input without a text selection API keeps its arrow keys', () => {
    const { root } = mountToolbar(
      '<button id="a">A</button><input id="n" type="number" value="4" />',
    );
    const input = root.querySelector<HTMLInputElement>('#n')!;
    input.focus();

    keydown(input, 'ArrowLeft');

    expect(document.activeElement === input).toBe(true);
  });

  test('an item in the first legend of a disabled fieldset stays enabled', () => {
    const { root } = mountToolbar(
      '<fieldset disabled><legend><button id="l">L</button></legend><button id="f">F</button></fieldset>',
    );

    const stops = Array.from(root.querySelectorAll('button')).filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.id)).toEqual(['l']);
  });

  test('skips controls inside an excluded or hidden ancestor', () => {
    const { root, controller } = mountToolbar(
      '<div data-cinder-toolbar-exclude><button id="x">X</button></div><button id="b">B</button>',
    );

    expect(controller.firstEnabledItem()?.id).toBe('b');
    expect(root.querySelector<HTMLElement>('#x')!.tabIndex).not.toBe(-1);
  });

  test('ignores the cross-axis arrow keys for each orientation', () => {
    const { root } = mountToolbar('<button id="a">A</button><button id="b">B</button>');
    const a = root.querySelector<HTMLElement>('#a')!;
    a.focus();
    keydown(a, 'ArrowDown');
    expect(document.activeElement === a).toBe(true);

    const vertical = document.createElement('div');
    vertical.innerHTML = '<button id="v1">V1</button><button id="v2">V2</button>';
    document.body.append(vertical);
    const verticalController = createRovingToolbar({
      root: vertical,
      orientation: () => 'vertical',
    });
    verticalController.sync();
    verticalController.attach();
    const first = vertical.querySelector<HTMLElement>('#v1')!;
    first.focus();
    keydown(first, 'ArrowRight');
    expect(document.activeElement === first).toBe(true);
  });

  test('reports the item holding the Tab stop', () => {
    const { root, controller } = mountToolbar('<button id="a">A</button><button id="b">B</button>');
    const a = root.querySelector<HTMLElement>('#a')!;
    a.focus();

    keydown(a, 'End');

    expect(controller.activeItem()?.id).toBe('b');
  });

  test('observes the attributes that change focusability', () => {
    expect(ROVING_TOOLBAR_MUTATION_OPTIONS.attributeFilter).toEqual(
      expect.arrayContaining(['disabled', 'aria-disabled', 'hidden', 'inert', 'aria-hidden']),
    );
  });
});
