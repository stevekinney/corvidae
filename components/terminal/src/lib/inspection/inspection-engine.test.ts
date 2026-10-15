import { afterEach, describe, expect, test } from 'bun:test';

import {
  createCapturedEngine,
  type CapturedEngine,
} from '../components/terminal/terminal-corpus-test-support.ts';
import type { EngineInputReport } from '../components/terminal/terminal-engine-adapter.ts';
import { SCROLLBACK_LINES } from '../components/terminal/terminal-engine-adapter.ts';
import { waitFor } from '../components/terminal/terminal-test-support.ts';
import { buildTextExport } from './export.ts';
import {
  RETAINED_READ_CEILING,
  SEARCH_TEXT_BYTE_LIMIT,
  SNAPSHOT_BYTE_LIMIT,
} from './inspection-types.ts';
import { findMatches } from './search.ts';

const ESC = '\u001b';
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const hosts: HTMLElement[] = [];
const captures: CapturedEngine[] = [];

function mounted(options: Parameters<typeof createCapturedEngine>[0] = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const captured = createCapturedEngine(options);
  captured.engine.mount(host);
  captures.push(captured);
  const reports: EngineInputReport[] = [];
  captured.engine.onInput((report) => reports.push(report));
  const text = () => captured.engine.readProjection(SEARCH_TEXT_BYTE_LIMIT).text;
  return { captured, engine: captured.engine, reports, text };
}

afterEach(() => {
  for (const captured of captures.splice(0)) captured.engine.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

/**
 * Scroll the viewport back through the engine's buffer service. A mounted engine would route a
 * scroll through a DOM scroll container, which has no layout here.
 */
function scrollBack(captured: CapturedEngine, lines: number): void {
  const core: unknown = Reflect.get(captured.terminal, '_core');
  const service: unknown = Reflect.get(core as object, '_bufferService');
  Reflect.apply(Reflect.get(service as object, 'scrollLines') as () => void, service, [-lines]);
}

function clearAndWait(
  engine: CapturedEngine['engine'],
  scope: Parameters<CapturedEngine['engine']['clear']>[0],
): Promise<void> {
  return new Promise<void>((resolve) => engine.clear(scope, resolve));
}

describe('searching what the engine retained', () => {
  test('finds text across a soft wrap, as one logical line', async () => {
    const { captured, text } = mounted();
    const line = `${'a'.repeat(38)}NEEDLE${'b'.repeat(40)}`;
    await captured.deliver([bytes(`${line}\r\nnext`)]);
    expect(text()).toBe(`${line}\nnext`);
    expect(findMatches(text(), 'aaNEEDLEbb').matches).toHaveLength(1);
    // The wrap is not a line break: a query with one finds nothing at that position.
    expect(findMatches(text(), 'aa\nNEEDLE').matches).toHaveLength(0);
  });

  test('finds text across a hard line break written as a line feed', async () => {
    const { captured, text } = mounted();
    await captured.deliver([bytes('first\r\nsecond\r\nthird')]);
    expect(findMatches(text(), 'first\nsecond').matches).toHaveLength(1);
    expect(findMatches(text(), 'first second').matches).toHaveLength(0);
  });

  test('searches only the active buffer: the alternate screen hides the normal one and back', async () => {
    const { captured, text } = mounted();
    await captured.deliver([bytes('normal-history\r\n')]);
    await captured.deliver([bytes(`${ESC}[?1049halternate-content`)]);
    expect(captured.terminal.buffer.active.type).toBe('alternate');
    expect(findMatches(text(), 'alternate-content').matches).toHaveLength(1);
    expect(findMatches(text(), 'normal-history').matches).toHaveLength(0);
    await captured.deliver([bytes(`${ESC}[?1049l`)]);
    expect(findMatches(text(), 'normal-history').matches).toHaveLength(1);
    expect(findMatches(text(), 'alternate-content').matches).toHaveLength(0);
  });

  test('output evicted from the scrollback is no longer found', async () => {
    const { captured, text } = mounted();
    const lines = Array.from({ length: SCROLLBACK_LINES + 200 }, (_, index) => `row-${index}`);
    await captured.deliver([bytes(`${lines.join('\r\n')}\r\n`)]);
    expect(findMatches(text(), 'row-0\n').matches).toHaveLength(0);
    expect(findMatches(text(), `row-${SCROLLBACK_LINES + 199}`).matches).toHaveLength(1);
  });

  test('a reflow changes the rows and not the logical text, so a match survives it', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes(`${'x'.repeat(30)}FIND-THIS${'y'.repeat(30)}\r\ntail`)]);
    const before = findMatches(text(), 'FIND-THIS').matches;
    let changes = 0;
    engine.onChange(() => {
      changes += 1;
    });
    engine.resize({ columns: 17, rows: 8 });
    expect(changes).toBeGreaterThan(0);
    expect(findMatches(text(), 'FIND-THIS').matches).toEqual(before);
  });

  test('ANSI styling and escape sequences are never in the text', async () => {
    const { captured, text } = mounted();
    await captured.deliver([bytes(`${ESC}[31mred${ESC}[0m ${ESC}]0;title\u0007plain`)]);
    expect(text()).toBe('red plain');
    expect(text()).not.toContain(ESC);
  });
});

