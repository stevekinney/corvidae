/**
 * The board renderer (`scripts/design-review-render-boards.ts`): the size a board asks for, when a
 * board is sliced and how, the command line, the checks that run inside the page, and the render
 * itself, driven against a stand-in browser so no Chromium starts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  boardHasMounted,
  boardResponse,
  documentHeight,
  fontsHaveLoaded,
  layoutProblem,
  measureBoardLayout,
  MINIMUM_TEXT_LENGTH,
  parseArguments,
  previewSize,
  renderBoard,
  renderBoards,
  SLICE_HEIGHT,
  SLICE_THRESHOLD,
  sliceOffsets,
  type BoardBrowser,
  type BoardBrowserPage,
  type BoardLayout,
} from './design-review-render-boards.ts';

describe('previewSize', () => {
  test('reads the board’s $preview size, and falls back to 1440 by 1000', () => {
    expect(previewSize('{"$preview":{"width":390,"height":844},"x":1}')).toEqual({
      width: 390,
      height: 844,
    });
    expect(previewSize('<html>no preview</html>')).toEqual({ width: 1440, height: 1000 });
  });
});

describe('sliceOffsets', () => {
  test('leaves a board that fits whole, and slices a tall one to its last pixel', () => {
    expect(sliceOffsets(SLICE_THRESHOLD)).toEqual([]);
    expect(sliceOffsets(3000)).toEqual([
      { top: 0, height: SLICE_HEIGHT },
      { top: 1200, height: SLICE_HEIGHT },
      { top: 2400, height: 600 },
    ]);
  });
});

describe('parseArguments', () => {
  test('writes beside the boards by default and keeps named boards', () => {
    const options = parseArguments(['--boards', 'boards', 'ChatPage.dc.html']);
    if (typeof options === 'string') throw new Error(options);
    expect(options.out).toBe(options.boards);
    expect(options.boards).toEndWith('/boards');
    expect(options.names).toEqual(['ChatPage.dc.html']);
  });

  test('refuses a missing directory, an unknown flag and a file that is not a board', () => {
    expect(parseArguments([])).toBe('--boards is required');
    expect(parseArguments(['--boards', 'b', '--size', '2'])).toBe('unknown flag --size');
    expect(parseArguments(['--boards', 'b', 'notes.md'])).toBe('notes.md is not a .dc.html board');
    expect(parseArguments(['--boards'])).toBe('--boards needs a value');
  });
});

describe('layoutProblem', () => {
  test('passes a board drawn inside its bounds', () => {
    expect(layoutProblem({ clipped: [], rightmostEdge: 1440, width: 1440 })).toBeUndefined();
  });

  test('fails a board whose root still hides content below an earlier height', () => {
    expect(
      layoutProblem({
        clipped: [{ clientHeight: 6521, scrollHeight: 10057 }],
        rightmostEdge: 1440,
        width: 1440,
      }),
    ).toBe('clips its content: a container 6521px tall holds 10057px');
  });

  test('fails a board with content past its width', () => {
    expect(layoutProblem({ clipped: [], rightmostEdge: 1492.4, width: 1440 })).toBe(
      'draws past its width: content reaches 1492px of 1440px',
    );
  });
});

/** Replaces the page's text, which stands in for a board the canvas runtime has mounted or not. */
function setBody(markup: string, text: string): void {
  document.body.innerHTML = markup;
  Object.defineProperty(document.body, 'innerText', { value: text, configurable: true });
}

/** Gives an element the box a browser would have measured, which happy-dom does not lay out. */
function giveBox(
  element: Element,
  box: { clientHeight: number; scrollHeight: number; right?: number },
): void {
  Object.defineProperty(element, 'clientHeight', { value: box.clientHeight, configurable: true });
  Object.defineProperty(element, 'scrollHeight', { value: box.scrollHeight, configurable: true });
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ right: box.right ?? 0 }),
    configurable: true,
  });
}

