import type { FitAddon } from '@xterm/addon-fit';
import type {
  ILinkHandler,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal,
} from '@xterm/xterm';

import { boundTitle, linksForRow, parseVisibleHttpsUrl } from './terminal-links.ts';
import { projectBuffer, type TerminalProjection } from './terminal-projection.ts';
import type { EngineTheme } from './terminal-theme.ts';
import { createUtf8Carry } from './terminal-utf8-boundary.ts';
import type { TerminalGeometry } from './terminal.types.ts';

/** The retained scrollback, from `documentation/terminal/security-and-budgets.md`. */
export const SCROLLBACK_LINES = 10_000;

/** The grid the engine starts with, before the first fit or owner geometry arrives. */
export const INITIAL_GEOMETRY: TerminalGeometry = { columns: 80, rows: 24 };

/** The engine classes, loaded together so one failure covers both. */
export type EngineConstructors = {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
};

/** What can change while the engine is alive. */
export type EngineSettings = {
  /** A read-only engine sends no input and no automatic terminal query replies. */
  readOnly: boolean;
  announceOutput: boolean;
  reducedMotion: boolean;
  ariaLabel: string;
  theme: EngineTheme;
  /** The computed font, re-read on refresh. Left as it is when absent. */
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
};

export type EngineCreateOptions = EngineSettings & {
  geometry: TerminalGeometry;
  /** Called with a bounded plain-text title whenever the program sets one. */
  onTitle?: ((title: string) => void) | undefined;
};

/**
 * OSC 8 hyperlinks carry a destination the reader cannot see, so they are never actionable. With
 * no handler the engine would confirm and then open the destination; this handler takes the
 * activation and does nothing, and refuses non-HTTP destinations outright.
 */
const INERT_LINK_HANDLER: ILinkHandler = {
  activate: () => {},
  allowNonHttpProtocols: false,
};

/**
 * The engine options for `options`. Only options with a reason are set: no proposed API, no
 * window-control requests (the engine ignores them unless enabled), no line-ending conversion, and
 * a link handler that never acts.
 */
export function buildEngineOptions(
  options: EngineCreateOptions,
): ITerminalOptions & ITerminalInitOnlyOptions {
  return {
    cols: options.geometry.columns,
    rows: options.geometry.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: false,
    convertEol: false,
    disableStdin: options.readOnly,
    cursorBlink: !options.reducedMotion && !options.readOnly,
    screenReaderMode: options.announceOutput,
    linkHandler: INERT_LINK_HANDLER,
    theme: { ...options.theme },
    ...(options.fontFamily === undefined ? {} : { fontFamily: options.fontFamily }),
    ...(options.fontSize === undefined ? {} : { fontSize: options.fontSize }),
  };
}

/**
 * One report of input the engine produced. Its two shapes convert to bytes differently, so they
 * stay distinct: `text` is characters and goes out as UTF-8, `binary` is one byte per character.
 * Automatic replies to terminal queries arrive here too, as `text`; a read-only engine produces
 * neither (it sets `disableStdin`, which the engine checks before any report is made).
 */
export type EngineInputReport = { kind: 'text' | 'binary'; data: string };

/**
 * The engine's key hook. xterm.js 6.0.0 calls it for every keydown, keypress and keyup on its
 * input element, before it does anything else with the event, and skips the event only when the
 * hook returns exactly `false` (`CoreBrowserTerminal._keyDown`, `_keyPress` and `_keyUp` all test
 * `=== false`). Any other value, including `undefined`, lets the engine process it. The engine
 * never prevents the event's default or stops its propagation on a skipped event, so the browser
 * acts on it unless the hook prevents it. Input events, IME composition and paste never ask the
 * hook.
 */
export type EngineKeyHook = (event: KeyboardEvent) => boolean;

/**
 * The private face of the selected engine. Nothing outside the renderer receives the engine
 * instance, its option bag, its parser, or its write queue: only these deliberate operations.
 */
