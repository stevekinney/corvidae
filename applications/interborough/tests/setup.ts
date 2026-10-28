/**
 * `bun test` preload (plan §11.2, T0.1). Registers happy-dom DOM globals and
 * the Svelte 5 compile plugin BEFORE any test file's imports resolve, then a
 * single global `afterEach(cleanup)` for `@testing-library/svelte`.
 *
 * Ported from `cinder/components/cinder/scripts/preload.ts` +
 * `src/test/happy-dom.ts` + `src/test/register-global-cleanup.ts` — the
 * proven working incantation for Bun + happy-dom + Svelte 5 component
 * tests, copied rather than re-derived. See the inline comments below for
 * why each piece exists; they carry over unchanged from that source.
 *
 * One divergence from that source worth knowing about: this Bun version's
 * `bun:test` runner ships its own native `document`/DOM globals ahead of
 * this preload running, so `document` already exists before `setupHappyDom`
 * below runs (its "skip if already present" copy loop leaves Bun's native
 * `document` in place rather than layering happy-dom's). That's fine for
 * `@testing-library/svelte`'s `render`/`fireEvent`/`cleanup`, but
 * `@testing-library/dom`'s `screen` singleton decides ONCE, at its own
 * module-evaluation time, whether a global `document.body` is ready — under
 * this runner that can land before Bun's native `document.body` is
 * populated, permanently baking in a throwing stub. See the comment in
 * `tests/component-harness.test.ts` for the workaround (prefer `render()`'s
 * own bound query methods over `screen`).
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { plugin } from 'bun';
import { afterAll, afterEach, beforeEach, expect } from 'bun:test';
import { Window } from 'happy-dom';

import { configureAsyncUtilityDeadline, sveltePlugin } from '@lostgradient/testing';

declare module 'bun:test' {
  interface Matchers<T = unknown> extends TestingLibraryMatchers<
    ReturnType<typeof expect.stringContaining>,
    T
  > {}
}

// Register the same matchers that the declaration above exposes to TypeScript.
expect.extend(jestDomMatchers);

type Global = typeof globalThis & Record<string, unknown>;

/**
 * Svelte's transitions dispatch `new CustomEvent('introstart')` on the element they animate, and
 * happy-dom refuses an event that is not an instance of its own `Event`. Bun already defines
 * `CustomEvent`, so the copy loop below would leave Bun's in place and every transition (Cinder's
 * `Collapsible` slide, for one) would throw `parameter 1 is not of type 'Event'`. Only that one is
 * taken from happy-dom: `@lostgradient/testing`'s helper replaces many more, `Event`, `URL`, `Blob`
 * and `AbortSignal` among them, and the suites here that reach a real server through Bun's own
 * `fetch` and `EventSource` fail when they are swapped.
 */
const DOM_REALM_EVENT_GLOBALS = new Set(['CustomEvent']);

let happyDomInstalled = false;

/**
 * happy-dom's Web Animations API is partial. Svelte 5's JS-driven
 * transitions (`slide`, `fade`, `fly`, …) call `Element.prototype.animate`
 * to coordinate enter/exit; without a stub, mounting any component that
 * uses `transition:fn` throws `element.animate is not a function`. This
 * stub settles on the next microtask — duration/easing are irrelevant in a
 * non-painting DOM. Module-scoped (not nested inside `stubWebAnimationsApi`)
 * since it captures nothing from an enclosing call.
 */
function stubbedAnimate(): unknown {
  let settled = false;
  const animation: Record<string, unknown> = {
    currentTime: 0,
    playState: 'finished',
    effect: null,
    onfinish: null,
    cancel() {
      settled = true;
    },
    finish() {
      fire();
    },
  };
  function fire(): void {
    if (settled) return;
    settled = true;
    const handler = animation['onfinish'];
    if (typeof handler === 'function') {
      handler.call(animation);
    }
  }
  queueMicrotask(fire);
  return animation;
}

