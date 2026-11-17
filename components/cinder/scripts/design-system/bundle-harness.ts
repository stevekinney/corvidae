/**
 * The render check of `components/bundle.js` as a design canvas loads it: React 18 as the
 * `window.React` and `window.ReactDOM` globals, then the bundle, then a component mounted through
 * its React wrapper. A bundle that throws while it loads never assigns `window.Cinder`, so a
 * canvas that mounts any component shows nothing; the card previews run their own scripts and
 * would not notice, so the build checks the bundle on a page of its own.
 *
 * React is not a repository dependency: the bundle carries none, and the canvas supplies it. The
 * harness loads React 18.3.1's published UMD builds from `vendor/react/`, byte for byte as npm
 * ships them (with React's licence), the way the canvas loads its own.
 */

import { join } from 'node:path';

const harnessDirectory = join(import.meta.dir, 'vendor', 'react');

/** React 18.3.1's UMD builds, in the order a page loads them: React, then ReactDOM. */
export const REACT_HARNESS_SCRIPTS = {
  react: join(harnessDirectory, 'react.production.min.js'),
  reactDom: join(harnessDirectory, 'react-dom.production.min.js'),
} as const;

/** The addresses the harness page links, each a URL the page can load. */
export type BundleHarnessUrls = {
  tokensCss: string;
  bundleCss: string;
  react: string;
  reactDom: string;
  bundleJs: string;
};

/**
 * The harness page: the system stylesheets, then React and ReactDOM, then `bundle.js`, in the order
 * the brand book tells a canvas to load them, so the bundle runs where React already exists.
 */
export function bundleHarnessHtml(urls: BundleHarnessUrls): string {
  return [
    '<!doctype html><html data-theme="light"><head><meta charset="utf-8">',
    `<link rel="stylesheet" href="${urls.tokensCss}">`,
    `<link rel="stylesheet" href="${urls.bundleCss}">`,
    `<script src="${urls.react}"></script>`,
    `<script src="${urls.reactDom}"></script>`,
    `<script src="${urls.bundleJs}"></script>`,
    '</head><body></body></html>',
  ].join('');
}

/** The component the harness mounts through React, and what it must render. */
export type BundleProbeRequest = {
  /** The export name on `window.Cinder`. */
  name: string;
  /** The props the React element passes. */
  props: Record<string, unknown>;
  /** The React children, which reach the component as its `children`. */
  label: string;
  /** The element whose text must read `label` once the component mounts. */
  selector: string;
};

/** Button, the component a canvas board mounts first, with text children. */
export const BUNDLE_PROBE: BundleProbeRequest = {
  name: 'Button',
  props: { variant: 'primary' },
  label: 'Process inbox',
  selector: 'button',
};

/** What {@link probeCinderBundle} found on the page. */
export type BundleProbe = {
  /** Whether `bundle.js` assigned `window.Cinder`. */
  cinder: boolean;
  /** Whether the page has `window.React` and `window.ReactDOM`. */
  react: boolean;
  /** How many components `window.Cinder` names. */
  components: number;
  /** The text of the probe's `selector` after the React render, or null when nothing matched. */
  rendered: string | null;
  /** What the React render threw, or null. */
  error: string | null;
};

/**
 * Mounts `request.name` from `window.Cinder` through React into a fresh element, the way a canvas
 * renders `<x-import component-from-global-scope="Cinder.Button">`, and reads what it rendered. It
 * runs inside the harness page, which Playwright reaches by serializing it, so it reads nothing but
 * globals and its argument.
 */
export function probeCinderBundle(request: BundleProbeRequest): BundleProbe {
  type ReactLike = {
    createElement(
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): unknown;
  };
  type RootLike = { render(element: unknown): void; unmount(): void };
  type ReactDomLike = {
    createRoot(container: Element): RootLike;
    flushSync(work: () => void): void;
  };
  const scope = globalThis as unknown as {
    Cinder?: Record<string, unknown> & { componentNames?: readonly string[] };
    React?: ReactLike;
    ReactDOM?: ReactDomLike;
  };
  const cinder = scope.Cinder;
  const react = scope.React;
  const reactDom = scope.ReactDOM;
  const probe: BundleProbe = {
    cinder: cinder !== undefined,
    react: react !== undefined && reactDom !== undefined,
    components: cinder?.componentNames?.length ?? 0,
    rendered: null,
    error: null,
  };
  const component = cinder?.[request.name];
  if (react === undefined || reactDom === undefined || typeof component !== 'function')
    return probe;
  const host = document.createElement('div');
  document.body.append(host);
  const root = reactDom.createRoot(host);
  try {
    reactDom.flushSync(() =>
      root.render(react.createElement(component, request.props, request.label)),
    );
    probe.rendered = host.querySelector(request.selector)?.textContent?.trim() ?? null;
  } catch (error) {
    probe.error = String(error).slice(0, 160);
  } finally {
    root.unmount();
    host.remove();
  }
  return probe;
}

/**
 * One line per way the bundle failed its canvas: an error the page logged or threw while loading,
 * no React, no `window.Cinder`, no components, or a probe component that did not render its
 * children through React.
 */
export function bundleProblems(
  loadErrors: readonly string[],
  probe: BundleProbe,
  request: BundleProbeRequest = BUNDLE_PROBE,
): string[] {
  const problems: string[] = [];
  if (loadErrors.length > 0) problems.push(`the page logged ${JSON.stringify(loadErrors)}`);
  if (!probe.react) problems.push('the harness has no window.React and window.ReactDOM');
  if (!probe.cinder) problems.push('bundle.js did not assign window.Cinder');
  else if (probe.components === 0) problems.push('window.Cinder names no components');
  if (probe.error !== null) {
    problems.push(`Cinder.${request.name} threw under React: ${probe.error}`);
  } else if (probe.cinder && probe.react && probe.rendered !== request.label) {
    problems.push(
      `Cinder.${request.name} rendered ${JSON.stringify(probe.rendered)} through React, not ${JSON.stringify(request.label)}`,
    );
  }
  return problems;
}