describe('clearing', () => {
  async function filled() {
    const harness = mounted();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    await harness.captured.deliver([bytes(`${lines.join('\r\n')}\r\nprompt$ `)]);
    return harness;
  }

  test('clear screen erases the visible rows and keeps the scrollback', async () => {
    const { engine, text, reports, captured } = await filled();
    expect(text()).toContain('line 29');
    await clearAndWait(engine, 'visible');
    expect(text()).toContain('line 0\n');
    expect(text()).not.toContain('line 29');
    expect(text()).not.toContain('prompt$');
    expect(reports).toEqual([]);
    expect(captured.replies).toEqual([]);
  });

  test('clear history discards the scrollback and the screen except the cursor row', async () => {
    const { engine, text, reports, captured } = await filled();
    await clearAndWait(engine, 'retained');
    expect(text()).toBe('prompt$ ');
    expect(reports).toEqual([]);
    expect(captured.replies).toEqual([]);
  });

  test('reset returns the engine to its start state, including the alternate screen', async () => {
    const { engine, captured, text, reports } = await filled();
    await captured.deliver([bytes(`${ESC}[?1049h${ESC}[?2004halt`)]);
    expect(captured.terminal.buffer.active.type).toBe('alternate');
    await clearAndWait(engine, 'reset');
    expect(captured.terminal.buffer.active.type).toBe('normal');
    expect(captured.terminal.modes.bracketedPasteMode).toBe(false);
    expect(text()).toBe('');
    expect(reports).toEqual([]);
    expect(captured.replies).toEqual([]);
  });

  test('the three are distinct: each leaves different content', async () => {
    const results: Record<string, string> = {};
    for (const scope of ['visible', 'retained', 'reset'] as const) {
      const { engine, text } = await filled();
      await clearAndWait(engine, scope);
      results[scope] = text();
    }
    expect(new Set(Object.values(results)).size).toBe(3);
  });

  test('a clear takes effect behind the output already received, and not behind later output', async () => {
    const { engine, text } = mounted();
    const acknowledged: string[] = [];
    engine.write(bytes('before-clear\r\n'), () => acknowledged.push('first'));
    const cleared = new Promise<void>((resolve) =>
      engine.clear('retained', () => {
        acknowledged.push('clear');
        resolve();
      }),
    );
    await new Promise<void>((resolve) =>
      engine.write(bytes('after-clear'), () => {
        acknowledged.push('second');
        resolve();
      }),
    );
    await cleared;
    expect(acknowledged).toEqual(['first', 'clear', 'second']);
    expect(text()).toBe('after-clear');
  });

  test('a reset during pending writes drops what came before it and keeps what came after', async () => {
    const { engine, text } = mounted();
    engine.write(bytes('old output\r\n'), () => {});
    const cleared = new Promise<void>((resolve) => engine.clear('reset', resolve));
    await new Promise<void>((resolve) => engine.write(bytes('new output'), resolve));
    await cleared;
    expect(text()).toBe('new output');
  });

  test.each(['visible', 'retained', 'reset'] as const)(
    'a unicode prefix held from before a %s clear is dropped with the output it belonged to',
    async (scope) => {
      const { engine, text } = mounted();
      const euro = bytes('\u20ac');
      const acknowledged: number[] = [];
      // The first two bytes of one character are held, waiting for the third.
      engine.write(Uint8Array.of(...bytes('a\r\n'), euro[0]!, euro[1]!), () =>
        acknowledged.push(1),
      );
      const cleared = new Promise<void>((resolve) => engine.clear(scope, resolve));
      // The third byte arrives after the clear: it belongs to nothing, so it cannot finish the
      // character that began before it.
      await new Promise<void>((resolve) =>
        engine.write(Uint8Array.of(euro[2]!, ...bytes('b')), () => {
          acknowledged.push(2);
          resolve();
        }),
      );
      await cleared;
      expect(acknowledged).toEqual([1, 2]);
      expect(text()).not.toContain('\u20ac');
      expect(text().endsWith('b')).toBe(true);
    },
  );

  test('a clear after dispose does nothing, and one pending at dispose never reports done', () => {
    const { engine, captured } = mounted();
    // The engine finishes a write by calling the function it was given; hold that function so the
    // test, not a clock, decides when it runs.
    const finishers: Array<() => void> = [];
    captured.terminal.write = (_data, callback) => {
      if (callback !== undefined) finishers.push(callback);
    };
    let done = 0;
    engine.clear('retained', () => {
      done += 1;
    });
    expect(finishers).toHaveLength(1);
    engine.dispose();
    for (const finish of finishers.splice(0)) finish();
    expect(done).toBe(0);
    engine.clear('reset', () => {
      done += 1;
    });
    expect(finishers).toHaveLength(0);
    expect(done).toBe(0);
    expect(captured.replies).toEqual([]);
  });

  test('clearing without a callback works', async () => {
    const { engine, text } = mounted();
    engine.write(bytes('gone'), () => {});
    engine.clear('retained');
    await waitFor(() => text() === '', 'the clear to apply');
  });
});

