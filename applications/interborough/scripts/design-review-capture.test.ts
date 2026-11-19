/**
 * The design-review capture's command line (`scripts/design-review-capture.ts`): the defaults that
 * a sweep relies on, the narrowing a sign-off uses, and the refusals that keep a typo from
 * silently capturing the wrong thing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';
import {
  captureForDesignReview,
  designReviewSlug,
  designReviewWorld,
  nextFrame,
  withPointerCleanup,
} from '../tests/e2e/design-review-capture.ts';
import { E2E_FIRST_RUN_PORT, E2E_PORT, E2E_SHOWCASE_PORT } from '../tests/e2e/e2e-constants.ts';
import {
  captureCount,
  captureDesignReview,
  capturedRoutes,
  hostEnvironment,
  parseArguments,
  portIsFree,
  probeSocketHandlers,
  routesMissingFromTitles,
  SHOWCASE_SPECIFICATION_PATHS,
  specificationsThatRanNothing,
  type CaptureEnvironment,
} from './design-review-capture.ts';
import { endToEndPort } from './environment-configuration.ts';

const NOW = new Date('2026-11-02T08:30:00.000Z');

describe('parseArguments', () => {
  test('captures every specification in both schemes into a time-stamped directory by default', () => {
    const options = parseArguments([], NOW);
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['light', 'dark']);
    expect(options.specifications).toEqual([
      'tests/e2e/00-showcase.spec.ts',
      'tests/e2e/shell-chrome.spec.ts',
      'tests/e2e/shell-search.spec.ts',
      'tests/e2e/shell-states.spec.ts',
      'tests/e2e/schedules-list.spec.ts',
      'tests/e2e/schedules-states.spec.ts',
      'tests/e2e/schedules-new.spec.ts',
      'tests/e2e/schedules-edit.spec.ts',
      'tests/e2e/schedules-detail.spec.ts',
      'tests/e2e/health-overview.spec.ts',
      'tests/e2e/health-states.spec.ts',
      'tests/e2e/health-workers-states.spec.ts',
      'tests/e2e/health-storage.spec.ts',
      'tests/e2e/health-audit.spec.ts',
      'tests/e2e/health-audit-states.spec.ts',
      'tests/e2e/restart.spec.ts',
      'tests/e2e/settings-general.spec.ts',
      'tests/e2e/settings-allowed-models.spec.ts',
      'tests/e2e/settings-models.spec.ts',
      'tests/e2e/settings-a2a.spec.ts',
      'tests/e2e/settings-plugins.spec.ts',
      'tests/e2e/settings-data-and-retention.spec.ts',
      'tests/e2e/api-reference.spec.ts',
      'tests/e2e/first-run.spec.ts',
      'tests/e2e/home.spec.ts',
      'tests/e2e/home-activity.spec.ts',
      'tests/e2e/chat-list.spec.ts',
      'tests/e2e/chat-page.spec.ts',
      'tests/e2e/chat-responsive.spec.ts',
      'tests/e2e/chat-tool-call-turn.spec.ts',
      'tests/e2e/chat-states.spec.ts',
      'tests/e2e/chat-new.spec.ts',
      'tests/e2e/chat-new-states.spec.ts',
      'tests/e2e/chat-new-workflows.spec.ts',
      'tests/e2e/agent-duplicate.spec.ts',
      'tests/e2e/agent-plugin-editing.spec.ts',
      'tests/e2e/chat-availability.spec.ts',
      'tests/e2e/chat-archive.spec.ts',
      'tests/e2e/workflow-builder-cards.spec.ts',
      'tests/e2e/runs-states.spec.ts',
      'tests/e2e/run-page-states.spec.ts',
      'tests/e2e/run-page-live-states.spec.ts',
      'tests/e2e/goal-page-states.spec.ts',
      'tests/e2e/checks-states.spec.ts',
      // The view states are a showcase specification too, run once where first listed.
      'tests/e2e/15-view-states.spec.ts',
      'tests/e2e/agents-reviews-design-states.spec.ts',
      'tests/e2e/hooks.spec.ts',
      'tests/e2e/hooks-states.spec.ts',
      'tests/e2e/responsive.spec.ts',
    ]);
    expect(options.grep).toBeUndefined();
    expect(options.out).toEndWith('/tmp/design-review/2026-11-02T08-30-00-000Z');
  });

  test('narrows to one scheme, one specification and a title filter for a sign-off', () => {
    const options = parseArguments(
      ['--scheme', 'dark', '--specs', 'states', '--grep', 'schedules is', '--out', 'here'],
      NOW,
    );
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['dark']);
    expect(options.specifications).toEqual(['tests/e2e/15-view-states.spec.ts']);
    expect(options.grep).toBe('schedules is');
    expect(options.out).toEndWith('/here');
  });

  test('chooses the content with --data: showcase alone, the stress seed alone, or both', () => {
    const specificationsOf = (argv: string[]) => {
      const options = parseArguments(argv, NOW);
      if (typeof options === 'string') throw new Error(options);
      return options.specifications;
    };
    expect(specificationsOf(['--data', 'showcase'])).toEqual([
      'tests/e2e/00-showcase.spec.ts',
      'tests/e2e/shell-chrome.spec.ts',
      'tests/e2e/shell-search.spec.ts',
      'tests/e2e/shell-states.spec.ts',
      'tests/e2e/schedules-list.spec.ts',
      'tests/e2e/schedules-states.spec.ts',
      'tests/e2e/schedules-new.spec.ts',
      'tests/e2e/schedules-edit.spec.ts',
      'tests/e2e/schedules-detail.spec.ts',
      'tests/e2e/health-overview.spec.ts',
      'tests/e2e/health-states.spec.ts',
      'tests/e2e/health-workers-states.spec.ts',
      'tests/e2e/health-storage.spec.ts',
      'tests/e2e/health-audit.spec.ts',
      'tests/e2e/health-audit-states.spec.ts',
      'tests/e2e/restart.spec.ts',
      'tests/e2e/settings-general.spec.ts',
      'tests/e2e/settings-allowed-models.spec.ts',
      'tests/e2e/settings-models.spec.ts',
      'tests/e2e/settings-a2a.spec.ts',
      'tests/e2e/settings-plugins.spec.ts',
      'tests/e2e/settings-data-and-retention.spec.ts',
      'tests/e2e/api-reference.spec.ts',
      'tests/e2e/first-run.spec.ts',
      'tests/e2e/home.spec.ts',
      'tests/e2e/home-activity.spec.ts',
      'tests/e2e/chat-list.spec.ts',
      'tests/e2e/chat-page.spec.ts',
      'tests/e2e/chat-responsive.spec.ts',
      'tests/e2e/chat-tool-call-turn.spec.ts',
      'tests/e2e/chat-states.spec.ts',
      'tests/e2e/chat-new.spec.ts',
      'tests/e2e/chat-new-states.spec.ts',
      'tests/e2e/chat-new-workflows.spec.ts',
      'tests/e2e/agent-duplicate.spec.ts',
      'tests/e2e/agent-plugin-editing.spec.ts',
      'tests/e2e/chat-availability.spec.ts',
      'tests/e2e/chat-archive.spec.ts',
      'tests/e2e/workflow-builder-cards.spec.ts',
      'tests/e2e/runs-states.spec.ts',
      'tests/e2e/run-page-states.spec.ts',
      'tests/e2e/run-page-live-states.spec.ts',
      'tests/e2e/goal-page-states.spec.ts',
      'tests/e2e/checks-states.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
      'tests/e2e/agents-reviews-design-states.spec.ts',
      'tests/e2e/hooks.spec.ts',
      'tests/e2e/hooks-states.spec.ts',
    ]);
    expect(specificationsOf(['--data', 'stress'])).toEqual([
      'tests/e2e/responsive.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(specificationsOf(['--data', 'both'])).toEqual(specificationsOf([]));
    expect(specificationsOf(['--data', 'stress', '--specs', 'states'])).toEqual([
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(specificationsOf(['--specs', 'responsive', '--data', 'both'])).toEqual([
      'tests/e2e/00-showcase.spec.ts',
      'tests/e2e/shell-chrome.spec.ts',
      'tests/e2e/shell-search.spec.ts',
      'tests/e2e/shell-states.spec.ts',
      'tests/e2e/schedules-list.spec.ts',
      'tests/e2e/schedules-states.spec.ts',
      'tests/e2e/schedules-new.spec.ts',
      'tests/e2e/schedules-edit.spec.ts',
      'tests/e2e/schedules-detail.spec.ts',
      'tests/e2e/health-overview.spec.ts',
      'tests/e2e/health-states.spec.ts',
      'tests/e2e/health-workers-states.spec.ts',
      'tests/e2e/health-storage.spec.ts',
      'tests/e2e/health-audit.spec.ts',
      'tests/e2e/health-audit-states.spec.ts',
      'tests/e2e/restart.spec.ts',
      'tests/e2e/settings-general.spec.ts',
      'tests/e2e/settings-allowed-models.spec.ts',
      'tests/e2e/settings-models.spec.ts',
      'tests/e2e/settings-a2a.spec.ts',
      'tests/e2e/settings-plugins.spec.ts',
      'tests/e2e/settings-data-and-retention.spec.ts',
      'tests/e2e/api-reference.spec.ts',
      'tests/e2e/first-run.spec.ts',
      'tests/e2e/home.spec.ts',
      'tests/e2e/home-activity.spec.ts',
      'tests/e2e/chat-list.spec.ts',
      'tests/e2e/chat-page.spec.ts',
      'tests/e2e/chat-responsive.spec.ts',
      'tests/e2e/chat-tool-call-turn.spec.ts',
      'tests/e2e/chat-states.spec.ts',
      'tests/e2e/chat-new.spec.ts',
      'tests/e2e/chat-new-states.spec.ts',
      'tests/e2e/chat-new-workflows.spec.ts',
      'tests/e2e/agent-duplicate.spec.ts',
      'tests/e2e/agent-plugin-editing.spec.ts',
      'tests/e2e/chat-availability.spec.ts',
      'tests/e2e/chat-archive.spec.ts',
      'tests/e2e/workflow-builder-cards.spec.ts',
      'tests/e2e/runs-states.spec.ts',
      'tests/e2e/run-page-states.spec.ts',
      'tests/e2e/run-page-live-states.spec.ts',
      'tests/e2e/goal-page-states.spec.ts',
      'tests/e2e/checks-states.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
      'tests/e2e/agents-reviews-design-states.spec.ts',
      'tests/e2e/hooks.spec.ts',
      'tests/e2e/hooks-states.spec.ts',
      'tests/e2e/responsive.spec.ts',
    ]);
    // `--specs` alone keeps meaning what it always meant: one of the stress specifications.
    expect(specificationsOf(['--specs', 'responsive'])).toEqual(['tests/e2e/responsive.spec.ts']);
  });

  test('refuses an unknown --data, and --specs with showcase data, which it would silently ignore', () => {
    expect(parseArguments(['--data', 'realistic'], NOW)).toBe(
      '--data must be showcase, stress or both, not "realistic"',
    );
    expect(parseArguments(['--data'], NOW)).toBe('--data needs a value');
    expect(parseArguments(['--data', 'showcase', '--specs', 'states'], NOW)).toContain(
      'cannot be used with --data showcase',
    );
    expect(parseArguments(['--specs', 'states', '--data', 'showcase'], NOW)).toContain(
      'cannot be used with --data showcase',
    );
  });

  test('refuses an unknown scheme, an unknown specification, an unknown flag and a missing value', () => {
    expect(parseArguments(['--scheme', 'purple'], NOW)).toContain('--scheme must be');
    expect(parseArguments(['--specs', 'everything'], NOW)).toContain('--specs must be');
    expect(parseArguments(['--color', 'dark'], NOW)).toBe('unknown flag --color');
    expect(parseArguments(['--grep'], NOW)).toBe('--grep needs a value');
    expect(parseArguments(['--out', '--scheme', 'dark'], NOW)).toBe('--out needs a value');
  });
});

/**
 * The showcase specifications whose titles do not yet name every route they capture, so a route
 * filter can skip their captures. This list only shrinks: a specification leaves it once its
 * titles name its routes, and none may join it.
 */
