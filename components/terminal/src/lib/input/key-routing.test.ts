import { describe, expect, test } from 'bun:test';

import type { InputPlatform } from './input-types.ts';
import { routeKey, type KeyEventLike, type KeyRouteContext } from './key-routing.ts';

function key(key: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    ...modifiers,
  };
}

function context(overrides: Partial<KeyRouteContext> = {}): KeyRouteContext {
  return {
    overlayOpen: false,
    platform: 'other',
    captured: false,
    writable: true,
    hasSelection: () => false,
    ...overrides,
  };
}

const ENGINE = { process: true, preventDefault: false };
const BROWSER = { process: false, preventDefault: false };

describe('overlay first', () => {
  test('a focused package overlay owns every key, including reserved chords', () => {
    const overlay = context({ overlayOpen: true, captured: true });
    expect(routeKey(key('Escape'), overlay)).toEqual(BROWSER);
    expect(routeKey(key('Enter'), overlay)).toEqual(BROWSER);
    expect(routeKey(key('Escape', { ctrlKey: true, shiftKey: true }), overlay)).toEqual(BROWSER);
    expect(routeKey(key('a', { isComposing: true }), overlay)).toEqual(BROWSER);
  });

  test('the overlay outranks a copy chord and does not even ask about the selection', () => {
    const overlay = context({
      overlayOpen: true,
      hasSelection: () => {
        throw new Error('must not be asked');
      },
    });
    expect(routeKey(key('c', { ctrlKey: true }), overlay)).toEqual(BROWSER);
  });
});

describe('composition', () => {
  test('hands every composing key to the engine, even one that would otherwise be reserved', () => {
    expect(routeKey(key('Process', { keyCode: 229 }), context())).toEqual(ENGINE);
    expect(routeKey(key('Tab', { isComposing: true }), context())).toEqual(ENGINE);
    expect(
      routeKey(key('Escape', { isComposing: true, ctrlKey: true, shiftKey: true }), context()),
    ).toEqual(ENGINE);
  });

  test('a view that takes no input does not compose', () => {
    expect(routeKey(key('a', { isComposing: true }), context({ writable: false }))).toEqual(
      BROWSER,
    );
  });
});

describe('capture release', () => {
  const release = key('Escape', { ctrlKey: true, shiftKey: true });

  test('Ctrl+Shift+Escape releases capture and is consumed', () => {
    expect(routeKey(release, context({ captured: true }))).toEqual({
      process: false,
      preventDefault: true,
      effect: 'release-capture',
    });
  });

  test('with capture off it is left alone and sends nothing', () => {
    expect(routeKey(release, context())).toEqual(BROWSER);
  });

  test('bare Escape stays shell input', () => {
    expect(routeKey(key('Escape'), context({ captured: true }))).toEqual(ENGINE);
    expect(routeKey(key('Escape'), context())).toEqual(ENGINE);
  });

  test('Escape with only some of the release modifiers is shell input', () => {
    expect(routeKey(key('Escape', { ctrlKey: true }), context({ captured: true }))).toEqual(ENGINE);
    expect(routeKey(key('Escape', { shiftKey: true }), context({ captured: true }))).toEqual(
      ENGINE,
    );
    expect(
      routeKey(key('Escape', { ctrlKey: true, shiftKey: true, altKey: true }), context()),
    ).toEqual(ENGINE);
  });
});

describe('copy and interrupt', () => {
  const platforms: Array<[InputPlatform, Partial<KeyEventLike>]> = [
    ['mac', { metaKey: true }],
    ['other', { ctrlKey: true }],
  ];

  test.each(platforms)('%s: a selection wins, native copy, no interrupt', (platform, chord) => {
    for (const captured of [true, false]) {
      const decision = routeKey(
        key('c', chord),
        context({ platform, captured, hasSelection: () => true }),
      );
      expect(decision).toEqual(BROWSER);
    }
  });

  test('Cmd+C with no selection on a Mac is the interrupt', () => {
    expect(routeKey(key('c', { metaKey: true }), context({ platform: 'mac' }))).toEqual({
      process: false,
      preventDefault: true,
      effect: 'interrupt',
    });
    expect(routeKey(key('C', { metaKey: true }), context({ platform: 'mac' })).effect).toBe(
      'interrupt',
    );
  });

  test('Ctrl+C with no selection elsewhere reaches the engine, which sends ETX', () => {
    expect(routeKey(key('c', { ctrlKey: true }), context())).toEqual(ENGINE);
  });

  test('Ctrl+C on a Mac is not a copy chord; it reaches the engine', () => {
    expect(routeKey(key('c', { ctrlKey: true }), context({ platform: 'mac' }))).toEqual(ENGINE);
  });

  test('a view that takes no input never interrupts', () => {
    expect(
      routeKey(key('c', { metaKey: true }), context({ platform: 'mac', writable: false })),
    ).toEqual(BROWSER);
    expect(routeKey(key('c', { ctrlKey: true }), context({ writable: false }))).toEqual(BROWSER);
  });

  test('a modified copy key is not the copy chord', () => {
    // Ctrl+Shift+C is the inspector, Ctrl+Alt+C is a layout key: neither asks about a selection.
    const never = context({
      hasSelection: () => {
        throw new Error('must not be asked');
      },
    });
    expect(routeKey(key('C', { ctrlKey: true, shiftKey: true }), never)).toEqual(ENGINE);
    expect(routeKey(key('c', { ctrlKey: true, altKey: true }), never)).toEqual(ENGINE);
    expect(routeKey(key('c', { ctrlKey: true, metaKey: true }), never)).toEqual(BROWSER);
  });
});

