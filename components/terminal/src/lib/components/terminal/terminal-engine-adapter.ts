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
};

export type EngineCreateOptions = EngineSettings & {
  geometry: TerminalGeometry;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
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
   * three bytes) is held and parsed with the next chunk, and acknowledged with this one.
   */
  write(chunk: Uint8Array, parsed: () => void): void;
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
      // `take` returns a view of a fresh buffer, so the engine never aliases the caller's chunk.
      terminal.write(carry.take(chunk), () => {
        if (!disposed) parsed();
      });
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
    dispose() {
      if (disposed) return;
      disposed = true;
      terminal.dispose();
    },
  };
}