const TITLES_WITHOUT_ROUTES: readonly string[] = [
  'tests/e2e/shell-chrome.spec.ts',
  'tests/e2e/shell-search.spec.ts',
  'tests/e2e/schedules-list.spec.ts',
  'tests/e2e/schedules-states.spec.ts',
  'tests/e2e/schedules-edit.spec.ts',
  'tests/e2e/schedules-detail.spec.ts',
  'tests/e2e/health-overview.spec.ts',
  'tests/e2e/health-states.spec.ts',
  'tests/e2e/health-workers-states.spec.ts',
  'tests/e2e/health-storage.spec.ts',
  'tests/e2e/health-audit.spec.ts',
  'tests/e2e/health-audit-states.spec.ts',
  'tests/e2e/settings-allowed-models.spec.ts',
  'tests/e2e/first-run.spec.ts',
  'tests/e2e/home.spec.ts',
  'tests/e2e/chat-list.spec.ts',
  'tests/e2e/chat-page.spec.ts',
  'tests/e2e/chat-responsive.spec.ts',
  'tests/e2e/chat-tool-call-turn.spec.ts',
  'tests/e2e/chat-states.spec.ts',
  'tests/e2e/chat-new.spec.ts',
  'tests/e2e/chat-new-states.spec.ts',
  'tests/e2e/chat-new-workflows.spec.ts',
  'tests/e2e/agent-duplicate.spec.ts',
  'tests/e2e/agent-plugin-editing.spec.ts',
  'tests/e2e/chat-availability.spec.ts',
  'tests/e2e/chat-archive.spec.ts',
  'tests/e2e/workflow-builder-cards.spec.ts',
];

