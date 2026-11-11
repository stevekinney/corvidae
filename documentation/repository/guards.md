# Repository guards

The detail behind the guards AGENTS.md "Commands" names in one sentence each. The rules stay in AGENTS.md, in short; this file holds their full text where AGENTS.md shortens it, what each guard rejects, its markers, and its allowlists. The test-lane, documentation-coverage, and test-duration guards are described in [test lanes and checks](test-lanes-and-checks.md).

## Load-sensitive deadlines

Owner decision: tests that can flake under load cannot be in the critical path. Everything `bun run check` and `bun run validate` run has one deadline, the awake-time hang guard (`HANG_GUARD_MILLISECONDS`, 120 seconds), and it is never a performance bound. Bun's per-test timeout is twice that, passed by `scripts/bun-test.ts`, so a `package.json` script never starts `bun test` itself.

- Bun's per-test timeout is twice the hang guard, passed as `--timeout` by `scripts/bun-test.ts` and `scripts/bun-test-junit.ts` (`[test] timeout` in `bunfig.toml` is ignored, and `setDefaultTimeout` in a preload covers the first file only), so a `package.json` script never starts `bun test` itself.
- Every UI preload calls `configureAsyncUtilityDeadline` so Testing Library's `findBy*` and `waitFor` wait up to the hang guard.
- A wait for something that must happen uses `waitUntil` or `awakeTurns` from `@lostgradient/testing/wait-until` (root scripts import `testing/testing/src/wait-until.ts` by path, because the root package depends on no workspace; packages that cannot import the testing package keep a local poll), never a sleep, a count of turns, a wall-clock deadline or a race against a timer. A wait for something that must not happen uses `quietFor`, because load can only delay the event, never advance it.
- A test that deliberately exercises a short guard against work that cannot finish carries `// hang-guard-self-test: <reason>`, and a wait that load cannot flip for another reason (a pre-aborted signal, a double that never answers, timers of one clock that fire in order of their deadlines) carries `// load-proof: <reason>` that argues from determinism and never from expected speed. Each reason is at least twenty characters, and the comment sits directly above the statement.
- Manual runtime services and manual clocks inject their own timers and leave the global ones real, so a bare `Bun.sleep` beside them is still a real wait; only `useFakeTimers` patches the global `setTimeout`.
- A Bun child that a test starts goes through `spawnWithHangGuard` or `runWithHangGuard`, which put `--no-install` in front of it (`withoutAutoInstall`), because a module written to the system temp directory has no `node_modules` and Bun would install what it imports from the registry, so the result would depend on the network and on which release is current.

`scripts/check-load-sensitive-deadlines.ts` enforces all of this from `lint:root`. It rejects:

- a Bun or Testing Library timeout, a wait budget (including a window passed to any helper that races a timer on that parameter, such as `withTimeout(work, 500)`), or a defaulted budget below the hang guard;
- a bounded poll and a wall-clock poll;
- a sleep (`Bun.sleep`, `node:timers/promises`, `waitForRealTimersForTesting`) before an assertion;
- a timer race (`Promise.race` or `Promise.any` against any timer promise, or a promise a timer also resolves);
- a `quietFor` window before a positive assertion;
- a single-turn yield (`sleepForTesting` under real timers, which ignores its argument, `setImmediate`, `setTimeout(r, 0)`, `Bun.sleep(0)`, and a same-file helper that is one of them) that something follows, unless it waits on the state instead or carries `// load-proof:`;
- a timer that rejects;
- a `bun test` invocation without the shared deadline.

A product's own timeout option, such as `mailbox.awaitCleanup({ timeoutMs })`, is not read, and neither are event order and I/O races; the guard's header lists what it cannot see.