export type RendererEngine = {
  /** Attach the engine's DOM to `host`. Call once. */
  mount(host: HTMLElement): void;
  /**
   * Parse `chunk`. `parsed` runs once when the engine has parsed it, which is independent of
   * painting, and never runs after {@link RendererEngine.dispose}. The chunk is copied, so the
   * caller may reuse its buffer at once. A unicode sequence the chunk leaves unfinished (at most
   * three bytes) is held and parsed with the next chunk, so the chunk is acknowledged only when
   * the write that includes its last byte completes: with the next chunk, or on
   * {@link RendererEngine.finishOutput}. An empty chunk has no bytes to wait for: it is
   * acknowledged by its own write, never held behind a prefix.
   */
  write(chunk: Uint8Array, parsed: () => void): void;
  /**
   * No more output will arrive. Parse whatever unicode prefix is still held, as the data it now
   * is, and acknowledge the chunks that carried it. Does nothing when nothing is held.
   */
  finishOutput(): void;
  /** Set the engine grid. */
  resize(geometry: TerminalGeometry): void;
  /** The grid that fits the container at the engine's measured cell size, if it can be measured. */
  measure(): { columns: number; rows: number } | undefined;
  readonly geometry: TerminalGeometry;
  update(settings: EngineSettings): void;
  /** Have the engine measure its cells again, after the font changed under it. */
  remeasure(): void;
  /** Offer visible `https:` text to `activate`, or stop offering links when it is `undefined`. */
  setLinkActivation(activate: ((url: string) => void) | undefined): void;
  /** A bounded plain-text projection of the active retained buffer. */
  readProjection(maximumBytes?: number): TerminalProjection;
  /** Whether the viewport shows the live bottom, where new output scrolls into view. */
  readonly following: boolean;
  /**
   * Subscribe to the input the engine produces, as the reports it makes. The returned function
   * unsubscribes. Both shapes arrive through the one listener, in the order the engine made them.
   */
  onInput(listener: (report: EngineInputReport) => void): () => void;
  /** Replace the engine's key hook, or remove it with `undefined`. */
  setKeyHook(hook: EngineKeyHook | undefined): void;
  /** Whether the engine holds a non-empty selection. */
  hasSelection(): boolean;
  /**
   * Paste `text` as the engine does: line breaks become carriage returns and the text is wrapped in
   * the bracketed-paste markers when the program asked for them. It is reported through
   * {@link RendererEngine.onInput} as one text report, and nothing is reported when the engine takes
   * no input.
   */
  paste(text: string): void;
  /** Whether the program asked for pastes to be bracketed, so the engine wraps them in markers. */
  readonly bracketedPaste: boolean;
  /** Move focus to the engine's input element. */
  focus(): void;
  /** Release the engine and its DOM. Safe to call twice. */
  dispose(): void;
};

/** Constructs the engine for a mount. Constructing is cheap and does not touch the document. */
export type RendererEngineFactory = (options: EngineCreateOptions) => RendererEngine;