describe('the showcase specifications’ titles', () => {
  const applicationDirectory = join(import.meta.dir, '..');

  test('name, in the test or the describe around it, every route the test captures', async () => {
    const missing: string[] = [];
    for (const specification of SHOWCASE_SPECIFICATION_PATHS) {
      if (TITLES_WITHOUT_ROUTES.includes(specification)) continue;
      const source = await readFile(join(applicationDirectory, specification), 'utf8');
      for (const { title, route } of routesMissingFromTitles(source)) {
        missing.push(`${specification}: "${title}" captures ${route}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the allowance only shrinks: every specification on it still misses a route', async () => {
    for (const specification of TITLES_WITHOUT_ROUTES) {
      const source = await readFile(join(applicationDirectory, specification), 'utf8');
      expect(routesMissingFromTitles(source).length, specification).toBeGreaterThan(0);
    }
  });

  test('find a capture whose route neither its test nor its describe names', () => {
    const source = [
      "test.describe('/runs at 375 pixels', () => {",
      "  test('the list', async () => { await capture({ route: '/runs' }); });",
      "  test('the page', async () => { await capture({ route: '/runs/:run' }); });",
      '});',
      "test('a run', async () => { await capture({ route: '/goals' }); });",
    ].join('\n');
    // `/runs` in the describe does not name `/runs/:run`, which a `--grep '/runs/:run'` asks for.
    expect(routesMissingFromTitles(source)).toEqual([
      { title: 'the page', route: '/runs/:run' },
      { title: 'a run', route: '/goals' },
    ]);
    expect(capturedRoutes(source)).toEqual(['/runs', '/runs/:run', '/goals']);
  });
});

describe('specificationsThatRanNothing', () => {
  const sources: Record<string, string> = {
    'tests/e2e/run-page-states.spec.ts': [
      'test.describe(`/runs/:run at ${String(width)} pixels`, () => {',
      "  test('a failed instance', async () => { capture({ route: '/runs/:run' }); });",
      '});',
    ].join('\n'),
    // Captures `/runs`, but under a title that does not name it, so `--grep '/runs|/goals'` does
    // not reach it (the titles test is what catches that), and it must not be flagged here.
    'tests/e2e/shell-chrome.spec.ts':
      "test('at 200% text the shell reflows', async () => { capture({ route: '/runs' }); });",
    'tests/e2e/chat-page.spec.ts':
      "test('/chats/:chat opens the details', async () => { capture({ route: '/chats/:chat' }); });",
  };
  const sourceOf = (path: string) => sources[path] ?? '';
  const listed = Object.keys(sources);

  /**
   * One file's suite as CI's capture writes it: Playwright names the file from the configuration's
   * `testDir` (`./tests`), so `e2e/run-page-states.spec.ts`, and nests the describes under it.
   */
  const ciSuite = (file: string, specs: number) => ({
    title: file,
    file,
    column: 0,
    line: 0,
    specs: [],
    suites: [
      {
        title: '/runs/:run at 1280 pixels',
        file,
        line: 41,
        column: 3,
        specs: Array.from({ length: specs }, (_, index) => ({
          title: `test ${String(index)}`,
          ok: true,
          tags: [],
          tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed' }] }],
          file,
          line: 42,
          column: 5,
        })),
      },
    ],
  });

  test('counts a report written as CI writes it, file paths from testDir, as the listed specification', () => {
    const report = {
      config: { rootDir: '/__w/corvidae/corvidae/applications/interborough/tests' },
      suites: [ciSuite('e2e/run-page-states.spec.ts', 5), ciSuite('e2e/chat-page.spec.ts', 1)],
    };
    expect(specificationsThatRanNothing(report, listed, '/runs|/goals', sourceOf)).toEqual([]);
    expect(specificationsThatRanNothing(report, listed, undefined, sourceOf)).toEqual([
      'tests/e2e/shell-chrome.spec.ts',
    ]);
  });

  test('names a specification whose titles the filter matches and that ran no test', () => {
    const report = { suites: [ciSuite('e2e/chat-page.spec.ts', 1)] };
    expect(specificationsThatRanNothing(report, listed, '/runs|/goals', sourceOf)).toEqual([
      'tests/e2e/run-page-states.spec.ts',
    ]);
  });

  test('does not flag one whose titles the filter does not match, whatever it captures', () => {
    const report = { suites: [ciSuite('e2e/run-page-states.spec.ts', 2)] };
    expect(specificationsThatRanNothing(report, listed, '/runs|/goals', sourceOf)).not.toContain(
      'tests/e2e/shell-chrome.spec.ts',
    );
  });
});

describe('portIsFree', () => {
  test('answers false for a port something already listens on, and true once it is released', () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = holder.port;
    try {
      expect(portIsFree(port)).toBe(false);
    } finally {
      holder.stop(true);
    }
    expect(portIsFree(port)).toBe(true);
  });
});

describe('probeSocketHandlers', () => {
  test('ignores the data a client sends to the port the probe holds', () => {
    expect(probeSocketHandlers.data()).toBeUndefined();
  });
});

describe('captureCount', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'design-review-count-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('counts the manifest lines that are not blank, and is zero without a manifest', async () => {
    expect(await captureCount(directory)).toBe(0);
    await writeFile(join(directory, 'manifest.jsonl'), '{"a":1}\n\n  \n{"a":2}\n');
    expect(await captureCount(directory)).toBe(2);
  });
});

describe('captureForDesignReview readiness', () => {
  test('runs the readiness condition after viewport changes and before each screenshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'design-review-ready-'));
    const previousCapture = process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
    const previousScheme = process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
    const events: string[] = [];
    const page = {
      viewportSize: () => ({ width: 1280, height: 900 }),
      async setViewportSize(size: { width: number; height: number }) {
        events.push(`viewport:${size.width}x${size.height}`);
      },
      async screenshot() {
        events.push('screenshot');
      },
      url: () => 'http://127.0.0.1/ready',
      evaluate: async () => ({ viewport: { width: 1280, height: 900 } }),
      locator() {
        return {
          evaluate: async () => 1,
        };
      },
    };
    process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = directory;
    process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = 'light';
    try {
      await captureForDesignReview(page as never, {
        route: '/ready',
        state: 'settled',
        source: 'test',
        ready: async () => {
          events.push('ready');
        },
      });
      expect(events).toEqual([
        'ready',
        'screenshot',
        'viewport:1280x901',
        'ready',
        'screenshot',
        'viewport:1280x900',
        'ready',
        // The 1280 capture is repeated at 1920 by 1080, with its own stretch for the whole page.
        'viewport:1920x1080',
        'ready',
        'screenshot',
        'viewport:1920x1081',
        'ready',
        'screenshot',
        'viewport:1920x1080',
        'ready',
        'viewport:1280x900',
        'ready',
      ]);
    } finally {
      if (previousCapture === undefined) delete process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
      else process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = previousCapture;
      if (previousScheme === undefined)
        delete process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
      else process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = previousScheme;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('capture file names', () => {
  const capture = { route: '/runs', state: 'ready', source: 'runs-states.spec.ts' };

  test('say which specification and which world a screen is from', () => {
    expect(designReviewSlug(capture, 1920, 'dark', 'sample-world')).toBe(
      'runs-states--sample-world--runs--ready--1920--dark',
    );
  });

  test('differ for two specifications, two worlds and two tabs of one route and state', () => {
    const names = [
      designReviewSlug(capture, 1280, 'light', 'sample-world'),
      designReviewSlug(
        { ...capture, source: '00-showcase.spec.ts' },
        1280,
        'light',
        'sample-world',
      ),
      designReviewSlug(capture, 1280, 'light', 'stress'),
      designReviewSlug({ ...capture, tab: 'skills' }, 1280, 'light', 'sample-world'),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  test('read the world from the host that served the page', () => {
    expect(designReviewWorld(`http://127.0.0.1:${E2E_SHOWCASE_PORT}/runs`, 'x.spec.ts')).toBe(
      'sample-world',
    );
    expect(designReviewWorld(`http://127.0.0.1:${E2E_FIRST_RUN_PORT}/`, 'x.spec.ts')).toBe(
      'first-run',
    );
    expect(designReviewWorld(`http://127.0.0.1:${E2E_PORT}/runs`, 'responsive.spec.ts')).toBe(
      'stress',
    );
    expect(designReviewWorld(`http://127.0.0.1:${E2E_PORT}/runs`, '15-view-states.spec.ts')).toBe(
      'e2e-host',
    );
  });

  describe('when a specification captures twice', () => {
    /** Runs `run` with the capture directory and light scheme set, and restores both afterwards. */
    async function withCapture(run: (directory: string) => Promise<void>): Promise<void> {
      const directory = await mkdtemp(join(tmpdir(), 'design-review-names-'));
      const previousCapture = process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
      const previousScheme = process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
      process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = directory;
      process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = 'light';
      try {
        await run(directory);
      } finally {
        if (previousCapture === undefined) delete process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
        else process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] = previousCapture;
        if (previousScheme === undefined)
          delete process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
        else process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'] = previousScheme;
        await rm(directory, { recursive: true, force: true });
      }
    }
    const tablet = {
      viewportSize: () => ({ width: 768, height: 900 }),
      async setViewportSize() {},
      async screenshot() {},
      url: () => `http://127.0.0.1:${E2E_PORT}/runs`,
      evaluate: async () => ({ viewport: { width: 768, height: 900 } }),
      locator: () => ({ evaluate: async () => 0 }),
    };

    test('under one name, fails instead of overwriting the first screen', async () => {
      await withCapture(async () => {
        await captureForDesignReview(tablet as never, capture);
        const rejection = await rejectionOf(captureForDesignReview(tablet as never, capture));
        expect(String(rejection)).toContain(
          'Two design-review captures resolve to runs-states--e2e-host--runs--ready--768--light',
        );
      });
    });

    test('under two states, keeps both', async () => {
      await withCapture(async (directory) => {
        await captureForDesignReview(tablet as never, capture);
        await captureForDesignReview(tablet as never, { ...capture, state: 'empty' });
        expect(await captureCount(directory)).toBe(2);
      });
    });

    test('at 1280, also writes the 1920 capture, and takes the specification’s own 1920 as the same screen', async () => {
      await withCapture(async (directory) => {
        const desktop = { ...tablet, viewportSize: () => ({ width: 1280, height: 900 }) };
        await captureForDesignReview(desktop as never, capture);
        const wide = { ...tablet, viewportSize: () => ({ width: 1920, height: 1080 }) };
        await captureForDesignReview(wide as never, capture);
        const manifest = await readFile(join(directory, 'manifest.jsonl'), 'utf8');
        const widths = manifest
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { width: number }).width);
        expect(widths).toEqual([1280, 1920]);
      });
    });
  });
});

