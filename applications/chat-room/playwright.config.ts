import { defineConfig } from '@playwright/test';
import { ports } from './scripts/browser-ports.ts';

// ROADMAP HS-3: run the focus, accessibility, and streaming contracts in all
// three engines. Chromium still owns the complete suite; WebKit and Firefox run
// the subset whose browser behavior can diverge. Every glob ends in `.e2e.ts`
// because a project's `testMatch` replaces, rather than intersects with, the
// root matcher.
//
// Playwright forces color in its workers and web servers. Remove the conflicting
// inherited opt-out in this test process before those children are created.
delete process.env['NO_COLOR'];

const CROSS_ENGINE = [
  '**/chat-token-registration.e2e.ts',
  '**/api/chat/approval-flow.e2e.ts',
  '**/api/chat/error-handling.e2e.ts',
  '**/server-owned-streaming{,.part-*}.e2e.ts',
  '**/server-owned-synchronization{,.part-*}.e2e.ts',
  '**/server-owned-approval-flow.e2e.ts',
  '**/page.svelte{,.part-*}.e2e.ts',
  '**/server-owned-approval-focus{,.part-*}.e2e.ts',
  '**/shiki-grammar-assets.e2e.ts',
] as const;

export default defineConfig({
  // The complete suite starts three application processes and runs Chromium,
  // WebKit, and Firefox. Concurrent browser workers intermittently starve those
  // shared processes on this machine; one keeps the interaction suite deterministic
  // contention. This is capacity control, not a timeout or retry workaround.
  workers: 1,
  // With a SINGLE webServer Playwright infers `baseURL` from its port; with an
  // array it does not, and every relative `page.goto('/…')` in the suite would
  // fail. Set it explicitly to the production preview, which is what all but
  // `hydration.e2e.ts` exercise.
  //
  // Still true after adding `projects`: an array `webServer` sets the internal
  // `config.webServer` to null, which is what suppresses the inference, and
  // projects do not touch it. The root `use` merges into every project, so
  // `baseURL` reaches WebKit and Firefox without being restated.
  use: {
    baseURL: `http://localhost:${ports.CHAT_ROOM_PREVIEW_PORT}`,
    // ROADMAP HS-4: leave a trail when something fails, so a flaky-looking
    // failure can be diagnosed instead of guessed at — the pressure that
    // produces "just bump the timeout", which this repo rules out.
    //
    // `retain-on-failure`, NOT the commonly-scaffolded `on-first-retry`:
    // `retries` is 0 here, so anything keyed to a retry never fires and would
    // be pure ceremony.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // `retries` stays at 0 deliberately in CI as well as locally. A retry that
  // turns a real intermittent failure green is the same mistake as a bumped
  // timeout, which `CLAUDE.md` treats as blocking. `retain-on-failure` produces
  // the artifact trail needed to diagnose the first failure without masking it.
  projects: [
    // LOAD-BEARING, and the least obvious line in this file. Declaring any
    // `projects` array REPLACES Playwright's implicit root project. Without this
    // entry the suite would silently stop running in Chromium altogether and
    // shrink to whatever `CROSS_ENGINE` matches — green, faster, and covering
    // far less. It carries no `testMatch` so it inherits the root one and keeps
    // running all of it.
    //
    // Plain `browserName` rather than `devices['Desktop Chrome']`: `devices`
    // also pins viewport, user agent, and device scale factor, which would
    // change this project's behavior relative to today's implicit one. Keeping
    // it byte-for-byte identical means the only thing this change introduces is
    // the two new engines.
    { name: 'chromium', use: { browserName: 'chromium' } },
    // The exercise removal reduced this project to 52 collected tests, below
    // the observed 64-context WebKit ceiling. One project is now sufficient;
    // reintroduce measured shards only if collection grows to that boundary.
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: [...CROSS_ENGINE] },
    { name: 'firefox', use: { browserName: 'firefox' }, testMatch: [...CROSS_ENGINE] },
  ],
  webServer: [
    // ROADMAP HS-1/HS-2. Stands in for the ANTHROPIC API, not for `/api/chat` —
    // so the real SvelteKit endpoint, the real Operative provider stream, the
    // real ndjson re-encode, the real `toolbox.execute` signature, and the real
    // browser `ReadableStream` read are all still under test.
    //
    // It is reachable because `/api/chat` forwards `env.ANTHROPIC_BASE_URL`
    // into `createAnthropicProviderStream({ baseURL })` explicitly. That used
    // to be implicit — the raw Anthropic SDK read `ANTHROPIC_BASE_URL` from the
    // environment at construction — but Operative's provider does not, so the
    // option is application code that has to stay. Removing it points every
    // spec below at the real Anthropic API, which fails the suite only after
    // making live billed calls.
    //
    // Playwright's `Route` cannot trickle a body — `fulfill` takes a complete
    // one and `route.fetch()` returns a buffered response — so no amount of
    // mocking `/api/chat` can deliver more than one chunk. That is why
    // progressive rendering was untestable here even in principle.
    //
    // A `webServer` entry rather than a per-spec server, because
    // `page.svelte.e2e.ts` runs in three projects across parallel workers: a
    // spec-owned server would be started once per worker and every copy after
    // the first would fail to bind. One process for the whole run, with all
    // per-test state keyed by a marker the test generates.
    //
    // `reuseExistingServer: false` on every entry, written down rather than left
    // to the default it already equals (CIN-509). Playwright's default for an
    // UNSET option is `false`, which makes a held port a startup error
    // (`http://localhost:<port> is already used …`) — the docs' `!process.env.CI`
    // is a value they recommend setting, not what unset evaluates to. That
    // matters here because this repository is worked in several git worktrees
    // at once: with reuse on, a second worktree starting the suite while the
    // first is running would adopt the first worktree's fixture and preview
    // and report passes about the wrong tree, with nothing printed. Reuse also
    // buys almost nothing: `bun run build` for this lab takes about six
    // seconds, so a single-checkout rerun pays that plus preview startup.
    // `scripts/playwright-collision-guard.test.ts` occupies a port with a
    // server from "another checkout" and asserts the run refuses it, so this
    // cannot drift to `!process.env.CI` unnoticed. `--strictPort` on the dev
    // server below is not what protects it — under reuse the command never
    // runs when the port is held — this setting is.
    {
      command: 'bun src/routes/streaming-fixture.ts',
      port: ports.CHAT_ROOM_FIXTURE_PORT,
      reuseExistingServer: false,
    },
    {
      command: `bun run build && bun run preview -- --port ${ports.CHAT_ROOM_PREVIEW_PORT} --strictPort`,
      port: ports.CHAT_ROOM_PREVIEW_PORT,
      reuseExistingServer: false,
      env: {
        CHAT_ROOM_BROWSER: '1',
        // The SDK requires a non-empty key before it will send the request to
        // the local fixture; this value is never sent to Anthropic.
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${ports.CHAT_ROOM_FIXTURE_PORT}`,
      },
    },
    // A dev server alongside the production preview, purely so hydration
    // mismatches are observable: Svelte strips `hydration_mismatch` from
    // production builds, so `hydration.e2e.ts` has to drive a dev build to see
    // them at all (cinder#756 hid here for exactly that reason).
    //
    // One pair of servers regardless of project count — the webServer plugins
    // are built once from the top-level config in global setup, not per project.
    {
      command: `bun run dev -- --port ${ports.CHAT_ROOM_DEV_PORT} --strictPort`,
      port: ports.CHAT_ROOM_DEV_PORT,
      env: { CHAT_ROOM_BROWSER: '1' },
      reuseExistingServer: false,
    },
  ],
  testMatch: '**/*.e2e.{ts,js}',
});