describe('the checks that run inside the page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(document.body, 'innerText');
  });

  test('a board has mounted once no x-dc element remains and it holds enough text', () => {
    const text = 'a'.repeat(MINIMUM_TEXT_LENGTH);
    setBody('<x-dc></x-dc>', text);
    expect(boardHasMounted(MINIMUM_TEXT_LENGTH)).toBe(false);
    setBody('<p>short</p>', 'short');
    expect(boardHasMounted(MINIMUM_TEXT_LENGTH)).toBe(false);
    setBody('<p>text</p>', text);
    expect(boardHasMounted(MINIMUM_TEXT_LENGTH)).toBe(true);
  });

  test('answers the document’s fonts promise and the scrolled height', async () => {
    const ready = Promise.resolve('loaded');
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });
    try {
      expect(await fontsHaveLoaded()).toBe('loaded');
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'fonts');
      else Object.defineProperty(document, 'fonts', original);
    }
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2468,
      configurable: true,
    });
    try {
      expect(documentHeight()).toBe(2468);
    } finally {
      Reflect.deleteProperty(document.documentElement, 'scrollHeight');
    }
  });

  test('measures the containers that hide content and the rightmost edge drawn', () => {
    setBody(
      [
        '<div id="root" style="overflow-y: hidden"></div>',
        '<div id="clip" style="overflow-y: clip"></div>',
        '<div id="short" style="overflow-y: hidden"></div>',
        '<div id="fits" style="overflow-y: hidden"></div>',
        '<div id="scrolls" style="overflow-y: auto"></div>',
      ].join(''),
      '',
    );
    const find = (id: string) => {
      const element = document.getElementById(id);
      if (element === null) throw new Error(`no #${id}`);
      return element;
    };
    giveBox(find('root'), { clientHeight: 600, scrollHeight: 1400, right: 1440 });
    giveBox(find('clip'), { clientHeight: 300, scrollHeight: 305.5, right: 1500.5 });
    giveBox(find('short'), { clientHeight: 100, scrollHeight: 900 });
    giveBox(find('fits'), { clientHeight: 400, scrollHeight: 404 });
    giveBox(find('scrolls'), { clientHeight: 400, scrollHeight: 900 });
    expect(measureBoardLayout({ minimum: 200, boardWidth: 1440 })).toEqual({
      clipped: [
        { clientHeight: 600, scrollHeight: 1400 },
        { clientHeight: 300, scrollHeight: 305.5 },
      ],
      rightmostEdge: 1500.5,
      width: 1440,
    });
  });

  test('measures an empty board as having drawn nothing', () => {
    setBody('', '');
    expect(measureBoardLayout({ minimum: 200, boardWidth: 390 })).toEqual({
      clipped: [],
      rightmostEdge: 0,
      width: 390,
    });
  });
});

/** What a stand-in page was asked to do. */
interface PageLog {
  readonly gone: string[];
  readonly shots: {
    path: string;
    clip: { x: number; y: number; width: number; height: number } | undefined;
  }[];
}

interface PageScript {
  readonly mounts: boolean;
  readonly height: number;
  readonly viewport: { width: number; height: number } | null;
  readonly layout: BoardLayout;
  readonly consoleMessages: readonly { type: string; text: string }[];
  readonly pageErrors: readonly string[];
}

type ConsoleListener = (message: { type(): string; text(): string }) => void;

/** A page that answers from a script instead of a browser, and records what it was asked. */
function scriptedPage(script: PageScript, log: PageLog): BoardBrowserPage {
  const pageErrorListeners: ((error: Error) => void)[] = [];
  const consoleListeners: ConsoleListener[] = [];
  function on(event: 'pageerror', listener: (error: Error) => void): unknown;
  function on(event: 'console', listener: ConsoleListener): unknown;
  function on(event: string, listener: unknown): unknown {
    if (event === 'pageerror') pageErrorListeners.push(listener as (error: Error) => void);
    else consoleListeners.push(listener as ConsoleListener);
    return undefined;
  }
  function evaluate(pageFunction: () => unknown): Promise<unknown>;
  function evaluate(
    pageFunction: (request: { minimum: number; boardWidth: number }) => BoardLayout,
    request: { minimum: number; boardWidth: number },
  ): Promise<BoardLayout>;
  async function evaluate(
    pageFunction: unknown,
    request?: { minimum: number; boardWidth: number },
  ): Promise<unknown> {
    if (pageFunction === documentHeight) return script.height;
    if (pageFunction === fontsHaveLoaded) return undefined;
    if (pageFunction === measureBoardLayout && request !== undefined) {
      return { ...script.layout, width: request.boardWidth };
    }
    throw new Error('the page was asked to run a function the test does not know');
  }
  return {
    on,
    async goto(url) {
      log.gone.push(url);
      for (const error of script.pageErrors) {
        for (const listener of pageErrorListeners) listener(new Error(error));
      }
      for (const message of script.consoleMessages) {
        for (const listener of consoleListeners) {
          listener({ type: () => message.type, text: () => message.text });
        }
      }
    },
    async waitForFunction(pageFunction, argument) {
      expect(pageFunction).toBe(boardHasMounted);
      expect(argument).toBe(MINIMUM_TEXT_LENGTH);
      if (!script.mounts) throw new Error('timed out');
    },
    evaluate,
    async screenshot(options) {
      log.shots.push({ path: options.path, clip: options.clip });
    },
    viewportSize: () => script.viewport,
    async close() {},
  };
}