function stubWebAnimationsApi(happyWindow: Window): void {
  const elementCtor = Reflect.get(happyWindow, 'Element');
  if (typeof elementCtor !== 'function') return;
  const proto = Reflect.get(elementCtor, 'prototype');
  if (typeof proto !== 'object' || proto === null) return;
  // Replace happy-dom's own partial `animate` too, as `@lostgradient/testing`'s helper does. Its
  // `Animation.cancel()` rejects `finished` with an `AbortError`, which Cinder's `Collapsible`
  // slide transition then raises as an unhandled rejection when a test cleans up mid-flight; the
  // stub settles synchronously and never rejects. Skipping the stub where `animate` already
  // existed is why the workflow pages once had to turn the animation off.
  Reflect.set(proto, 'animate', stubbedAnimate);
}

function setupHappyDom(): void {
  if (happyDomInstalled) return;
  const happyWindow = new Window();
  const target = globalThis as Global;

  for (const key of Object.getOwnPropertyNames(happyWindow)) {
    if (key in target && !DOM_REALM_EVENT_GLOBALS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(happyWindow, key);
    if (!descriptor) continue;
    Object.defineProperty(target, key, descriptor);
  }
  Object.defineProperty(target, 'window', { value: happyWindow, configurable: true });

  stubWebAnimationsApi(happyWindow);

  happyDomInstalled = true;
}

// Install DOM globals BEFORE any test file's static imports resolve — some
// dependencies read `document` at module-init under the `browser` export
// condition, and pre-installing happy-dom here lets every test file use a
// static `import { render } from '@testing-library/svelte'` instead of a
// top-level `await import(...)` (Bun's test runner can deadlock when many
// files race to dynamically import the same module at module-init).
setupHappyDom();

// KaTeX, which Cinder loads, warns "doesn't work in quirks mode" the first time
// it loads in a document without a doctype, and a test document has none.
// Report standards mode so the warning (a console defect) never fires.
Object.defineProperty(globalThis.document, 'compatMode', {
  value: 'CSS1Compat',
  configurable: true,
});

await plugin(sveltePlugin());

let cleanupRegistered = false;

async function registerGlobalCleanup(): Promise<void> {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const { cleanup } = await import('@testing-library/svelte');
  afterEach(cleanup);
}

await registerGlobalCleanup();

// Testing Library's asynchronous utilities wait up to the hang guard, not one second.
await configureAsyncUtilityDeadline();

// The router is a module-scope singleton over `window.location`, so a test that navigates (the
// route tests' `landAt('/runs/run-1')`) would leave that address for every later test file in the
// same process, because the coverage run shares one. A view that reads the route, such as
// `WorkflowsView`, then renders the page for that address instead of the one under test
// (COR-1676). Return to the root and tell the router, which resyncs on `popstate`, after each test.
afterEach(() => {
  if (!(window instanceof Window)) return;
  window.happyDOM.setURL('http://localhost/');
  window.dispatchEvent(new window.PopStateEvent('popstate'));
});

// `globalThis.fetch` is process-wide, and the coverage run shares one process across every test
// file, so a test that scripts it and does not put it back changes what every later test reaches:
// the suites that talk to a real server through Bun's own `fetch` then hit the leftover script
// instead (COR-1690, found by COR-1658's worker). Record `fetch` before each test and fail the
// test that leaves it different, then put the recorded value back so one leak fails one test
// rather than every test after it. Bun runs a preload's `afterEach` after a file's own, so a
// test's own restore has had its chance by the time this one compares.
//
// Bun runs a preload's `beforeAll` and `afterAll` once per run, not once per file, so a leak from a
// file's own `beforeAll`, `afterAll` or module scope is not attributable to a file here, and the
// per-test baseline adopts it. The run-level check below catches such a leak that is still in
// place when the run ends.
const originalFetch = globalThis.fetch;
let fetchBeforeTest: typeof globalThis.fetch | undefined;

beforeEach(() => {
  fetchBeforeTest = globalThis.fetch;
});

afterEach(() => {
  if (fetchBeforeTest === undefined || globalThis.fetch === fetchBeforeTest) return;
  globalThis.fetch = fetchBeforeTest;
  throw new Error(
    "This test left globalThis.fetch replaced. Restore the original in afterEach (or use a scoped helper) so later tests do not run against this test's stub. The original has been put back.",
  );
});

afterAll(() => {
  if (globalThis.fetch === originalFetch) return;
  globalThis.fetch = originalFetch;
  throw new Error(
    "A test file earlier in this run left globalThis.fetch changed. Restore it in that file's afterAll (or use a scoped helper). The original has been put back.",
  );
});