describe('nextFrame', () => {
  test('ends under a stopped page clock, which never delivers an animation frame', async () => {
    // COR-2227: Home's loading capture stops the clock (`page.clock.pauseAt`), and Playwright's
    // fake clock owns `requestAnimationFrame`, so a frame wait built on it never ended once the
    // page outgrew its viewport. Here a frame comes only as a layout observation, as it does then.
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = {
      requestAnimationFrame: scope['requestAnimationFrame'],
      ResizeObserver: scope['ResizeObserver'],
    };
    let observations = 0;
    let animationFramesAsked = 0;
    // An observation made inside an observer's callback is skipped for that frame and reported as
    // a ResizeObserver loop error, so each observation must start outside any callback.
    let delivering = false;
    let observedWhileDelivering = 0;
    scope['requestAnimationFrame'] = () => {
      animationFramesAsked += 1;
      return 0;
    };
    scope['ResizeObserver'] = class {
      readonly #callback: () => void;
      #disconnected = false;
      constructor(callback: () => void) {
        this.#callback = callback;
      }
      observe(): void {
        observations += 1;
        if (delivering) observedWhileDelivering += 1;
        queueMicrotask(() => {
          if (this.#disconnected) return;
          delivering = true;
          try {
            this.#callback();
          } finally {
            delivering = false;
          }
        });
      }
      disconnect(): void {
        this.#disconnected = true;
      }
    };
    const page = { evaluate: async (pageFunction: () => Promise<void>) => pageFunction() };
    try {
      await nextFrame(page as never);
    } finally {
      scope['requestAnimationFrame'] = saved.requestAnimationFrame;
      scope['ResizeObserver'] = saved.ResizeObserver;
    }
    expect(animationFramesAsked).toBe(0);
    expect(observations).toBe(2);
    expect(observedWhileDelivering).toBe(0);
  });
});

describe('capture cleanup failures', () => {
  test('preserves the original capture failure when pointer cleanup also fails', async () => {
    const captureError = new Error('original capture assertion');
    const cleanupError = new Error('page closed before pointer cleanup');
    let thrown: unknown;
    try {
      await withPointerCleanup(
        async () => {
          throw captureError;
        },
        async () => {
          throw cleanupError;
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([captureError, cleanupError]);
  });
});

describe('captureDesignReview', () => {
  let directory = '';
  let saved: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'design-review-capture-'));
    saved = process.env['INTERBOROUGH_E2E_PORT'];
    delete process.env['INTERBOROUGH_E2E_PORT'];
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['INTERBOROUGH_E2E_PORT'];
    else process.env['INTERBOROUGH_E2E_PORT'] = saved;
    await rm(directory, { recursive: true, force: true });
  });

  interface Calls {
    out: string;
    err: string;
    probed: number[];
    commands: { command: readonly string[]; variables: Record<string, string> }[];
  }

  /** A host whose Playwright runs write `manifestLines` captures and exit with the given codes. */
  function standIn(options: {
    free?: boolean;
    exitCodes?: number[];
    manifestLines?: number;
    manifest?: string;
  }): {
    calls: Calls;
    environment: CaptureEnvironment;
  } {
    const calls: Calls = { out: '', err: '', probed: [], commands: [] };
    const exitCodes = [...(options.exitCodes ?? [])];
    const environment: CaptureEnvironment = {
      standardOutput: (text) => {
        calls.out += text;
      },
      standardError: (text) => {
        calls.err += text;
      },
      portIsFree: (port) => {
        calls.probed.push(port);
        return options.free ?? true;
      },
      async run(command, variables) {
        calls.commands.push({ command, variables });
        const lines =
          options.manifest ??
          Array.from({ length: options.manifestLines ?? 0 }, () => '{}').join('\n');
        await writeFile(
          join(variables['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] ?? '', 'manifest.jsonl'),
          lines,
        );
        return exitCodes.shift() ?? 0;
      },
    };
    return { calls, environment };
  }

  test('answers 2 for a bad command line without probing the port', async () => {
    const { calls, environment } = standIn({});
    expect(await captureDesignReview(['--scheme', 'purple'], environment)).toBe(2);
    expect(calls.err).toContain('--scheme must be');
    expect(calls.probed).toEqual([]);
  });

  test('answers 2 and names the variable to set when the end-to-end port is taken', async () => {
    process.env['INTERBOROUGH_E2E_PORT'] = '7721';
    const { calls, environment } = standIn({ free: false });
    expect(await captureDesignReview(['--out', directory], environment)).toBe(2);
    expect(calls.probed).toEqual([7721]);
    expect(calls.err).toContain('port 7721 is already in use');
    expect(calls.err).toContain('INTERBOROUGH_E2E_PORT');
    expect(calls.commands).toEqual([]);
  });

  test('runs Playwright once per scheme with the capture variables and writes a clean summary', async () => {
    const { calls, environment } = standIn({ manifestLines: 3 });
    const out = join(directory, 'nested', 'capture');
    expect(
      await captureDesignReview(
        ['--out', out, '--specs', 'states', '--grep', 'agents'],
        environment,
      ),
    ).toBe(0);
    expect(calls.probed).toEqual([endToEndPort()]);
    expect(calls.commands.map((call) => call.variables)).toEqual([
      {
        INTERBOROUGH_DESIGN_REVIEW_CAPTURE: out,
        INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: 'light',
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(out, 'playwright-light.json'),
      },
      {
        INTERBOROUGH_DESIGN_REVIEW_CAPTURE: out,
        INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: 'dark',
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(out, 'playwright-dark.json'),
      },
    ]);
    expect(calls.commands[0]?.command).toEqual([
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      '--reporter=list,json',
      'tests/e2e/15-view-states.spec.ts',
      '--grep',
      'agents',
    ]);
    expect(calls.out).toContain('design review: capturing in light: bun --bun playwright test');
    expect(calls.out).toContain(`design review: 3 captures in ${out}\n`);
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
    expect(summary).toEqual({
      out,
      captures: 3,
      shard: null,
      specifications: ['tests/e2e/15-view-states.spec.ts'],
      grep: 'agents',
      runs: [
        { scheme: 'light', exitCode: 0, ranNothing: [] },
        { scheme: 'dark', exitCode: 0, ranNothing: [] },
      ],
      clean: true,
      geometry: { captures: 3, measured: 0, coarse: 0, unscaled: 0, findings: 0 },
    });
    expect(calls.out).not.toContain('geometry findings');
  });

  test('exits 1 and names a listed specification the filter reaches that ran no test', async () => {
    const stand = standIn({ manifestLines: 2 });
    const calls = stand.calls;
    // The stand-in Playwright writes a report in which the view states ran nothing.
    const environment: CaptureEnvironment = {
      ...stand.environment,
      run: async (command, variables) => {
        const code = await stand.environment.run(command, variables);
        await writeFile(
          variables['PLAYWRIGHT_JSON_OUTPUT_NAME'] ?? '',
          JSON.stringify({ suites: [] }),
        );
        return code;
      },
    };
    expect(
      await captureDesignReview(
        ['--out', directory, '--specs', 'states', '--scheme', 'light', '--grep', '/runs'],
        environment,
      ),
    ).toBe(1);
    expect(calls.err).toContain('tests/e2e/15-view-states.spec.ts ran no test in light');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(summary.clean).toBe(false);
    expect(summary.runs[0].ranNothing).toEqual(['tests/e2e/15-view-states.spec.ts']);
  });

  test('audits what the captures measured and names the geometry report', async () => {
    await mkdir(join(directory, 'geometry'), { recursive: true });
    await writeFile(
      join(directory, 'geometry', 'agents.json'),
      JSON.stringify({
        viewport: { width: 1280, height: 800 },
        pointerCoarse: false,
        spaceScale: [],
        controls: [],
        textStyles: [
          { fontSize: 9, lineHeight: 12, fontWeight: 400, count: 1, multiline: false, sample: 'x' },
        ],
        borders: [],
        edges: [],
        stacks: [],
        leadingSpace: [],
        overlaps: [],
        insets: [],
        chrome: null,
      }),
    );
    const manifest = JSON.stringify({
      route: '/agents',
      state: 'ready',
      source: '00-showcase.spec.ts',
      width: 1280,
      colorScheme: 'light',
      viewport: 'screens/agents.png',
      geometry: 'geometry/agents.json',
    });
    const { calls, environment } = standIn({ manifest });
    expect(await captureDesignReview(['--out', directory, '--scheme', 'light'], environment)).toBe(
      0,
    );
    expect(calls.out).toContain(
      `design review: 1 geometry findings from 1 measured captures: ${join(directory, 'geometry-report.md')}\n`,
    );
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(summary.geometry).toEqual({
      captures: 1,
      measured: 1,
      coarse: 0,
      unscaled: 1,
      findings: 1,
    });
    expect(await readFile(join(directory, 'geometry-report.md'), 'utf8')).toContain(
      'Text too small',
    );
  });

  test('keeps the captures of a run whose specification failed, and says so', async () => {
    const { calls, environment } = standIn({ exitCodes: [0, 1], manifestLines: 2 });
    expect(await captureDesignReview(['--out', directory, '--data', 'showcase'], environment)).toBe(
      0,
    );
    expect(calls.commands[0]?.command).not.toContain('--grep');
    expect(calls.out).toContain('(a specification failed; see summary.json)');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(summary.clean).toBe(false);
    expect(summary.grep).toBeNull();
  });

  test('answers 1 when nothing was captured', async () => {
    const { environment } = standIn({ manifestLines: 0 });
    expect(await captureDesignReview(['--out', directory, '--scheme', 'dark'], environment)).toBe(
      1,
    );
  });
});

describe('hostEnvironment', () => {
  test('probes the loopback port and runs a command with the variables added to the environment', async () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      expect(hostEnvironment.portIsFree(holder.port)).toBe(false);
    } finally {
      holder.stop(true);
    }
    const directory = await mkdtemp(join(tmpdir(), 'design-review-host-'));
    try {
      const marker = join(directory, 'marker.txt');
      const exitCode = await hostEnvironment.run(
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.DESIGN_REVIEW_PROBE ?? '')`,
        ],
        { DESIGN_REVIEW_PROBE: 'seen' },
      );
      expect(exitCode).toBe(0);
      expect(await readFile(marker, 'utf8')).toBe('seen');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  // A spawned Bun child can leave the coverage loader resolving the next late import against the
  // document origin. Keep the next UI test file from handing it a network origin.
  if (typeof window !== 'undefined' && window instanceof Window)
    window.happyDOM.setURL('about:blank');
});