export function createRendererEngine(
  constructors: EngineConstructors,
  options: EngineCreateOptions,
): RendererEngine {
  const terminal = new constructors.Terminal(buildEngineOptions(options));
  const fit = new constructors.FitAddon();
  terminal.loadAddon(fit);
  let disposed = false;
  let activateLink: ((url: string) => void) | undefined;
  const carry = createUtf8Carry();
  // Acknowledgements for chunks whose last bytes are still held in `carry`, in arrival order.
  let heldAcknowledgements: Array<() => void> = [];

  function writeBytes(bytes: Uint8Array, acknowledgements: Array<() => void>): void {
    terminal.write(bytes, () => {
      if (disposed) return;
      for (const acknowledge of acknowledgements) acknowledge();
    });
  }

  // OSC 8 carries a destination the reader cannot see. The engine turns it into a link of its own
  // (`OscLinkProvider`, always registered) whenever the sequence reaches its parser, whatever the
  // link handler does, so the sequence is consumed here instead: the most recently registered
  // handler runs first and returning true ends the search. The text it wrapped still prints.
  terminal.parser.registerOscHandler(8, () => true);
  terminal.onTitleChange((title) => options.onTitle?.(boundTitle(title)));
  terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      if (activateLink === undefined) {
        callback(undefined);
        return;
      }
      const links = linksForRow(terminal.buffer.active, bufferLineNumber - 1);
      callback(
        links.map(({ url, range }) => ({
          text: url,
          range,
          activate: (_event, text) => {
            const visible = parseVisibleHttpsUrl(text);
            if (visible !== undefined) activateLink?.(visible);
          },
        })),
      );
    },
  });

  return {
    mount(host) {
      terminal.open(host);
      terminal.textarea?.setAttribute('aria-label', options.ariaLabel);
    },
    write(chunk, parsed) {
      if (disposed) return;
      // An empty chunk has no bytes, so a held prefix is no reason to wait: it is acknowledged by
      // its own write, which completes behind the writes already queued (so acknowledgements
      // that need no prefix stay in order) and never behind the prefix, which is not queued yet.
      // Holding it would collect one acknowledgement per empty chunk for as long as the prefix lasts.
      if (chunk.length === 0) {
        writeBytes(chunk, [parsed]);
        return;
      }
      // `take` returns a view of a fresh buffer, so the engine never aliases the caller's chunk.
      const bytes = carry.take(chunk);
      if (bytes.length === 0 && carry.pending > 0) {
        // Every byte of this chunk is held, so nothing is parsed and nothing can be acknowledged.
        heldAcknowledgements.push(parsed);
        return;
      }
      const released = heldAcknowledgements;
      if (carry.pending > 0) {
        // This chunk ends inside a sequence: it is acknowledged with the write that finishes it.
        heldAcknowledgements = [parsed];
        writeBytes(bytes, released);
      } else {
        heldAcknowledgements = [];
        writeBytes(bytes, [...released, parsed]);
      }
    },
    finishOutput() {
      if (disposed) return;
      const rest = carry.flush();
      const released = heldAcknowledgements;
      heldAcknowledgements = [];
      if (rest.length > 0 || released.length > 0) writeBytes(rest, released);
    },
    resize(geometry) {
      terminal.resize(geometry.columns, geometry.rows);
    },
    measure() {
      const proposed = fit.proposeDimensions();
      return proposed === undefined ? undefined : { columns: proposed.cols, rows: proposed.rows };
    },
    get geometry() {
      return { columns: terminal.cols, rows: terminal.rows };
    },
    update(settings) {
      terminal.options.disableStdin = settings.readOnly;
      terminal.options.cursorBlink = !settings.reducedMotion && !settings.readOnly;
      terminal.options.screenReaderMode = settings.announceOutput;
      terminal.options.theme = { ...settings.theme };
      terminal.textarea?.setAttribute('aria-label', settings.ariaLabel);
      if (
        settings.fontFamily !== undefined &&
        settings.fontFamily !== terminal.options.fontFamily
      ) {
        terminal.options.fontFamily = settings.fontFamily;
      }
      if (settings.fontSize !== undefined && settings.fontSize !== terminal.options.fontSize) {
        terminal.options.fontSize = settings.fontSize;
      }
    },
    remeasure() {
      // The engine measures its cell only when a font option changes, so it never notices a web
      // font arriving. Changing the family and changing it back makes it measure again.
      const family = terminal.options.fontFamily;
      terminal.options.fontFamily = `${family ?? ''}, monospace`;
      terminal.options.fontFamily = family ?? '';
    },
    setLinkActivation(activate) {
      activateLink = activate;
    },
    readProjection(maximumBytes) {
      return projectBuffer(terminal.buffer.active, maximumBytes);
    },
    get following() {
      const buffer = terminal.buffer.active;
      return buffer.viewportY >= buffer.baseY;
    },
    onInput(listener) {
      const text = terminal.onData((data) => listener({ kind: 'text', data }));
      const binary = terminal.onBinary((data) => listener({ kind: 'binary', data }));
      return () => {
        text.dispose();
        binary.dispose();
      };
    },
    setKeyHook(hook) {
      // The engine cannot detach a hook; one that always says "process" is the same as none.
      terminal.attachCustomKeyEventHandler(hook ?? (() => true));
    },
    hasSelection() {
      return terminal.hasSelection();
    },
    get bracketedPaste() {
      return !disposed && terminal.modes.bracketedPasteMode;
    },
    paste(text) {
      if (!disposed) terminal.paste(text);
    },
    focus() {
      if (!disposed) terminal.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      terminal.dispose();
    },
  };
}
