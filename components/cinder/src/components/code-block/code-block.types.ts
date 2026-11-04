import type { Highlighter } from '../../utilities/highlighter.ts';

/** How loud a note on a line is. A note on a line that is wrong is `danger`; the default. */
export type CodeBlockAnnotationTone = 'danger' | 'warning' | 'info';

/**
 * A note that belongs to one line of the code, drawn under it.
 *
 * The line's row takes the tone's tint, and the message sits directly beneath with a glyph, so a
 * file problem is read at the line it names. It is presentation only: the copied text is the
 * code, without line numbers or notes.
 */
export interface CodeBlockAnnotation {
  /** The one-based line the note belongs to. A line past the end of the code is ignored. */
  line: number;
  /** The note shown under the line. */
  message: string;
  /** The tone of the tint and the glyph. Defaults to `'danger'`. @default 'danger' */
  tone?: CodeBlockAnnotationTone;
}

/**
 * Props for the CodeBlock component.
 *
 * Renders preformatted code in a `<pre><code>` element. The plain (un-highlighted)
 * path is Svelte-text-interpolated, so HTML entities are escaped automatically.
 *
 * CodeBlock imports no highlighter of its own. When `language` is set it
 * highlights with its `highlighter` prop, else with the highlighter an ancestor
 * published through `setCodeHighlighterContext`, and with neither it renders
 * the escaped plain fallback. The server (and the first client paint) always
 * emits the plain `<pre><code>` fallback. Highlighting is a two-phase,
 * client-only enhancement: colorization may appear after first paint, but the
 * stable viewport keeps the block's layout from moving. Pass
 * `highlight={false}` to keep `language` semantics (the language label) with
 * zero highlighting.
 */
export type CodeBlockProps = {
  /** The code to render. */
  code: string;
  /** Optional language label rendered above the code (there is no header bar); also selects the grammar for highlighting. */
  language?: string;
  /**
   * Whether to highlight. Defaults to `true` whenever `language` is set and a
   * highlighter resolves from the `highlighter` prop or from context.
   *
   * `highlight={false}` is an absolute off switch: it disables ALL
   * highlighting — including an explicit `highlighter` prop and a context
   * highlighter. The block renders the escaped plain `<pre><code>` fallback
   * while keeping the `language` label. When highlighting is enabled,
   * client-side colorization may appear after first paint, but the block keeps
   * stable layout metrics.
   */
  highlight?: boolean;
  /**
   * Highlighter for this instance. Receives `(code, language)` and returns an
   * HTML string (sync or async). Takes precedence over a highlighter an
   * ancestor published through `setCodeHighlighterContext`; with neither, the
   * block renders unhighlighted.
   *
   * @security The returned string is rendered VERBATIM via `{@html}` — it is a
   * trusted-HTML boundary. The highlighter MUST escape any user- or
   * caller-provided `code` before returning markup, or it opens an
   * HTML-injection / XSS hole. cinder's only safety guarantee is that the
   * bundled `@lostgradient/cinder` adapter WITH DEFAULT OPTIONS escapes
   * code text; a custom `highlighter` (and Shiki with custom transformers /
   * decorations / raw-HTML options) is caller-owned and not vouched for. Use
   * `highlight={false}` when you want guaranteed-escaped plaintext.
   */
  highlighter?: Highlighter;
  /** When true, render an icon-only copy button above the code. The block has no header bar or frame. */
  copyable?: boolean;
  /**
   * Whether to render the language label above the code. Default `true`.
   * Pass `false` to keep `language`-driven highlighting without the visible
   * label; with `copyable` also unset, nothing renders above the code.
   */
  languageLabelVisible?: boolean;
  /**
   * Show a scroll-driven fade on the horizontal (inline) edges of the code
   * viewport as a long line overflows — signals "this line continues" rather
   * than dimming a wrapped block. Opt-in and presentation-only. The gradient
   * terminates at partial opacity (not fully opaque) so a half-covered glyph
   * still reads as a glyph, not as a hard cutoff. Defaults to `false`.
   */
  scrollFadeVisible?: boolean;
  /**
   * Number each line of the code. The numbers are drawn in the left gutter, kept out of the copied
   * text and out of the accessibility tree, and a wrapped line is numbered once. Defaults to
   * `false`. @default false
   */
  lineNumbers?: boolean;
  /**
   * Notes drawn under specific lines, such as the line a file problem points at. Works with
   * highlighted and plain code alike. Pass a new array to change them.
   */
  annotations?: readonly CodeBlockAnnotation[];
  /**
   * Wrap a line longer than the block instead of scrolling it sideways. Defaults to `false`, which
   * keeps the block a fixed-width box that scrolls inside itself with a visible scrollbar.
   * @default false
   */
  wrap?: boolean;
  /** Additional class names merged with `.cinder-code-block`. */
  class?: string;
};
