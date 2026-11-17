import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

import { Button } from '../../src/components/button/index.ts';
import {
  BUNDLE_PROBE,
  bundleHarnessHtml,
  bundleProblems,
  probeCinderBundle,
  REACT_HARNESS_SCRIPTS,
} from './bundle-harness.ts';
import { createCinderGlobal } from './bundle-runtime.svelte.ts';

type HarnessGlobals = { React?: unknown; ReactDOM?: unknown; Cinder?: unknown };
const scope = globalThis as unknown as HarnessGlobals;

/** Runs a script as a page's classic `<script>` would: in the global scope. */
function runClassicScript(source: string, filename: string): void {
  // The UMD builds find no module system in the global scope, so they assign their globals.
  runInThisContext(source, { filename });
}

function runClassicFile(path: string): void {
  runClassicScript(readFileSync(path, 'utf8'), path);
}

beforeAll(() => {
  // The harness's React, from the published UMD builds it loads: React is no dependency of this
  // repository, so nothing here imports it.
  runClassicFile(REACT_HARNESS_SCRIPTS.react);
  runClassicFile(REACT_HARNESS_SCRIPTS.reactDom);
});

afterEach(() => {
  delete scope.Cinder;
  document.body.replaceChildren();
});

afterAll(() => {
  delete scope.React;
  delete scope.ReactDOM;
});

describe('bundleHarnessHtml', () => {
  test('links the stylesheets, then loads React, ReactDOM and bundle.js in that order', () => {
    const html = bundleHarnessHtml({
      tokensCss: 'tokens.css',
      bundleCss: 'bundle.css',
      react: 'react.js',
      reactDom: 'react-dom.js',
      bundleJs: 'bundle.js',
    });
    const order = [
      '<link rel="stylesheet" href="tokens.css">',
      '<link rel="stylesheet" href="bundle.css">',
      '<script src="react.js"></script>',
      '<script src="react-dom.js"></script>',
      '<script src="bundle.js"></script>',
    ].map((tag) => html.indexOf(tag));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].toSorted((left, right) => left - right));
  });
});

describe('the harness React', () => {
  test('is React 18 from the UMD builds the harness loads', () => {
    expect((scope.React as { version?: string }).version).toBe('18.3.1');
    expect(typeof (scope.ReactDOM as { createRoot?: unknown }).createRoot).toBe('function');
  });
});

describe('probeCinderBundle', () => {
  test("mounts Cinder.Button through reactComponent() with the harness's React", () => {
    scope.Cinder = createCinderGlobal({ Button });
    const probe = probeCinderBundle(BUNDLE_PROBE);
    expect(probe).toEqual({
      cinder: true,
      react: true,
      components: 1,
      rendered: 'Process inbox',
      error: null,
    });
    expect(bundleProblems([], probe)).toEqual([]);
    // The probe unmounts what it rendered.
    expect(document.body.childElementCount).toBe(0);
  });

  test('fails a bundle that threw while loading and so never assigned window.Cinder', () => {
    let loadError = '';
    try {
      runClassicScript('throw new TypeError("x is not a function")', 'bundle.js');
    } catch (error) {
      loadError = String(error);
    }
    const probe = probeCinderBundle(BUNDLE_PROBE);
    expect(probe.cinder).toBe(false);
    expect(probe.rendered).toBeNull();
    expect(bundleProblems([loadError], probe)).toEqual([
      `the page logged ${JSON.stringify([loadError])}`,
      'bundle.js did not assign window.Cinder',
    ]);
  });

  test('fails a Cinder.Button whose React render draws no button text', () => {
    scope.Cinder = createCinderGlobal({ Button });
    const probe = probeCinderBundle({ ...BUNDLE_PROBE, selector: 'a' });
    expect(probe.rendered).toBeNull();
    expect(bundleProblems([], probe)).toEqual([
      'Cinder.Button rendered null through React, not "Process inbox"',
    ]);
  });
});
