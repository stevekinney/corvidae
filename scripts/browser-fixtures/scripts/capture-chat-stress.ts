#!/usr/bin/env bun
/**
 * Captures the Chat stress fixture (COR-2289): every case of `chat-stress.json` at the board's four
 * profiles, each from a fresh page load, through the real controls its steps press.
 *
 *   bun scripts/browser-fixtures/scripts/capture-chat-stress.ts [--out <directory>] [--cases 9,10,14-15]
 *     [--profiles 1440-light,320-dark]
 *
 * `CHAT_STRESS_SUPPLEMENTAL=1` adds the 390 dark phone profile. Before the first case it builds the
 * fixture host into the run's own directory, records the source identity (commit, uncommitted
 * changes, built page, Bun version) in `source-identity.json`, serves that build on a port the
 * system chooses, and waits for the host to answer. Each run writes into a fresh directory under
 * `--out` (default `<repository>/tmp/chat-stress`), so no run overwrites another and a server another
 * checkout left running is never read.
 *
 * The run writes `manifest.jsonl` (one line per image), `summary.json` and `gallery.html`. Every page
 * is measured for errors, document overflow, short touch targets below 500 px, clipped status text,
 * Arabic direction and the composer edge of the paired cases, and one deadline, the awake-time hang
 * guard, bounds every wait: the tool never sleeps. A failure names the case, the profile and the
 * measurement, and the gallery says Failed at the top; a failed run is never a passing witness.
 * Exit 0 when every image was taken and every measurement passed, 1 otherwise, 2 for bad usage.
 *
 * Playwright is used as a library from this process, so the run has no child test runner. The
 * design review that follows reads `gallery.html` and `manifest.jsonl`; it is not part of this tool.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { THEME_STORAGE_KEY, buildBrowser } from '@lostgradient/testing';
import { HANG_GUARD_MILLISECONDS } from '@lostgradient/testing/hang-guard';

import casesData from '../src/fixtures/chat-stress.json';
import {
  STRESS_NOW,
  caseLabel,
  parseStressCases,
  type StressCase,
  type StressStep,
} from '../src/fixtures/chat-stress/stress-cases.ts';
import { createFixtureServer } from '../src/server.ts';
import {
  RUN_DIRECTORY_PREFIX,
  composerEdgeProblems,
  countProblems,
  focusVariantName,
  galleryImageFiles,
  measurementProblems,
  primaryImageName,
  profilesFor,
  reconciliationProblems,
  renderGallery,
  selectCases,
  sourceIdentity,
  variantImageName,
  type CaptureRecord,
  type PageMeasurement,
  type RunSummary,
  type SourceIdentity,
  type StressProfile,
} from './chat-stress-plan.ts';
import { prepareManifest } from './prepare-manifest.ts';

/** The one deadline every wait of the run shares. */
const DEADLINE = HANG_GUARD_MILLISECONDS;

const fixtureRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(fixtureRoot, '..', '..');

type Role = Parameters<Page['getByRole']>[0];

type Hooks = Record<string, (...argumentsList: unknown[]) => void>;

/** What the page measures about itself; the plan turns it into problems. */
type InPageMeasurement = Omit<PageMeasurement, 'pageErrors' | 'withdrawal'>;