const CLEAN_LAYOUT: BoardLayout = { clipped: [], rightmostEdge: 1000, width: 1440 };

function pageScript(overrides: Partial<PageScript> = {}): PageScript {
  return {
    mounts: true,
    height: 900,
    viewport: { width: 1440, height: 1000 },
    layout: CLEAN_LAYOUT,
    consoleMessages: [],
    pageErrors: [],
    ...overrides,
  };
}

async function renderScripted(script: PageScript, name: string, log?: PageLog) {
  return renderBoard(
    scriptedPage(script, log ?? { gone: [], shots: [] }),
    'http://127.0.0.1:1',
    name,
    '/out',
  );
}

describe('renderBoard', () => {
  test('writes one image for a board that fits and reports no problem', async () => {
    const log: PageLog = { gone: [], shots: [] };
    const result = await renderScripted(pageScript(), 'Chat Page.dc.html', log);
    expect(result).toEqual({ stem: 'Chat Page', height: 900, slices: 0, problem: undefined });
    expect(log.gone).toEqual(['http://127.0.0.1:1/Chat%20Page.dc.html']);
    expect(log.shots).toEqual([{ path: '/out/Chat Page.png', clip: undefined }]);
  });

  test('also writes a clipped slice for each part of a tall board, at the viewport’s width', async () => {
    const log: PageLog = { gone: [], shots: [] };
    const result = await renderScripted(
      pageScript({ height: 2600, viewport: { width: 390, height: 844 } }),
      'Tall.dc.html',
      log,
    );
    expect(result.slices).toBe(3);
    expect(log.shots.map((shot) => shot.path)).toEqual([
      '/out/Tall.png',
      '/out/Tall--part1.png',
      '/out/Tall--part2.png',
      '/out/Tall--part3.png',
    ]);
    expect(log.shots.slice(1).map((shot) => shot.clip)).toEqual([
      { x: 0, y: 0, width: 390, height: SLICE_HEIGHT },
      { x: 0, y: 1200, width: 390, height: SLICE_HEIGHT },
      { x: 0, y: 2400, width: 390, height: 200 },
    ]);
  });

  test('falls back to the default width when the page reports no viewport', async () => {
    const log: PageLog = { gone: [], shots: [] };
    const result = await renderScripted(
      pageScript({ height: 1500, viewport: null }),
      'Wide.dc.html',
      log,
    );
    expect(log.shots[1]?.clip?.width).toBe(1440);
    expect(result.problem).toBeUndefined();
  });

  test('names a board that never mounted before anything else', async () => {
    const result = await renderScripted(
      pageScript({ mounts: false, pageErrors: ['boom'] }),
      'Empty.dc.html',
    );
    expect(result.problem).toBe(
      'never mounted (an x-dc element remained, or the board held no text)',
    );
  });

  test('names the first page error or console error, truncated, and ignores other console output', async () => {
    const quiet = await renderScripted(
      pageScript({ consoleMessages: [{ type: 'log', text: 'hello' }] }),
      'Quiet.dc.html',
    );
    expect(quiet.problem).toBeUndefined();
    const failed = await renderScripted(
      pageScript({
        pageErrors: ['x'.repeat(200)],
        consoleMessages: [{ type: 'error', text: 'second' }],
      }),
      'Broken.dc.html',
    );
    expect(failed.problem).toBe(`logged 2 error(s): ${'x'.repeat(160)}`);
  });

  test('names a board that clips its own content', async () => {
    const result = await renderScripted(
      pageScript({
        layout: { clipped: [{ clientHeight: 300, scrollHeight: 900 }], rightmostEdge: 0, width: 1 },
      }),
      'Clipped.dc.html',
    );
    expect(result.problem).toBe('clips its content: a container 300px tall holds 900px');
  });
});