The Playwright specs (`*.playwright.ts`) and the opt-in `WEFT_BROWSER_SMOKE` suites are outside `check` and `validate`, and the rules above do not scan them. The root Playwright suite's `chromium` project and Interborough's end-to-end suite (`test:browser:interborough`, its one `chromium` project) are gated by the batch validate (`validate:batch`), and the root suite's Firefox and WebKit projects are gated nowhere; `test:browser-fixtures` runs Bun tests, which are scanned. The browser suites follow the hang guard all the same: Interborough's and `scripts/browser-fixtures`' `playwright.config.ts` set `expect.timeout` to `HANG_GUARD_MILLISECONDS` and `timeout` to `TEST_TIMEOUT_MILLISECONDS`, and the guard's `playwright-configuration` and `playwright-timeout` rules reject a configuration that does not and an Interborough spec that names a shorter one without a `// hang-guard-self-test:` or `// load-proof:` comment (the specs of `scripts/browser-fixtures/tests` still name their own, which COR-2001 left).

The history and the single-turn-yield details are in [test lanes and checks](test-lanes-and-checks.md) ("Load-proof deadlines").

## Inherited key reads

Every library and component runs `scripts/check-inherited-key-reads.ts` in its `lint`, which fails when `src` reads a plain record with a key the code does not control (`record[key]` or `key in record` on a `Record<string, T>`), because the record also answers for `constructor`, `toString` and `__proto__`. Test with `Object.hasOwn(record, key)` first, hold the entries in a `Map`, or build the record with `Object.create(null)`. A read that is safe for a reason the check cannot see goes in the workspace's `inherited-key-reads-allowlist.json` with its reason; the list can only shrink on its own, and adding an entry is a reviewed edit.

## Audit exceptions

`bun run audit` runs `bun audit --audit-level=high` through `scripts/check-audit-exceptions.ts`. An advisory may be tolerated only by an entry in `scripts/audit-exceptions.ts`, which needs an owner decision, a tracking issue, a review-by date, and the exact dependency chains that may reach the package; the guard fails on a stale, expired, or widened exception. Never add a bare `--ignore`.

## Middle-dot separators

`lint:root` runs `scripts/check-middle-dot-separators.ts`, which fails on a middle dot (U+00B7) anywhere in `components/cinder`, `applications/playground` and `applications/interborough` (owner standing order, 2026-11-10; COR-2335, COR-2336). The scan is textual: it reads every non-binary file under those roots, and it also reports the escaped spellings (`·`, `\u{b7}`, `\xb7`, CSS `\00b7`, `&middot;`, `&#183;`, `&#xb7;`), because they draw the same glyph. Write a comma, give each piece its own element, break the line, or use a description list for label and value metadata ([Cinder's README](../../components/cinder/README.md#content)). A test that asserts the glyph's absence builds it with `String.fromCodePoint(0xb7)`. A line with a real non-separator use carries a `middle-dot-allowed: <reason>` marker, on the line or the one above, with a reason of at least twenty characters; none does today.

## Hidden control labels

`lint:root` runs `scripts/check-hidden-labels.ts`, which fails on a new `labelVisible={false}` (or `labelVisible: false`) in `applications/interborough` (sweep W44, COR-2022). A field that hides its visible label leaves nothing on screen that says what it is once a value is typed, and Cinder's `Toggle` draws its own visible label, so a page never adds a hidden one beside it. Pages that hid a label before the guard are listed in `scripts/hidden-label-allowlist.json` with the file, how many sites it holds and a reason; the list only shrinks, so a file that holds more sites than its entry fails, and an entry that names more sites than remain is reported so it can be lowered or removed. A line with a real need carries a `hidden-label-allowed: <reason>` marker, on the line or the one above, with a reason of at least twenty characters.

## Process documentation

The process documents carry word budgets and checked references, so they cannot regrow or rot unnoticed. `scripts/process-docs-budget.test.ts` holds AGENTS.md, which every agent session pays for on every request, to 2,250 words and 16,000 characters, and the chef `SKILL.md` and each `.agents/skills/chef/references/*.md` to 3,000. `scripts/process-docs-references.test.ts` checks that every `scripts/...` path and `bun scripts/...` command named in AGENTS.md, `.agents/skills/**/*.md`, `.claude/agents/*.md`, and `documentation/repository/*.md` exists, that every relative Markdown link in them resolves, anchors included, and that every AGENTS.md section another document or script cites by name in quotes exists. Move mechanics, history, and rationale into a document under `documentation/repository/` and link it, rather than raising a budget.
