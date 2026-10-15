import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IBufferRange, type ILink, type ILinkProvider } from '@xterm/xterm';
import { afterEach, describe, expect, test } from 'bun:test';

import { createCapturedEngine, type CapturedEngine } from './terminal-corpus-test-support.ts';
import {
  INITIAL_GEOMETRY,
  SCROLLBACK_LINES,
  buildEngineOptions,
  createRendererEngine,
  type EngineConstructors,
  type EngineCreateOptions,
} from './terminal-engine-adapter.ts';
import { MAXIMUM_TITLE_CODE_POINTS } from './terminal-links.ts';
import { waitFor } from './terminal-test-support.ts';

const ESC = '\u001b';
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const hosts: HTMLElement[] = [];
const engines: CapturedEngine[] = [];

function mountedEngine(options: Partial<EngineCreateOptions> = {}): CapturedEngine {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const captured = createCapturedEngine(options);
  captured.engine.mount(host);
  engines.push(captured);
  return captured;
}

afterEach(() => {
  for (const captured of engines.splice(0)) captured.engine.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

const baseOptions: EngineCreateOptions = {
  readOnly: false,
  announceOutput: false,
  reducedMotion: false,
  ariaLabel: 'Terminal',
  theme: {},
  geometry: { columns: 40, rows: 8 },
};

describe('buildEngineOptions', () => {
  test('sets only options with a reason, and never the proposed API', () => {
    const options = buildEngineOptions(baseOptions);
    expect(options.cols).toBe(40);
    expect(options.rows).toBe(8);
    expect(options.scrollback).toBe(SCROLLBACK_LINES);
    expect(SCROLLBACK_LINES).toBe(10_000);
    expect(options.allowProposedApi).toBe(false);
    expect(options.convertEol).toBe(false);
    expect(options.disableStdin).toBe(false);
    expect(options.screenReaderMode).toBe(false);
  });

  test('a read-only view disables input, which also silences automatic query replies', () => {
    expect(buildEngineOptions({ ...baseOptions, readOnly: true }).disableStdin).toBe(true);
  });

  test('blinks the cursor only for a writable view that has not asked for reduced motion', () => {
    expect(buildEngineOptions(baseOptions).cursorBlink).toBe(true);
    expect(buildEngineOptions({ ...baseOptions, reducedMotion: true }).cursorBlink).toBe(false);
    expect(buildEngineOptions({ ...baseOptions, readOnly: true }).cursorBlink).toBe(false);
  });

  test('mirrors output to the live region only when asked', () => {
    expect(buildEngineOptions({ ...baseOptions, announceOutput: true }).screenReaderMode).toBe(
      true,
    );
  });

  test('passes the theme as a copy and the font only when known', () => {
    const theme = { red: '#ff0000' };
    const options = buildEngineOptions({ ...baseOptions, theme });
    expect(options.theme).toEqual(theme);
    expect(options.theme).not.toBe(theme);
    expect('fontFamily' in options).toBe(false);
    expect('fontSize' in options).toBe(false);
    const withFont = buildEngineOptions({ ...baseOptions, fontFamily: 'Mono', fontSize: 13 });
    expect(withFont.fontFamily).toBe('Mono');
    expect(withFont.fontSize).toBe(13);
  });

  test('installs a link handler that does nothing and refuses non-HTTP destinations', () => {
    const handler = buildEngineOptions(baseOptions).linkHandler;
    expect(handler?.allowNonHttpProtocols).toBe(false);
    const opened: unknown[] = [];
    const original = window.open;
    window.open = ((...parameters: unknown[]) =>
      opened.push(parameters)) as unknown as typeof window.open;
    try {
      expect(
        handler?.activate(new MouseEvent('click'), 'https://hidden.test/', {
          start: { x: 1, y: 1 },
          end: { x: 2, y: 1 },
        }),
      ).toBeUndefined();
    } finally {
      window.open = original;
    }
    expect(opened).toEqual([]);
  });

  test('starts from a conventional grid', () => {
    expect(INITIAL_GEOMETRY).toEqual({ columns: 80, rows: 24 });
  });
});

describe('mounting and settings', () => {
  test('labels the engine input surface', () => {
    const { terminal } = mountedEngine({ ariaLabel: 'Build output' });
    expect(terminal.textarea?.getAttribute('aria-label')).toBe('Build output');
  });

  test('update applies settings to the live engine', () => {
    const { engine, terminal } = mountedEngine();
    engine.update({
      readOnly: true,
      announceOutput: true,
      reducedMotion: true,
      ariaLabel: 'Renamed',
      theme: { foreground: '#010203' },
    });
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.options.screenReaderMode).toBe(true);
    expect(terminal.options.cursorBlink).toBe(false);
    expect(terminal.options.theme?.foreground).toBe('#010203');
    expect(terminal.textarea?.getAttribute('aria-label')).toBe('Renamed');
  });

  test('reports and changes the engine grid', () => {
    const { engine } = mountedEngine();
    expect(engine.geometry).toEqual({ columns: 40, rows: 8 });
    engine.resize({ columns: 100, rows: 30 });
    expect(engine.geometry).toEqual({ columns: 100, rows: 30 });
  });

  test('cannot be measured without layout, and does not invent a size', () => {
    const { engine } = mountedEngine();
    expect(engine.measure()).toBeUndefined();
  });

  test('dispose removes the engine DOM and is safe twice', () => {
    const { engine } = mountedEngine();
    const host = hosts.at(-1)!;
    expect(host.querySelector('.xterm')).not.toBeNull();
    engine.dispose();
    engine.dispose();
    expect(host.querySelector('.xterm')).toBeNull();
  });
});

describe('measuring and re-measuring', () => {
  function fakeConstructors(proposal: { cols: number; rows: number } | undefined) {
    const fontWrites: Array<string | undefined> = [];
    const calls: string[] = [];
    class FakeTerminal {
      cols = 80;
      rows = 24;
      textarea = undefined;
      buffer = { active: { viewportY: 0, baseY: 0 } };
      options = {
        get fontFamily() {
          return 'Mono';
        },
        set fontFamily(value: string | undefined) {
          fontWrites.push(value);
        },
      };
      onTitleChange() {}
      onWriteParsed() {}
      onResize() {}
      registerLinkProvider() {}
      parser = { registerOscHandler: () => ({ dispose() {} }) };
      loadAddon() {
        calls.push('loadAddon');
      }
      resize(columns: number, rows: number) {
        this.cols = columns;
        this.rows = rows;
      }
      dispose() {}
    }
    class FakeFit {
      proposeDimensions() {
        return proposal;
      }
    }
    return {
      constructors: {
        Terminal: FakeTerminal,
        FitAddon: FakeFit,
      } as unknown as EngineConstructors,
      fontWrites,
      calls,
    };
  }

  test('maps the fit helper proposal to a geometry', () => {
    const { constructors, calls } = fakeConstructors({ cols: 120, rows: 33 });
    const engine = createRendererEngine(constructors, baseOptions);
    expect(calls).toEqual(['loadAddon']);
    expect(engine.measure()).toEqual({ columns: 120, rows: 33 });
  });

  test('passes an unmeasurable container through as nothing', () => {
    const { constructors } = fakeConstructors(undefined);
    expect(createRendererEngine(constructors, baseOptions).measure()).toBeUndefined();
  });

  test('remeasure changes the font family and changes it back', () => {
    const { constructors, fontWrites } = fakeConstructors(undefined);
    createRendererEngine(constructors, baseOptions).remeasure();
    expect(fontWrites).toEqual(['Mono, monospace', 'Mono']);
  });

  test('reads the viewport position from the buffer', () => {
    const { constructors } = fakeConstructors(undefined);
    expect(createRendererEngine(constructors, baseOptions).following).toBe(true);
  });
});

describe('the accepted parse boundary', () => {
  test('acknowledges a chunk when it is parsed, with painting never running', async () => {
    const original = globalThis.requestAnimationFrame;
    // A hidden page never runs animation frames, so nothing paints; parsing must not wait for one.
    globalThis.requestAnimationFrame = () => 0;
    try {
      const { engine, capture } = mountedEngine();
      await new Promise<void>((resolve) => engine.write(bytes('hidden page output'), resolve));
      const oracle = {
        bufferType: 'normal',
        cursor: { x: 18, y: 0 },
        lines: ['hidden page output'],
      } as const;
      expect(capture(oracle)).toEqual(oracle);
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });

  test('acknowledges chunks in order', async () => {
    const { engine } = mountedEngine();
    const order: number[] = [];
    await new Promise<void>((resolve) => {
      for (let index = 0; index < 5; index += 1) {
        engine.write(bytes(`chunk ${index}\r\n`), () => {
          order.push(index);
          if (index === 4) resolve();
        });
      }
    });
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test('does not acknowledge bytes the engine has not parsed: a held tail waits for its completion', async () => {
    const { engine } = mountedEngine();
    const order: string[] = [];
    engine.write(Uint8Array.of(0x61, 0xe2, 0x80), () => order.push('first'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // `a` is parsed, but `E2 80` is not, so the chunk that carried them is not acknowledged.
    expect(order).toEqual([]);
    await new Promise<void>((resolve) =>
      engine.write(Uint8Array.of(0x8d, 0x62), () => {
        order.push('second');
        resolve();
      }),
    );
    expect(order).toEqual(['first', 'second']);
  });

  test('a chunk that holds only the start of a character is acknowledged with its completion', async () => {
    const { engine } = mountedEngine();
    const order: string[] = [];
    engine.write(Uint8Array.of(0xf0, 0x9f), () => order.push('a'));
    engine.write(Uint8Array.of(0x91), () => order.push('b'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual([]);
    await new Promise<void>((resolve) =>
      engine.write(Uint8Array.of(0xa8), () => {
        order.push('c');
        resolve();
      }),
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('ending the output parses what was held and acknowledges it', async () => {
    const { engine } = mountedEngine();
    const order: string[] = [];
    engine.write(Uint8Array.of(0x61, 0xe2, 0x80), () => order.push('held'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual([]);
    engine.finishOutput();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual(['held']);
    // Nothing is held any more, so ending again is a no-op.
    engine.finishOutput();
  });

  test('an invalid prefix is parsed at once rather than held', async () => {
    const { engine } = mountedEngine();
    let acknowledged = 0;
    await new Promise<void>((resolve) =>
      engine.write(Uint8Array.of(0x61, 0xe0, 0x80), () => {
        acknowledged += 1;
        resolve();
      }),
    );
    expect(acknowledged).toBe(1);
  });

  test('ending the output after disposal does nothing', () => {
    const { engine } = mountedEngine();
    engine.dispose();
    expect(() => engine.finishOutput()).not.toThrow();
  });

  test('never acknowledges a write the engine disposal overtook', async () => {
    const { engine } = mountedEngine();
    let acknowledged = 0;
    engine.write(bytes('late'), () => {
      acknowledged += 1;
    });
    engine.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acknowledged).toBe(0);
  });

  test('ignores a write after disposal', async () => {
    const { engine } = mountedEngine();
    engine.dispose();
    let acknowledged = 0;
    engine.write(bytes('after'), () => {
      acknowledged += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acknowledged).toBe(0);
  });

  test('copies the chunk, so a producer that reuses its buffer cannot change what was written', async () => {
    const { engine, capture } = mountedEngine();
    const chunk = bytes('original');
    const written = new Promise<void>((resolve) => engine.write(chunk, resolve));
    chunk.fill(0x58);
    await written;
    const oracle = { bufferType: 'normal', cursor: { x: 8, y: 0 }, lines: ['original'] } as const;
    expect(capture(oracle)).toEqual(oracle);
  });

  test('keeps a zero-width joiner whose encoding a chunk boundary cuts (xterm 6.0.0 drops it)', async () => {
    const { deliver, capture } = mountedEngine();
    const whole = bytes('a‍b');
    await deliver([whole.slice(0, 3), whole.slice(3)]);
    const oracle = {
      bufferType: 'normal',
      cursor: { x: 2, y: 0 },
      lines: ['a‍b'],
      cells: [{ x: 0, y: 0, chars: 'a‍', width: 1 }],
    } as const;
    expect(capture(oracle)).toEqual(oracle);
  });
});

describe('read-only views', () => {
  const queries = bytes(`${ESC}[6n${ESC}[c${ESC}]10;?\u0007`);

  test('a writable view answers terminal queries', async () => {
    const { deliver, replies } = mountedEngine();
    await deliver([queries]);
    expect(replies).toHaveLength(3);
  });

  test('a read-only view sends no automatic query replies', async () => {
    const { deliver, replies } = mountedEngine({ readOnly: true });
    await deliver([queries]);
    expect(replies).toEqual([]);
  });

  test('switching to read-only stops replies, and back resumes them', async () => {
    const { engine, deliver, replies } = mountedEngine();
    const settings = {
      readOnly: true,
      announceOutput: false,
      reducedMotion: false,
      ariaLabel: 'Terminal',
      theme: {},
    };
    engine.update(settings);
    await deliver([queries]);
    expect(replies).toEqual([]);
    engine.update({ ...settings, readOnly: false });
    await deliver([queries]);
    expect(replies).toHaveLength(3);
  });
});

describe('output stays inert', () => {
  test('HTML and script text is data, never DOM', async () => {
    const { deliver, terminal } = mountedEngine();
    const host = hosts.at(-1)!;
    await deliver([
      bytes(
        '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script><b>bold</b>\r\n',
      ),
    ]);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('<img src=x');
  });

  test('OSC 52 never touches the clipboard', async () => {
    const writes: string[] = [];
    const clipboard = {
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
      readText: () => {
        writes.push('read');
        return Promise.resolve('');
      },
    };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    try {
      const { deliver, replies } = mountedEngine();
      await deliver([bytes(`${ESC}]52;c;aGVsbG8=\u0007${ESC}]52;c;?\u0007`)]);
      expect(writes).toEqual([]);
      expect(replies).toEqual([]);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test('window-control requests are ignored', async () => {
    const { deliver, engine } = mountedEngine();
    await deliver([bytes(`${ESC}[8;10;10t${ESC}[22;0t${ESC}[1t${ESC}[2t`)]);
    expect(engine.geometry).toEqual({ columns: 40, rows: 8 });
  });

  test('a hidden OSC 8 destination opens nothing and is not offered as a link', async () => {
    const opened: unknown[] = [];
    const original = window.open;
    window.open = ((...parameters: unknown[]) =>
      opened.push(parameters)) as unknown as typeof window.open;
    try {
      const { deliver, engine, linkProviders } = mountedEngine();
      engine.setLinkActivation(() => opened.push('activated'));
      await deliver([bytes(`${ESC}]8;;https://hidden.test/${ESC}\\click here${ESC}]8;;${ESC}\\`)]);
      const links = await provide(linkProviders[0]!, 1);
      expect(links).toEqual([]);
    } finally {
      window.open = original;
    }
    expect(opened).toEqual([]);
  });

  test('a hidden OSC 8 destination is consumed by the engine, so it never owns a link', async () => {
    const { deliver, terminal } = mountedEngine();
    // The engine registers its own OSC 8 link provider whatever the host does, and it offers a
    // link for any cell that carries a hyperlink id: so no provider at all may find one.
    const core = (
      terminal as unknown as {
        _core: { _linkProviderService: { linkProviders: ILinkProvider[] } };
      }
    )._core;
    await deliver([
      bytes(`${ESC}]8;;https://hidden.test/${ESC}\\click here${ESC}]8;;${ESC}\\ plain`),
    ]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('click here plain');
    const providers = core._linkProviderService.linkProviders;
    expect(providers.length).toBeGreaterThan(1);
    for (const provider of providers) expect(await provide(provider, 1)).toEqual([]);
  });

  test('an OSC 8 with parameters and an id is consumed the same way, even for a visible-looking https target', async () => {
    const { deliver, terminal } = mountedEngine();
    const core = (
      terminal as unknown as {
        _core: { _linkProviderService: { linkProviders: ILinkProvider[] } };
      }
    )._core;
    await deliver([
      bytes(`${ESC}]8;id=a:foo=bar;https://id.hidden.test/x${ESC}\\path${ESC}]8;;${ESC}\\`),
    ]);
    for (const provider of core._linkProviderService.linkProviders) {
      expect(await provide(provider, 1)).toEqual([]);
    }
  });

  test('an empty chunk behind a held prefix is acknowledged on its own and nothing piles up', async () => {
    const { engine } = mountedEngine();
    const acknowledged: string[] = [];
    // E2 80 starts a three-byte sequence the chunk does not finish, so it is held.
    engine.write(Uint8Array.of(0xe2, 0x80), () => acknowledged.push('prefix'));
    for (let index = 0; index < 50; index += 1) {
      engine.write(new Uint8Array(0), () => acknowledged.push(`empty-${index}`));
    }
    await waitFor(() => acknowledged.length === 50, 'every empty chunk to be acknowledged');
    expect(acknowledged).toEqual(Array.from({ length: 50 }, (_, index) => `empty-${index}`));
    // The prefix is still held and is acknowledged exactly once, when its sequence finishes.
    await new Promise<void>((resolve) =>
      engine.write(Uint8Array.of(0x8b), () => {
        acknowledged.push('finish');
        resolve();
      }),
    );
    expect(acknowledged.filter((entry) => entry === 'prefix')).toEqual(['prefix']);
    expect(acknowledged.slice(-2)).toEqual(['prefix', 'finish']);
  });

  test('an empty chunk keeps its place behind earlier chunks that need no prefix', async () => {
    const { engine } = mountedEngine();
    const order: string[] = [];
    engine.write(bytes('output'), () => order.push('first'));
    engine.write(new Uint8Array(0), () => order.push('empty'));
    await waitFor(() => order.length === 2, 'both acknowledgements');
    expect(order).toEqual(['first', 'empty']);
  });

  test('update applies a new font family and size and leaves them alone when absent', () => {
    const { engine, terminal } = mountedEngine();
    const settings = {
      readOnly: false,
      announceOutput: false,
      reducedMotion: false,
      ariaLabel: 'Terminal',
      theme: {},
    };
    engine.update({ ...settings, fontFamily: 'Fira, monospace', fontSize: 19 });
    expect(terminal.options.fontFamily).toBe('Fira, monospace');
    expect(terminal.options.fontSize).toBe(19);
    engine.update(settings);
    expect(terminal.options.fontFamily).toBe('Fira, monospace');
    expect(terminal.options.fontSize).toBe(19);
  });

  test('titles reach the host as bounded plain text', async () => {
    const { deliver, titles } = mountedEngine();
    await deliver([
      bytes(`${ESC}]0;build <b>ok</b>\u0007`),
      bytes(`${ESC}]2;${'t'.repeat(MAXIMUM_TITLE_CODE_POINTS + 50)}\u0007`),
    ]);
    expect(titles[0]).toBe('build <b>ok</b>');
    expect(titles[1]).toBe('t'.repeat(MAXIMUM_TITLE_CODE_POINTS));
  });

  test('does not require an onTitle handler', async () => {
    const bare = createRendererEngine({ Terminal, FitAddon }, baseOptions);
    await new Promise<void>((resolve) => bare.write(bytes(`${ESC}]0;title\u0007`), resolve));
    bare.dispose();
  });
});

function provide(provider: ILinkProvider, line: number): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(line, (links) => resolve(links ?? [])));
}

describe('opt-in links', () => {
  const sentence = 'docs at https://example.test/guide, not http://plain.test or /etc/passwd';

  test('offers nothing until the host opts in', async () => {
    const { deliver, linkProviders } = mountedEngine();
    await deliver([bytes(sentence)]);
    expect(await provide(linkProviders[0]!, 1)).toEqual([]);
  });

  test('offers visible HTTPS text only, and activation reports exactly that text', async () => {
    const { deliver, engine, linkProviders } = mountedEngine();
    const activated: string[] = [];
    engine.setLinkActivation((url) => activated.push(url));
    await deliver([bytes(sentence)]);
    const links = await provide(linkProviders[0]!, 1);
    expect(links.map((link) => link.text)).toEqual(['https://example.test/guide']);
    const range: IBufferRange = links[0]!.range;
    expect(range.start).toEqual({ x: 9, y: 1 });
    expect(range.end).toEqual({ x: 34, y: 1 });
    links[0]!.activate(new MouseEvent('click'), links[0]!.text);
    expect(activated).toEqual(['https://example.test/guide']);
  });

  test('refuses to activate text that is not a visible HTTPS address', async () => {
    const { deliver, engine, linkProviders } = mountedEngine();
    const activated: string[] = [];
    engine.setLinkActivation((url) => activated.push(url));
    await deliver([bytes(sentence)]);
    const [link] = await provide(linkProviders[0]!, 1);
    for (const text of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      '/etc/passwd',
      'http://plain.test',
    ]) {
      link!.activate(new MouseEvent('click'), text);
    }
    expect(activated).toEqual([]);
  });

  test('stops offering links once the host withdraws the handler', async () => {
    const { deliver, engine, linkProviders } = mountedEngine();
    engine.setLinkActivation(() => {});
    await deliver([bytes(sentence)]);
    expect(await provide(linkProviders[0]!, 1)).toHaveLength(1);
    const [link] = await provide(linkProviders[0]!, 1);
    engine.setLinkActivation(undefined);
    expect(await provide(linkProviders[0]!, 1)).toEqual([]);
    expect(() => link!.activate(new MouseEvent('click'), link!.text)).not.toThrow();
  });

  test('finds an address that wraps across rows', async () => {
    const { deliver, engine, linkProviders } = mountedEngine({
      geometry: { columns: 20, rows: 4 },
    });
    engine.setLinkActivation(() => {});
    await deliver([bytes('https://example.test/a/long/path')]);
    const links = await provide(linkProviders[0]!, 2);
    expect(links.map((link) => link.text)).toEqual(['https://example.test/a/long/path']);
    expect(links[0]!.range.start.y).toBe(1);
    expect(links[0]!.range.end.y).toBe(2);
  });
});

describe('retained projection', () => {
  test('joins soft wraps and keeps hard line boundaries as LF', async () => {
    const { deliver, engine } = mountedEngine({ geometry: { columns: 20, rows: 6 } });
    await deliver([bytes(`${'1234567890'.repeat(5)}\r\nsecond line\r\n`)]);
    expect(engine.readProjection()).toEqual({
      text: `${'1234567890'.repeat(5)}\nsecond line`,
      truncated: false,
      bytes: 50 + 1 + 11,
      lines: [
        { row: 0, start: 0 },
        { row: 3, start: 51 },
      ],
    });
  });

  test('adds no padding for wide characters', async () => {
    const { deliver, engine } = mountedEngine({ geometry: { columns: 10, rows: 4 } });
    await deliver([bytes('日本語日本語日本語\r\nend')]);
    expect(engine.readProjection().text).toBe('日本語日本語日本語\nend');
  });

  test('keeps a space at a wrap point and a wide character that wraps whole', async () => {
    const { deliver, engine } = mountedEngine({ geometry: { columns: 20, rows: 4 } });
    await deliver([bytes(`${'a'.repeat(19)}日x\r\n${'b'.repeat(19)} c`)]);
    expect(engine.readProjection().text).toBe(`${'a'.repeat(19)}日x\n${'b'.repeat(19)} c`);
  });

  test('projects the active buffer, which is the alternate one while it is shown', async () => {
    const { deliver, engine } = mountedEngine();
    await deliver([bytes(`main text${ESC}[?1049h${ESC}[2J${ESC}[1;1Hfull screen`)]);
    expect(engine.readProjection().text).toBe('full screen');
    await deliver([bytes(`${ESC}[?1049l`)]);
    expect(engine.readProjection().text).toBe('main text');
  });

  test('includes scrollback and is bounded by the byte limit', async () => {
    const { deliver, engine } = mountedEngine({ geometry: { columns: 20, rows: 4 } });
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\r\n');
    await deliver([bytes(lines)]);
    const full = engine.readProjection();
    expect(full.text.startsWith('line 0\nline 1\n')).toBe(true);
    expect(full.text.endsWith('line 49')).toBe(true);
    const bounded = engine.readProjection(40);
    expect(bounded.truncated).toBe(true);
    expect(bounded.bytes).toBeLessThanOrEqual(40);
  });
});

describe('reading position', () => {
  async function fill(captured: CapturedEngine, lines: number, from = 0): Promise<void> {
    const text = Array.from({ length: lines }, (_, index) => `row ${from + index}`).join('\r\n');
    await captured.deliver([bytes(`${text}\r\n`)]);
  }

  test('follows new output from the live bottom', async () => {
    const captured = mountedEngine();
    await fill(captured, 30);
    expect(captured.engine.following).toBe(true);
    const buffer = captured.terminal.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY);
    expect(buffer.baseY).toBeGreaterThan(0);
    await fill(captured, 5, 30);
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  test('keeps the reader where they scrolled while output appends, and resumes at the bottom', async () => {
    // The scroll position lives in the engine's buffer. A mounted engine would route scrolling
    // through a DOM scroll container, which has no layout here, so this view stays unmounted.
    const captured = createCapturedEngine();
    engines.push(captured);
    await fill(captured, 30);
    const buffer = captured.terminal.buffer.active;
    captured.terminal.scrollLines(-6);
    const reading = buffer.viewportY;
    expect(captured.engine.following).toBe(false);
    await fill(captured, 10, 30);
    expect(buffer.viewportY).toBe(reading);
    expect(captured.engine.following).toBe(false);
    captured.terminal.scrollToBottom();
    expect(captured.engine.following).toBe(true);
    await fill(captured, 3, 40);
    expect(buffer.viewportY).toBe(buffer.baseY);
  });
});