describe('paste chord', () => {
  test('is left to the browser so the paste event can be reviewed', () => {
    expect(routeKey(key('v', { metaKey: true }), context({ platform: 'mac' }))).toEqual(BROWSER);
    expect(routeKey(key('v', { ctrlKey: true }), context())).toEqual(BROWSER);
    expect(routeKey(key('V', { ctrlKey: true, shiftKey: true }), context())).toEqual(BROWSER);
  });

  test('Ctrl+V on a Mac and Alt-modified V are ordinary keys', () => {
    expect(routeKey(key('v', { ctrlKey: true }), context({ platform: 'mac' }))).toEqual(ENGINE);
    expect(routeKey(key('v', { ctrlKey: true, altKey: true }), context())).toEqual(ENGINE);
    expect(routeKey(key('v'), context())).toEqual(ENGINE);
  });
});

describe('reserved chords', () => {
  test.each(['l', 't', 'w', 'a', 'Enter'])('Cmd+%s on a Mac belongs to the browser', (name) => {
    expect(routeKey(key(name, { metaKey: true }), context({ platform: 'mac' }))).toEqual(BROWSER);
  });

  test('Cmd+Tab and Ctrl+Option (VoiceOver) on a Mac belong to the system', () => {
    expect(routeKey(key('Tab', { metaKey: true }), context({ platform: 'mac' }))).toEqual(BROWSER);
    expect(
      routeKey(key('a', { ctrlKey: true, altKey: true }), context({ platform: 'mac' })),
    ).toEqual(BROWSER);
  });

  test.each(['l', 't', 'w', 'L'])('Ctrl+%s elsewhere belongs to the browser', (name) => {
    expect(routeKey(key(name, { ctrlKey: true }), context())).toEqual(BROWSER);
  });

  test('Alt+Tab and Ctrl+Tab belong to the system and the browser', () => {
    expect(routeKey(key('Tab', { altKey: true }), context({ captured: true }))).toEqual(BROWSER);
    expect(routeKey(key('Tab', { ctrlKey: true }), context({ captured: true }))).toEqual(BROWSER);
    expect(
      routeKey(key('Tab', { ctrlKey: true }), context({ captured: true, platform: 'mac' })),
    ).toEqual(BROWSER);
  });

  test('Option+Tab on a Mac moves through the page without capture and is shell input with it', () => {
    // Safari reaches buttons and links only with Option held, so the terminal must not swallow it
    // while capture is off (COR-474: found in WebKit, where focus could not leave the terminal).
    expect(routeKey(key('Tab', { altKey: true }), context({ platform: 'mac' }))).toEqual(BROWSER);
    expect(
      routeKey(key('Tab', { altKey: true }), context({ platform: 'mac', writable: false })),
    ).toEqual(BROWSER);
    expect(
      routeKey(key('Tab', { altKey: true }), context({ platform: 'mac', captured: true })),
    ).toEqual(ENGINE);
  });

  test('a Super or Windows key chord elsewhere is left to the system', () => {
    expect(routeKey(key('d', { metaKey: true }), context())).toEqual(BROWSER);
  });

  test('AltGr (Ctrl and Alt together) elsewhere is a layout key, not reserved', () => {
    expect(routeKey(key('@', { ctrlKey: true, altKey: true }), context())).toEqual(ENGINE);
    expect(routeKey(key('l', { ctrlKey: true, altKey: true }), context())).toEqual(ENGINE);
  });

  test('other Ctrl chords reach the shell', () => {
    for (const name of ['a', 'e', 'd', 'r', 'z']) {
      expect(routeKey(key(name, { ctrlKey: true }), context())).toEqual(ENGINE);
    }
  });
});

describe('Tab and page navigation', () => {
  test('page-navigation mode sends Tab and Shift+Tab through the page', () => {
    expect(routeKey(key('Tab'), context())).toEqual(BROWSER);
    expect(routeKey(key('Tab', { shiftKey: true }), context())).toEqual(BROWSER);
  });

  test('capture mode sends Tab and Shift+Tab to the engine', () => {
    expect(routeKey(key('Tab'), context({ captured: true }))).toEqual(ENGINE);
    expect(routeKey(key('Tab', { shiftKey: true }), context({ captured: true }))).toEqual(ENGINE);
  });

  test('a view that takes no input always leaves Tab to the page', () => {
    expect(routeKey(key('Tab'), context({ writable: false, captured: true }))).toEqual(BROWSER);
  });
});

describe('authorized input', () => {
  test('typing reaches the engine in both modes', () => {
    for (const captured of [true, false]) {
      expect(routeKey(key('a'), context({ captured }))).toEqual(ENGINE);
      expect(routeKey(key('F5'), context({ captured }))).toEqual(ENGINE);
      expect(routeKey(key('ArrowUp'), context({ captured }))).toEqual(ENGINE);
      expect(routeKey(key('Enter'), context({ captured }))).toEqual(ENGINE);
    }
  });

  test('a view that takes no input still lets the engine scroll', () => {
    expect(routeKey(key('PageUp'), context({ writable: false }))).toEqual(ENGINE);
  });
});