/** Runs in the page: the geometry the plan checks. */
function measureInPage(options: { coarse: boolean; rtl: boolean }): InPageMeasurement {
  const shell = document.querySelector('[data-testid="chat-stress-shell"]') ?? document.body;
  const isVisible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 1 && box.height > 1 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const nameOf = (element: Element): string =>
    (element.getAttribute('aria-label') ?? element.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);

  const smallTargets: { name: string; width: number; height: number }[] = [];
  if (options.coarse) {
    const controls = shell.querySelectorAll(
      'button, [role="button"], [role="radio"], [role="checkbox"], a[href], textarea, select, summary',
    );
    for (const element of controls) {
      if (!isVisible(element) || element.getAttribute('aria-hidden') === 'true') continue;
      if ((element as HTMLButtonElement).disabled) continue;
      // A link inside a sentence is sized by its text, not by the touch target rule.
      if (element.matches('a') && element.closest('p, li, td') !== null) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 44 || box.height < 44) {
        smallTargets.push({
          name: nameOf(element),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }
  }

  const clippedStatuses: string[] = [];
  for (const element of shell.querySelectorAll(
    '[role="status"], [data-status], [class*="status"]',
  )) {
    if (!isVisible(element)) continue;
    const style = getComputedStyle(element);
    const clips = style.overflow !== 'visible' && style.textOverflow !== 'ellipsis';
    const overflows =
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1;
    if (clips && overflows) clippedStatuses.push(nameOf(element));
  }

  const directions: { text: string; direction: string; textAlign: string }[] = [];
  if (options.rtl) {
    for (const element of shell.querySelectorAll('*')) {
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      if (!/[؀-ۿ]/.test(ownText) || !isVisible(element)) continue;
      directions.push({
        text: ownText.slice(0, 40),
        direction: element.matches(':dir(rtl)') ? 'rtl' : 'ltr',
        textAlign: getComputedStyle(element).textAlign,
      });
    }
  }

  const composer =
    shell.querySelector('.chat-input-area > .chat-input-shell') ??
    shell.querySelector('.chat-input-area');
  return {
    documentWidth: {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    },
    smallTargets,
    clippedStatuses,
    directions,
    composerEdge:
      composer === null ? null : Math.round(composer.getBoundingClientRect().bottom * 100) / 100,
  };
}

/** Runs in the page: starts counting what the live regions announce from now on. */
function observeAnnouncements(): void {
  const host = window as Window & { stressAnnouncements?: string[] };
  const announced: string[] = [];
  host.stressAnnouncements = announced;
  new MutationObserver(() => {
    for (const region of document.querySelectorAll(
      '[aria-live], [role="status"], [role="alert"]',
    )) {
      const text = (region.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '' && announced.at(-1) !== text) announced.push(text);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}

/** Runs in the page: how many announcements followed and whether the focused control shows its ring. */
function readWithdrawal(): { announcements: number; focusVisible: boolean } {
  const host = window as Window & { stressAnnouncements?: string[] };
  const active = document.activeElement;
  const shell = document.querySelector('[data-testid="chat-stress-shell"]');
  const focusVisible =
    active !== null &&
    shell?.contains(active) === true &&
    active.matches(':focus-visible') &&
    active.getBoundingClientRect().width > 0;
  return { announcements: host.stressAnnouncements?.length ?? 0, focusVisible };
}

/** Runs in the page: scrolls the transcript, the first scrolling box inside the shell, to an end. */
function scrollTranscript(to: 'top' | 'bottom'): void {
  const shell = document.querySelector('[data-testid="chat-stress-shell"]') ?? document.body;
  for (const element of shell.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (scrolls && element.scrollHeight > element.clientHeight + 1) {
      element.scrollTop = to === 'top' ? 0 : element.scrollHeight;
      return;
    }
  }
}

/** Runs in the page: marks the focused control and says whether it is a new stop inside the shell. */
function readFocusStop(): { inside: boolean; fresh: boolean; name: string } {
  const active = document.activeElement;
  const shell = document.querySelector('[data-testid="chat-stress-shell"]');
  if (active === null || shell === null || !shell.contains(active) || active === shell) {
    return { inside: false, fresh: false, name: '' };
  }
  const fresh = !active.hasAttribute('data-stress-focus-stop');
  active.setAttribute('data-stress-focus-stop', '');
  const name = (
    active.getAttribute('aria-label') ??
    active.textContent ??
    active.getAttribute('placeholder') ??
    active.getAttribute('title') ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return { inside: true, fresh, name: name === '' ? active.tagName.toLowerCase() : name };
}

function callHook(page: Page, name: string, argument: unknown): Promise<void> {
  const argumentsList = Array.isArray(argument)
    ? argument
    : argument === undefined
      ? []
      : [argument];
  return page.evaluate(
    ([hookName, hookArguments]) => {
      const hooks = (window as Window & { corvidaeChatStress?: Hooks }).corvidaeChatStress;
      const hook = hooks?.[hookName as string];
      if (hook === undefined)
        throw new Error(`The page has no host operation named ${String(hookName)}.`);
      hook(...(hookArguments as unknown[]));
    },
    [name, argumentsList] as const,
  );
}

function locate(page: Page, step: Extract<StressStep, { role: string }>) {
  return page.getByRole(step.role as Role, { name: step.name }).nth(step.nth ?? 0);
}

async function runStep(page: Page, step: StressStep): Promise<void> {
  switch (step.action) {
    case 'click':
      await locate(page, step).click({ timeout: DEADLINE });
      return;
    case 'fill':
      await locate(page, step).fill(step.text, { timeout: DEADLINE });
      return;
    case 'focus':
      await locate(page, step).focus({ timeout: DEADLINE });
      return;
    case 'press':
      await page.keyboard.press(step.key);
      return;
    case 'hook':
      await callHook(page, step.name, step.argument);
      return;
    case 'expect':
      await locate(page, step).waitFor({ state: 'visible', timeout: DEADLINE });
      return;
    case 'expect-text':
      await page.getByText(step.text).first().waitFor({ state: 'visible', timeout: DEADLINE });
      return;
    case 'upload':
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles(
          step.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            buffer: Buffer.alloc(file.bytes),
          })),
          { timeout: DEADLINE },
        );
      return;
    case 'scroll':
      await page.evaluate(scrollTranscript, step.to);
      return;
    default: {
      const unreachable: never = step;
      throw new Error(`Unknown step ${JSON.stringify(unreachable)}.`);
    }
  }
}

/** One page of a case at a profile, with the errors it collected. */
interface OpenCase {
  readonly page: Page;
  readonly errors: string[];
}

async function openCase(
  context: BrowserContext,
  origin: string,
  stressCase: StressCase,
): Promise<OpenCase> {
  const page = await context.newPage();
  page.setDefaultTimeout(DEADLINE);
  page.setDefaultNavigationTimeout(DEADLINE);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The broken-image cases load an address the server does not have on purpose.
    if (stressCase.scenario === 'images' && message.text().includes('Failed to load resource'))
      return;
    errors.push(message.text());
  });
  await page.goto(`${origin}/page/chat-stress?case=${stressCase.id}`, { waitUntil: 'load' });
  await page
    .locator('[data-chat-stress-ready="true"], [data-chat-stress-error]')
    .first()
    .waitFor({ state: 'attached', timeout: DEADLINE });
  const failure = page.locator('[data-chat-stress-error]');
  if ((await failure.count()) > 0) throw new Error(await failure.first().innerText());
  return { page, errors };
}

async function runSteps(opened: OpenCase, stressCase: StressCase, steps: readonly StressStep[]) {
  for (const step of steps) {
    // Count announcements from the moment the host withdraws the source, not before.
    if (stressCase.id === 45 && step.action === 'hook' && step.name === 'withdrawSource') {
      await opened.page.evaluate(observeAnnouncements);
    }
    await runStep(opened.page, step);
  }
}

async function measure(
  opened: OpenCase,
  stressCase: StressCase,
  profile: StressProfile,
): Promise<{ measurement: PageMeasurement; problems: string[] }> {
  const inPage = await opened.page.evaluate(measureInPage, {
    coarse: profile.coarse,
    rtl: stressCase.direction === 'rtl',
  });
  const withdrawal = stressCase.id === 45 ? await opened.page.evaluate(readWithdrawal) : undefined;
  const measurement: PageMeasurement = {
    ...inPage,
    pageErrors: opened.errors,
    ...(withdrawal === undefined ? {} : { withdrawal }),
  };
  return { measurement, problems: measurementProblems(measurement, profile, stressCase) };
}

interface RunState {
  readonly directory: string;
  readonly origin: string;
  readonly records: CaptureRecord[];
  readonly errors: string[];
}

/** Takes one image of a case: a fresh page, the steps, the picture and its measurement. */
async function captureImage(
  state: RunState,
  context: BrowserContext,
  profile: StressProfile,
  stressCase: StressCase,
  image: { kind: 'primary' | 'variant'; variant?: string; steps: readonly StressStep[] },
): Promise<number | null> {
  const file =
    image.kind === 'primary'
      ? primaryImageName(profile, stressCase.id)
      : variantImageName(profile, stressCase.id, image.variant ?? '');
  const label = `case ${caseLabel(stressCase.id)} at ${profile.name}${image.variant === undefined ? '' : ` ${image.variant}`}`;
  let problems: string[] = [];
  let edge: number | null = null;
  let opened: OpenCase | undefined;
  try {
    opened = await openCase(context, state.origin, stressCase);
    await runSteps(opened, stressCase, image.steps);
    const measured = await measure(opened, stressCase, profile);
    problems = measured.problems;
    edge = measured.measurement.composerEdge;
  } catch (error) {
    problems = [`flow failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  let written = false;
  if (opened !== undefined) {
    try {
      await opened.page.screenshot({
        path: join(state.directory, file),
        animations: 'disabled',
        caret: 'hide',
        timeout: DEADLINE,
      });
      written = true;
    } catch (error) {
      problems = [
        ...problems,
        `screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    await opened.page.close();
  }
  for (const problem of problems) state.errors.push(`${label}: ${problem}`);
  if (written) {
    state.records.push({
      caseId: stressCase.id,
      profile: profile.name,
      kind: image.kind,
      ...(image.variant === undefined ? {} : { variant: image.variant }),
      file,
      problems,
      ...(stressCase.deferred === undefined ? {} : { deferred: stressCase.deferred }),
    });
  }
  return edge;
}

/** Tabs through the case's controls and takes one image per stop, which is the per-control focus sweep. */
async function captureFocusSweep(
  state: RunState,
  context: BrowserContext,
  profile: StressProfile,
  stressCase: StressCase,
): Promise<void> {
  let opened: OpenCase | undefined;
  try {
    opened = await openCase(context, state.origin, stressCase);
    await runSteps(opened, stressCase, stressCase.steps);
    await opened.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let index = 1; ; index += 1) {
      await opened.page.keyboard.press('Tab');
      const stop = await opened.page.evaluate(readFocusStop);
      if (!stop.inside || !stop.fresh) break;
      const variant = focusVariantName(index);
      const file = variantImageName(profile, stressCase.id, variant);
      await opened.page.screenshot({
        path: join(state.directory, file),
        animations: 'disabled',
        caret: 'hide',
        timeout: DEADLINE,
      });
      state.records.push({
        caseId: stressCase.id,
        profile: profile.name,
        kind: 'focus',
        variant,
        file,
        focus: { index, name: stop.name },
        problems: [],
      });
    }
  } catch (error) {
    state.errors.push(
      `case ${caseLabel(stressCase.id)} at ${profile.name} focus sweep: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await opened?.page.close();
  }
}

async function captureProfile(
  state: RunState,
  browser: Browser,
  profile: StressProfile,
  cases: readonly StressCase[],
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: 1,
    colorScheme: profile.theme,
    reducedMotion: 'reduce',
    hasTouch: profile.coarse,
    isMobile: profile.coarse,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    baseURL: state.origin,
  });
  try {
    await context.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key as string, value as string);
        } catch {
          // A blocked storage leaves the default theme, which the profile's color scheme matches.
        }
      },
      [THEME_STORAGE_KEY, profile.theme] as const,
    );
    // Fix the clock so a date separator reads Today; timers keep running, so nothing waits on it.
    await context.clock.setFixedTime(new Date(STRESS_NOW));
    const edges = new Map<number, number | null>();
    for (const stressCase of cases) {
      edges.set(
        stressCase.id,
        await captureImage(state, context, profile, stressCase, {
          kind: 'primary',
          steps: stressCase.steps,
        }),
      );
      for (const variant of stressCase.variants) {
        await captureImage(state, context, profile, stressCase, {
          kind: 'variant',
          variant: variant.name,
          steps: variant.steps,
        });
      }
      if (stressCase.focusSweep) await captureFocusSweep(state, context, profile, stressCase);
    }
    state.errors.push(...composerEdgeProblems(cases, profile, edges));
  } finally {
    await context.close();
  }
}

function git(arguments_: string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.toString();
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readIdentity(buildDirectory: string): Promise<SourceIdentity> {
  const files = (await readdir(buildDirectory, { recursive: true })).map(String).toSorted();
  const index = await Bun.file(join(buildDirectory, 'index.html')).text();
  return sourceIdentity({
    head: git(['rev-parse', 'HEAD']).trim(),
    changesDigest: digest(`${git(['status', '--porcelain'])}\0${git(['diff', 'HEAD'])}`),
    buildDigest: digest(`${files.join('\n')}\0${index}`),
    bunVersion: Bun.version,
  });
}

function usage(message: string): never {
  console.error(
    `${message}\nUsage: capture-chat-stress.ts [--out <directory>] [--cases 9,10,14-15] [--profiles 1440-light]`,
  );
  process.exit(2);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      out: { type: 'string' },
      cases: { type: 'string' },
      profiles: { type: 'string' },
    },
    strict: true,
  });
  const supplemental = process.env['CHAT_STRESS_SUPPLEMENTAL'] === '1';
  const allCases = parseStressCases(casesData);
  let cases: StressCase[];
  try {
    cases = selectCases(allCases, values.cases);
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  let profiles = profilesFor(supplemental);
  if (values.profiles !== undefined) {
    const names = values.profiles.split(',').map((name) => name.trim());
    const unknown = names.filter((name) => !profiles.some((profile) => profile.name === name));
    if (unknown.length > 0) return usage(`Unknown profiles: ${unknown.join(', ')}.`);
    profiles = profiles.filter((profile) => names.includes(profile.name));
  }

  const outputRoot = resolve(values.out ?? join(repositoryRoot, 'tmp', 'chat-stress'));
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, RUN_DIRECTORY_PREFIX));

  // Build the host into this run's own directory, so no other server's rebuild can change it.
  await prepareManifest();
  const buildDirectory = join(directory, 'build');
  await buildBrowser({
    entrypoints: [resolve(fixtureRoot, 'index.html')],
    outdir: buildDirectory,
    development: false,
  });
  const identity = await readIdentity(buildDirectory);
  await writeFile(
    join(directory, 'source-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );

  const server = createFixtureServer({
    port: 0,
    outputDirectory: buildDirectory,
    manifestPath: resolve(fixtureRoot, '.playwright', 'manifest.json'),
    development: false,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const state: RunState = { directory, origin, records: [], errors: [] };
  let browser: Browser | undefined;
  try {
    // Ready means the host answers and serves the Chat stress page from this build.
    const ready = await fetch(`${origin}/ready`);
    const manifest = (await (await fetch(`${origin}/api/manifest`)).json()) as {
      entries: { slug: string }[];
    };
    if (!ready.ok || !manifest.entries.some((entry) => entry.slug === 'chat-stress')) {
      throw new Error('The fixture host is not ready to serve the Chat stress fixture.');
    }
    browser = await chromium.launch();
    for (const profile of profiles) await captureProfile(state, browser, profile, cases);
  } catch (error) {
    state.errors.push(`run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close();
    await server.stop(true);
  }

  const records = state.records.toSorted(
    (left, right) =>
      left.caseId - right.caseId ||
      left.profile.localeCompare(right.profile) ||
      left.file.localeCompare(right.file),
  );
  const errors = [...state.errors, ...countProblems(records, cases, profiles)];
  const files = (await readdir(directory)).filter((name) => name.endsWith('.png'));
  const summary: RunSummary = {
    passed: false,
    complete: cases.length === allCases.length && profiles.length >= 4,
    runDirectory: directory,
    identity,
    cases: cases.length,
    profiles: profiles.map((profile) => profile.name),
    counts: {
      primary: records.filter((record) => record.kind === 'primary').length,
      fixedVariants: records.filter((record) => record.kind === 'variant').length,
      focus: records.filter((record) => record.kind === 'focus').length,
      total: records.length,
    },
    deferred: cases
      .filter((stressCase) => stressCase.deferred !== undefined)
      .map((stressCase) => ({ caseId: stressCase.id, reason: stressCase.deferred ?? '' })),
    errors,
  };
  // The gallery is written first so the reconciliation can read back what it shows.
  const provisional = { ...summary, passed: errors.length === 0 };
  const gallery = renderGallery(records, cases, provisional);
  await writeFile(join(directory, 'gallery.html'), gallery);
  const reconciliation = reconciliationProblems(records, files, galleryImageFiles(gallery));
  const allErrors = [...errors, ...reconciliation];
  const finalSummary: RunSummary = {
    ...summary,
    passed: allErrors.length === 0,
    errors: allErrors,
  };
  await writeFile(join(directory, 'gallery.html'), renderGallery(records, cases, finalSummary));
  await writeFile(
    join(directory, 'manifest.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(finalSummary, null, 2)}\n`);

  console.log(
    `${finalSummary.passed ? 'passed' : 'FAILED'}: ${finalSummary.counts.total} images (${finalSummary.counts.primary} primary, ${finalSummary.counts.fixedVariants} variants, ${finalSummary.counts.focus} focus) in ${directory}`,
  );
  for (const error of allErrors) console.error(error);
  return finalSummary.passed ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
