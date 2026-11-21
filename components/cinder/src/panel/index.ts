/**
 * The Cinder panel kit (COR-2215): what a plugin's panel imports to look like the application that
 * hosts it. A panel is one self-contained document in a sandboxed frame under a deny-all content
 * security policy. This entry mounts a Svelte component into that document and brings Cinder's
 * stylesheet with the MCP Apps host's theme variables wired to Cinder's tokens.
 *
 * Importing this module has two side effects, both stylesheets: Cinder's shared layers, and the
 * panel's unlayered token overrides, which read the host's `--color-*`, `--font-*`,
 * `--border-*` variables with Cinder's own value as the fallback. The module depends on neither
 * `@modelcontextprotocol/ext-apps` nor a host: the panel calls the SDK's `applyDocumentTheme` and
 * `applyHostStyleVariables` itself, and those write the variables the stylesheet reads.
 *
 * Inside the frame, dialogs, popovers and toasts render in the frame and never above the host's
 * own interface, keyboard focus does not flow between the host and the panel, and navigation,
 * links, resizing and notifications go through the host's bridge, not the page.
 *
 * The components a panel is built to show are re-exported from here, so a panel imports them and
 * its mount from one place. `JsonDiffViewer` is the first: a run comparison panel shows what
 * differs between two JSON values with the component the page uses.
 */
import { mount, type Component, type MountOptions } from 'svelte';

import '../styles/index.css';
import './panel.css';

export { default as JsonDiffViewer } from '../components/json-diff-viewer/index.ts';
export type { JsonDiffViewerProps } from '../components/json-diff-viewer/index.ts';

/**
 * Each pair is an MCP Apps style variable the host sends and the Cinder token the panel's
 * stylesheet fills from it, in the order the stylesheet declares them. The stylesheet reads
 * `var(<specKey>, <Cinder default>)` for each `cinderToken`, and every other Cinder token keeps its
 * own default.
 */
export const PANEL_TOKEN_MAP: ReadonlyArray<readonly [specKey: string, cinderToken: string]> = [
  ['--color-background-primary', '--cinder-surface-canvas'],
  ['--color-background-secondary', '--cinder-surface'],
  ['--color-background-tertiary', '--cinder-surface-raised'],
  ['--color-background-success', '--cinder-status-success-background'],
  ['--color-background-danger', '--cinder-status-danger-background'],
  ['--color-background-warning', '--cinder-status-warning-background'],
  ['--color-background-info', '--cinder-status-info-background'],
  ['--color-text-primary', '--cinder-text-default'],
  ['--color-text-secondary', '--cinder-text-muted'],
  ['--color-text-tertiary', '--cinder-text-subtle'],
  ['--color-text-success', '--cinder-status-success-text'],
  ['--color-text-danger', '--cinder-status-danger-text'],
  ['--color-text-warning', '--cinder-status-warning-text'],
  ['--color-text-info', '--cinder-status-info-text'],
  ['--color-border-primary', '--cinder-border'],
  ['--color-border-secondary', '--cinder-border-muted'],
  ['--color-border-info', '--cinder-status-info-border'],
  ['--color-ring-primary', '--cinder-ring-color'],
  ['--color-ring-secondary', '--cinder-ring-offset-color'],
  ['--font-sans', '--cinder-font-sans'],
  ['--font-mono', '--cinder-font-mono'],
  ['--font-weight-semibold', '--cinder-font-semibold'],
  ['--font-text-xs-size', '--cinder-text-xs'],
  ['--font-text-xs-line-height', '--cinder-leading-normal'],
  ['--border-radius-sm', '--cinder-radius-sm'],
  ['--border-width-regular', '--cinder-ring-width'],
];

/** Where {@link mountPanel} mounts a panel, and what it passes the component. */
export type PanelMountOptions<Props extends Record<string, unknown>> = {
  /** The element the component mounts into. The document body by default. */
  readonly target?: Element | Document | ShadowRoot;
  /** The component's props. */
  readonly props?: Props;
};

/**
 * Mount `component` into `options.target`, the document body unless another is given, and return
 * what the component exports. It wraps Svelte's `mount`, so the panel's component runs in the
 * browser's document with Cinder's styles loaded.
 */
export function mountPanel<
  Props extends Record<string, unknown> = Record<string, never>,
  Exports extends Record<string, unknown> = Record<string, never>,
>(component: Component<Props, Exports>, options: PanelMountOptions<Props> = {}): Exports {
  const { target = document.body, props } = options;
  // Svelte types the options of `mount` by whether `Props` has a required key, which a generic
  // wrapper cannot show the compiler. These carry `props` exactly when the caller gave them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const mountOptions = { target, ...(props === undefined ? {} : { props }) } as MountOptions<Props>;
  return mount(component, mountOptions);
}
