/**
 * The host's theme, applied to a panel (COR-2218). A panel is a document in a sandboxed frame, and
 * its host sends the owner's colors, fonts and radii as MCP Apps style variables, and light or
 * dark as `theme`. Writing them onto the document is what `@lostgradient/cinder/panel` reads: each
 * `--cinder-*` token it maps is `var(--color-…, <Cinder default>)`, so the panel follows the host
 * in light and dark and looks like Cinder where the host sends nothing. Every inspector applies it
 * the same way, on connect and on every change the host reports.
 */
import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type App,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

/** Write what the host sent onto the document: its theme, its style variables and its font faces. */
export function applyHostContext(context: McpUiHostContext | undefined): void {
  if (context?.theme !== undefined) applyDocumentTheme(context.theme);
  if (context?.styles?.variables !== undefined) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts !== undefined) applyHostFonts(context.styles.css.fonts);
}

/**
 * Follow the host's theme for as long as `app` lives: apply every change the host reports, and
 * return what applies the context the host sent when it connected. Call the returned function
 * once, after `app.connect()`.
 */
export function followHostTheme(app: App): () => void {
  app.onhostcontextchanged = (context) => applyHostContext(context);
  return () => applyHostContext(app.getHostContext());
}