describe('change notifications', () => {
  test('fire for parsed output, a clear, and a resize, and stop after unsubscribing', async () => {
    const { captured, engine } = mounted();
    let changes = 0;
    const stop = engine.onChange(() => {
      changes += 1;
    });
    await captured.deliver([bytes('output')]);
    const afterOutput = changes;
    expect(afterOutput).toBeGreaterThan(0);
    await clearAndWait(engine, 'visible');
    expect(changes).toBeGreaterThan(afterOutput);
    stop();
    const stopped = changes;
    await captured.deliver([bytes('more')]);
    expect(changes).toBe(stopped);
  });
});

describe('selecting a search match', () => {
  function matchOf(text: string, needle: string, occurrence = 0) {
    let start = -1;
    for (let found = 0; found <= occurrence; found += 1) start = text.indexOf(needle, start + 1);
    return { start, end: start + needle.length, text: needle };
  }

  test('selects exactly the matched text', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('alpha beta gamma\r\nsecond line')]);
    expect(engine.selectMatch(matchOf(text(), 'beta'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('beta');
    expect(engine.selectMatch(matchOf(text(), 'second'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('second');
  });

  test('selects a match that continues across a soft wrap', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes(`${'a'.repeat(36)}NEEDLE-ACROSS${'b'.repeat(40)}\r\ntail`)]);
    expect(engine.selectMatch(matchOf(text(), 'NEEDLE-ACROSS'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('NEEDLE-ACROSS');
    expect(captured.terminal.getSelectionPosition()!.start.y).not.toBe(
      captured.terminal.getSelectionPosition()!.end.y,
    );
  });

  test('selects a match that crosses a hard line break', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('first line\r\nsecond line\r\nthird')]);
    expect(engine.selectMatch(matchOf(text(), 'line\nsecond'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('line\nsecond');
  });

  test('places a match after wide characters, which take two cells and one character', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('日本語 target 日本語 target')]);
    expect(engine.selectMatch(matchOf(text(), 'target', 1), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('target');
    expect(captured.terminal.getSelectionPosition()!.start.x).toBe(21);
    expect(engine.selectMatch(matchOf(text(), '語 t'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('語 t');
  });

  test('selects a match at the very start and at the very end of the retained text', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('start of it\r\nend')]);
    expect(engine.selectMatch(matchOf(text(), 'start'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('start');
    expect(engine.selectMatch(matchOf(text(), 'end'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('end');
  });

  test('selects a match in the scrollback without scrolling the viewport', async () => {
    const { captured, engine, text } = mounted();
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    await captured.deliver([bytes(lines.join('\r\n'))]);
    const buffer = captured.terminal.buffer.active;
    scrollBack(captured, 30);
    const viewport = buffer.viewportY;
    expect(viewport).toBeLessThan(buffer.baseY);
    expect(engine.selectMatch(matchOf(text(), 'line 5'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('line 5');
    expect(buffer.viewportY).toBe(viewport);
    engine.clearMatchSelection();
    expect(buffer.viewportY).toBe(viewport);
  });

  test('moves no focus: the engine textarea is neither focused nor blurred', async () => {
    const { captured, engine, text, reports } = mounted();
    await captured.deliver([bytes('find me')]);
    const before = document.activeElement;
    engine.selectMatch(matchOf(text(), 'find'), SEARCH_TEXT_BYTE_LIMIT);
    expect(document.activeElement).toBe(before);
    expect(reports).toEqual([]);
  });

  test('clearing drops the selection it made and leaves the reader’s own', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('find me please')]);
    captured.terminal.select(8, 0, 6);
    engine.clearMatchSelection();
    expect(captured.terminal.getSelection()).toBe('please');
    engine.selectMatch(matchOf(text(), 'find'), SEARCH_TEXT_BYTE_LIMIT);
    expect(captured.terminal.getSelection()).toBe('find');
    engine.clearMatchSelection();
    expect(captured.terminal.hasSelection()).toBe(false);
    engine.clearMatchSelection();
  });

  test('selects nothing, and clears what it selected, when the buffer no longer holds the match', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('find me')]);
    expect(engine.selectMatch(matchOf(text(), 'find'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(engine.selectMatch({ start: 0, end: 4, text: 'gone' }, SEARCH_TEXT_BYTE_LIMIT)).toBe(
      false,
    );
    expect(captured.terminal.hasSelection()).toBe(false);
    // With nothing of its own to clear, a failed placement leaves a reader's selection alone.
    captured.terminal.select(0, 0, 2);
    expect(engine.selectMatch({ start: 0, end: 4, text: 'gone' }, SEARCH_TEXT_BYTE_LIMIT)).toBe(
      false,
    );
    expect(captured.terminal.getSelection()).toBe('fi');
  });

  test('selects nothing when the engine’s own selection text disagrees with the match', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('find me')]);
    const original = captured.terminal.getSelection.bind(captured.terminal);
    captured.terminal.getSelection = () => `${original()}!`;
    expect(engine.selectMatch(matchOf(text(), 'find'), SEARCH_TEXT_BYTE_LIMIT)).toBe(false);
    captured.terminal.getSelection = original;
    expect(captured.terminal.hasSelection()).toBe(false);
  });

  test('a match ending where a wide character wraps whole ends in that row, with no extra blank cell', async () => {
    const { captured, engine, text } = mounted({ geometry: { columns: 20, rows: 6 } });
    await captured.deliver([bytes(`${'a'.repeat(19)}日x\r\nnext`)]);
    const last = { start: 15, end: 19, text: 'aaaa' };
    expect(engine.selectMatch(last, SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelectionPosition()?.end).toEqual({ x: 19, y: 0 });
    expect(engine.selectMatch(matchOf(text(), '日x'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('日x');
  });

  test('a match that ends with a line break selects up to the end of that line', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('one\r\ntwo\r\nthree')]);
    expect(engine.selectMatch(matchOf(text(), 'one\n'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('one');
    expect(engine.selectMatch(matchOf(text(), 'e\ntwo\n'), SEARCH_TEXT_BYTE_LIMIT)).toBe(true);
    expect(captured.terminal.getSelection()).toBe('e\ntwo');
  });

  test('a match that is only line breaks cannot be selected', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('one\r\n\r\nthree')]);
    expect(engine.selectMatch(matchOf(text(), '\n\n'), SEARCH_TEXT_BYTE_LIMIT)).toBe(false);
    expect(captured.terminal.hasSelection()).toBe(false);
  });

  test('every substring of wrapped wide-character output is selected exactly, less a trailing line break', async () => {
    const { captured, engine, text } = mounted({ geometry: { columns: 20, rows: 6 } });
    await captured.deliver([bytes(`${'a'.repeat(19)}日x\r\nnext`)]);
    const retained = text();
    for (let start = 0; start < retained.length; start += 1) {
      for (let end = start + 1; end <= retained.length; end += 1) {
        const needle = retained.slice(start, end);
        if (/^\n+$/u.test(needle)) continue;
        const selected = engine.selectMatch({ start, end, text: needle }, SEARCH_TEXT_BYTE_LIMIT);
        expect(selected).toBe(true);
        expect(captured.terminal.getSelection()).toBe(needle.replace(/\n+$/u, ''));
      }
    }
  });

  test('selects nothing for a match that starts inside one cell’s characters', async () => {
    const { captured, engine, text } = mounted();
    await captured.deliver([bytes('é end')]);
    expect(engine.selectMatch(matchOf(text(), '́'), SEARCH_TEXT_BYTE_LIMIT)).toBe(false);
    expect(captured.terminal.hasSelection()).toBe(false);
  });
});

describe('keeping the newest output within the bounds', () => {
  test('a snapshot-sized read keeps the newest whole lines and says earlier ones were omitted', async () => {
    const { captured, engine } = mounted({ geometry: { columns: 100, rows: 8 } });
    const lines = Array.from({ length: 1000 }, (_, index) => `${index}`.padEnd(99, 'x'));
    await captured.deliver([bytes(lines.join('\r\n'))]);
    const projection = engine.readProjection(SNAPSHOT_BYTE_LIMIT);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBeLessThanOrEqual(SNAPSHOT_BYTE_LIMIT);
    const kept = projection.text.split('\n');
    expect(kept.at(-1)!.startsWith('999')).toBe(true);
    expect(kept.every((line) => line.length === 99)).toBe(true);
    expect(kept.length).toBeGreaterThan(600);
    expect(projection.text).not.toContain('omitted');
  });

  test('a cut inside a multibyte character starts at the next whole one', async () => {
    const { captured, engine } = mounted({ geometry: { columns: 200, rows: 8 } });
    await captured.deliver([bytes('日'.repeat(40))]);
    // Each character is three bytes; 100 bytes lands inside the 34th from the end.
    const projection = engine.readProjection(100);
    expect(projection.text).toBe('日'.repeat(33));
    expect(projection.bytes).toBe(99);
    expect(projection.truncated).toBe(true);
  });
});

describe('a retained buffer that starts with a blank line', () => {
  test('exports it whole and not as a truncation', async () => {
    const { captured, engine } = mounted();
    await captured.deliver([bytes('\r\nhello')]);
    const exported = buildTextExport(engine.readProjection(RETAINED_READ_CEILING));
    expect(exported).toMatchObject({ text: '\nhello', truncated: false });
  });
});
