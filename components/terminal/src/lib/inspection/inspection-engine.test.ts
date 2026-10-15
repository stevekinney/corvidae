import { afterEach, describe, expect, test } from 'bun:test';

import {
  createCapturedEngine,
  type CapturedEngine,
} from '../components/terminal/terminal-corpus-test-support.ts';
import type { EngineInputReport } from '../components/terminal/terminal-engine-adapter.ts';
import { SCROLLBACK_LINES } from '../components/terminal/terminal-engine-adapter.ts';
import { waitFor } from '../components/terminal/terminal-test-support.ts';
import { SEARCH_TEXT_BYTE_LIMIT } from './inspection-types.ts';
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

  test('a unicode prefix held from before the clear cannot leak after it, and its chunk is still acknowledged', async () => {
    const { engine, text } = mounted();
    const euro = bytes('€');
    const acknowledged: number[] = [];
    engine.write(Uint8Array.of(...bytes('a\r\n'), euro[0]!, euro[1]!), () => acknowledged.push(1));
    const cleared = new Promise<void>((resolve) => engine.clear('retained', resolve));
    await new Promise<void>((resolve) =>
      engine.write(bytes('b'), () => {
        acknowledged.push(2);
        resolve();
      }),
    );
    await cleared;
    expect(acknowledged).toEqual([1, 2]);
    expect(text()).toBe('b');
  });

  test('a clear after dispose does nothing, and one pending at dispose never reports done', async () => {
    const { engine, captured } = mounted();
    let done = 0;
    engine.clear('retained', () => {
      done += 1;
    });
    engine.dispose();
    engine.clear('reset', () => {
      done += 1;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
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