describe('boardResponse', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'board-response-'));
    await writeFile(join(root, 'support.js'), 'export {};');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('serves a file below the boards directory', async () => {
    const response = boardResponse(root, new Request('http://127.0.0.1/support.js'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export {};');
  });

  test('refuses a path that climbs out of the boards directory', () => {
    const response = boardResponse(root, new Request('http://127.0.0.1/..%2F..%2Fetc%2Fpasswd'));
    expect(response.status).toBe(404);
  });

  // Regression (COR-2304): a canvas saves its uploaded stylesheet as `_blob/<id>` with no
  // extension, which was served as `application/octet-stream`, so the browser refused it.
  test('serves an extensionless stylesheet blob as text/css', async () => {
    const stylesheet = '/* tokens */\n:root { --accent: #c33; }\nbody { color: var(--accent); }\n';
    await mkdir(join(root, '_blob'));
    await writeFile(join(root, '_blob', 'asset-1'), stylesheet);
    const response = boardResponse(root, new Request('http://127.0.0.1/_blob/asset-1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/css');
    expect(await response.text()).toBe(stylesheet);
  });

  test('serves a stylesheet blob that opens with an at-rule as text/css', async () => {
    await mkdir(join(root, '_blob'));
    await writeFile(join(root, '_blob', 'asset-2'), '@layer base;\n.card { padding: 8px; }\n');
    const response = boardResponse(root, new Request('http://127.0.0.1/_blob/asset-2'));
    expect(response.headers.get('content-type')).toStartWith('text/css');
  });

  test('leaves a blob that is not a stylesheet untyped', async () => {
    await mkdir(join(root, '_blob'));
    await writeFile(join(root, '_blob', 'script'), 'export default { name: "board" };\n');
    await writeFile(join(root, '_blob', 'data'), '[{"name":"board"}]');
    await writeFile(join(root, '_blob', 'image'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));
    for (const name of ['script', 'data', 'image']) {
      const response = boardResponse(root, new Request(`http://127.0.0.1/_blob/${name}`));
      expect(response.headers.get('content-type') ?? '').not.toStartWith('text/css');
    }
  });
});

describe('renderBoards', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'render-boards-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  interface BrowserLog {
    readonly opened: unknown[];
    closed: number;
    readonly served: number[];
  }

  /** A browser whose pages ask the server for their board, then answer from `script`. */
  function standIn(script: PageScript, log: BrowserLog) {
    const report = { out: '', err: '', launched: 0 };
    const browser: BoardBrowser = {
      async newPage(options) {
        log.opened.push(options);
        const page = scriptedPage(script, { gone: [], shots: [] });
        return {
          ...page,
          async goto(url) {
            const response = await Bun.fetch(url, { headers: { connection: 'close' } });
            log.served.push(response.status);
            await response.text();
          },
        };
      },
      async close() {
        log.closed += 1;
      },
    };
    return {
      report,
      render: (argv: string[]) =>
        renderBoards(argv, {
          standardOutput: (text) => {
            report.out += text;
          },
          standardError: (text) => {
            report.err += text;
          },
          launchBrowser: async () => {
            report.launched += 1;
            return browser;
          },
        }),
    };
  }

  function freshLog(): BrowserLog {
    return { opened: [], closed: 0, served: [] };
  }

  test('answers 2 for a bad command line without starting a browser', async () => {
    const { report, render } = standIn(pageScript(), freshLog());
    expect(await render([])).toBe(2);
    expect(report.err).toBe('--boards is required\n');
    expect(report.launched).toBe(0);
  });

  test('answers 2 for a boards directory without the canvas runtime', async () => {
    const { report, render } = standIn(pageScript(), freshLog());
    expect(await render(['--boards', directory])).toBe(2);
    expect(report.err).toContain('has no support.js');
    expect(report.launched).toBe(0);
  });

  test('renders every board in the directory, in order, at its own preview size', async () => {
    await writeFile(join(directory, 'support.js'), 'export {};');
    await writeFile(join(directory, 'B.dc.html'), '{"$preview":{"width":390,"height":844}}');
    await writeFile(join(directory, 'A.dc.html'), 'no preview');
    await writeFile(join(directory, 'notes.md'), 'not a board');
    const log = freshLog();
    const { report, render } = standIn(pageScript({ height: 2000 }), log);
    expect(await render(['--boards', directory, '--out', join(directory, 'nested', 'out')])).toBe(
      0,
    );
    expect(report.out).toBe('A: 2000px, 2 slices\nB: 2000px, 2 slices\n');
    expect(log.opened).toEqual([
      { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 },
      { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
    ]);
    expect(log.served).toEqual([200, 200]);
    expect(log.closed).toBe(1);
  });

  test('renders only the boards it is named, and answers 1 naming the board that has a problem', async () => {
    await writeFile(join(directory, 'support.js'), 'export {};');
    await mkdir(join(directory, 'out'));
    await writeFile(join(directory, 'Only.dc.html'), 'x');
    await writeFile(join(directory, 'Other.dc.html'), 'x');
    const log = freshLog();
    const { report, render } = standIn(pageScript({ mounts: false }), log);
    expect(await render(['--boards', directory, 'Only.dc.html'])).toBe(1);
    expect(report.out).toBe(
      'Only: 900px; never mounted (an x-dc element remained, or the board held no text)\n',
    );
    expect(log.opened).toHaveLength(1);
  });
});
