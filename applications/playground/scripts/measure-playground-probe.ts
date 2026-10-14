/**
 * In-process measurement probe for `measure-playground.ts` (CIN-585). Not a test, not a gate.
 *
 * `measure-playground.ts` spawns this file as a fresh child for each probe so it never shares
 * compiler state with the timed static-export and server-readiness children. The probe starts the
 * Playground server in its own process so it can read the server's artifact owners directly
 * (`measure-playground-artifact-snapshot.ts`); nothing here patches production code.
 *
 *   navigation  One warm-up cycle, then N recorded cycles through home, Button, Action Row, Chat,
 *               Modal, and Review Editor in Chromium. Each component page opens and closes the
 *               Playground view, then the cycle returns home and waits for network and frames to
 *               settle before its checkpoint: requests and encoded bytes, interaction-ready
 *               timings, live example mounts, open EventSource subscriptions, DOM and listener
 *               counters, JS heap through CDP, and retained server artifacts.
 *   rebuild     N edit/rebuild cycles against a disposable example written beside Button's
 *               examples and deleted afterwards. Each cycle rewrites the example, waits for the
 *               watcher's invalidation, re-requests the page and its bundle graph, confirms the new
 *               source is served, and snapshots retained server artifacts.
 *
 * Usage: bun scripts/measure-playground-probe.ts <navigation|rebuild> --output <file> [--cycles 5] [--port 5610]
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { chromium, type CDPSession, type Page } from '@playwright/test';

import { waitForPendingRebuild } from '../src/file-watcher.ts';
import { PLAYGROUND_ROOT } from '../src/playground-paths.ts';
import { startServer } from '../src/playground-server.ts';
import { getRebuildGeneration } from '../src/rebuild-generation.ts';
import {
  snapshotRetainedArtifacts,
  type RetainedArtifactSnapshot,
} from './measure-playground-artifact-snapshot.ts';
import { growthReport } from './measure-playground-statistics.ts';

export const NAVIGATION_ROUTES = [
  '/',
  '/page/button',
  '/page/action-row',
  '/page/chat',
  '/page/modal',
  '/page/review-editor',
] as const;

/** The deadline for one settle or one rebuild to be observed; a miss fails the probe loudly. */
const OBSERVATION_DEADLINE_MILLISECONDS = 120_000;
const QUIET_WINDOW_MILLISECONDS = 500;

type NetworkTracker = {
  requests: number;
  encodedBytes: number;
  inFlight: Set<string>;
  openEventSources: Set<string>;
  reset: () => void;
};

async function trackNetwork(session: CDPSession): Promise<NetworkTracker> {
  const eventSourceIds = new Set<string>();
  const tracker: NetworkTracker = {
    requests: 0,
    encodedBytes: 0,
    inFlight: new Set(),
    openEventSources: new Set(),
    reset() {
      tracker.requests = 0;
      tracker.encodedBytes = 0;
    },
  };
  session.on('Network.requestWillBeSent', (event) => {
    tracker.requests += 1;
    if (event.type === 'EventSource') {
      eventSourceIds.add(event.requestId);
      tracker.openEventSources.add(event.requestId);
    } else {
      tracker.inFlight.add(event.requestId);
    }
  });
  const finish = (requestId: string): void => {
    tracker.inFlight.delete(requestId);
    tracker.openEventSources.delete(requestId);
  };
  session.on('Network.loadingFinished', (event) => {
    tracker.encodedBytes += event.encodedDataLength;
    finish(event.requestId);
  });
  session.on('Network.loadingFailed', (event) => finish(event.requestId));
  await session.send('Network.enable');
  return tracker;
}

/** Wait until no non-EventSource request has been in flight for the quiet window, then two frames. */
async function settle(page: Page, tracker: NetworkTracker): Promise<void> {
  const deadline = performance.now() + OBSERVATION_DEADLINE_MILLISECONDS;
  let quietSince = performance.now();
  while (performance.now() - quietSince < QUIET_WINDOW_MILLISECONDS) {
    if (performance.now() > deadline) {
      throw new Error(`Navigation did not settle; ${tracker.inFlight.size} requests in flight.`);
    }
    if (tracker.inFlight.size > 0) quietSince = performance.now();
    await Bun.sleep(25);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

type RouteTiming = {
  route: string;
  interactionReadyMilliseconds: number;
  playgroundOpenMilliseconds: number | null;
  playgroundCloseMilliseconds: number | null;
};

async function visitRoute(
  page: Page,
  origin: string,
  route: string,
  tracker: NetworkTracker,
): Promise<RouteTiming> {
  const startedAt = performance.now();
  await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-component-page] .dx-hero h1').first().waitFor();
  const interactionReadyMilliseconds = performance.now() - startedAt;
  let playgroundOpenMilliseconds: number | null = null;
  let playgroundCloseMilliseconds: number | null = null;
  if (route !== '/') {
    const openedAt = performance.now();
    await page.locator('#view-tab-playground').click();
    await page.locator('#view-panel-playground').waitFor();
    playgroundOpenMilliseconds = performance.now() - openedAt;
    await settle(page, tracker);
    const closedAt = performance.now();
    await page.locator('#view-tab-documentation').click();
    await page.locator('#view-panel-playground').waitFor({ state: 'detached' });
    playgroundCloseMilliseconds = performance.now() - closedAt;
  }
  await settle(page, tracker);
  return {
    route,
    interactionReadyMilliseconds,
    playgroundOpenMilliseconds,
    playgroundCloseMilliseconds,
  };
}

type BrowserCheckpoint = {
  exampleMountHosts: number;
  populatedExampleMountHosts: number;
  openEventSources: number;
  /** `Memory.getDOMCounters` after a forced collection. */
  domCounters: { documents: number; nodes: number; jsEventListeners: number };
  /** `Runtime.getHeapUsage` after a forced collection. JS heap bytes; never added to RSS. */
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
};

async function browserCheckpoint(
  page: Page,
  session: CDPSession,
  tracker: NetworkTracker,
): Promise<BrowserCheckpoint> {
  await session.send('HeapProfiler.collectGarbage');
  const heap = await session.send('Runtime.getHeapUsage');
  const counters = await session.send('Memory.getDOMCounters');
  const mounts = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[id^="example-mount-"]')];
    return {
      hosts: hosts.length,
      populated: hosts.filter((host) => host.childElementCount > 0).length,
    };
  });
  return {
    exampleMountHosts: mounts.hosts,
    populatedExampleMountHosts: mounts.populated,
    openEventSources: tracker.openEventSources.size,
    domCounters: {
      documents: counters.documents,
      nodes: counters.nodes,
      jsEventListeners: counters.jsEventListeners,
    },
    jsHeapUsedBytes: heap.usedSize,
    jsHeapTotalBytes: heap.totalSize,
  };
}

type ProbeProcessMemory = { residentBytes: number; heapUsedBytes: number };

/** `process.memoryUsage()` reports bytes; this is the probe process, which also hosts the server. */
function probeProcessMemory(): ProbeProcessMemory {
  Bun.gc(true);
  const usage = process.memoryUsage();
  return { residentBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

type NavigationCycle = {
  cycle: number;
  requests: number;
  encodedBytes: number;
  routes: RouteTiming[];
  browser: BrowserCheckpoint;
  server: RetainedArtifactSnapshot;
  probeProcess: ProbeProcessMemory;
};

async function navigationCycle(
  cycle: number,
  page: Page,
  session: CDPSession,
  tracker: NetworkTracker,
  origin: string,
): Promise<NavigationCycle> {
  tracker.reset();
  const routes: RouteTiming[] = [];
  for (const route of NAVIGATION_ROUTES)
    routes.push(await visitRoute(page, origin, route, tracker));
  // Return home last so every checkpoint is taken on the same document.
  routes.push(await visitRoute(page, origin, '/', tracker));
  return {
    cycle,
    requests: tracker.requests,
    encodedBytes: tracker.encodedBytes,
    routes,
    browser: await browserCheckpoint(page, session, tracker),
    server: snapshotRetainedArtifacts(),
    probeProcess: probeProcessMemory(),
  };
}

async function runNavigationProbe(cycles: number, port: number): Promise<unknown> {
  const server = await startServer(port);
  const origin = `http://localhost:${server.port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const tracker = await trackNetwork(session);
    const warmup = await navigationCycle(0, page, session, tracker, origin);
    const recorded: NavigationCycle[] = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      recorded.push(await navigationCycle(cycle, page, session, tracker, origin));
    }
    return {
      probe: 'navigation',
      routes: NAVIGATION_ROUTES,
      warmup,
      cycles: recorded,
      growth: growthReport({
        exampleMountHosts: recorded.map((item) => item.browser.exampleMountHosts),
        populatedExampleMountHosts: recorded.map((item) => item.browser.populatedExampleMountHosts),
        openEventSources: recorded.map((item) => item.browser.openEventSources),
        domNodes: recorded.map((item) => item.browser.domCounters.nodes),
        jsEventListeners: recorded.map((item) => item.browser.domCounters.jsEventListeners),
        documents: recorded.map((item) => item.browser.domCounters.documents),
        jsHeapUsedBytes: recorded.map((item) => item.browser.jsHeapUsedBytes),
        serverArtifacts: recorded.map((item) => item.server.totalArtifacts),
        serverArtifactBytes: recorded.map((item) => item.server.totalArtifactBytes),
        serverLiveReloadSubscribers: recorded.map((item) => item.server.liveReloadSubscribers),
        probeResidentBytes: recorded.map((item) => item.probeProcess.residentBytes),
      }),
    };
  } finally {
    await browser.close();
    await server.dispose();
  }
}

/** The disposable example's source for one cycle. */
export function rebuildFixtureSource(cycle: number): string {
  return `<script lang="ts" module>
  export const title = 'Measurement rebuild cycle ${cycle}';
  export const description = 'Disposable CIN-585 fixture; deleted when the probe ends.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
</script>

<Button label="Measurement cycle ${cycle}" />
`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** Request the page and its stable entry, then the hashed entry that the stable entry imports. */
async function requestPageGraph(origin: string, component: string): Promise<void> {
  await fetchText(`${origin}/page/${component}`);
  const stableEntry = await fetchText(`${origin}/page-bundle/${component}.js`);
  const hashedEntry = /^import "([^"]+)";\n$/u.exec(stableEntry)?.[1];
  if (hashedEntry === undefined) throw new Error(`Unexpected stable entry for ${component}.`);
  await fetchText(`${origin}${hashedEntry}`);
}

async function waitForGenerationAfter(generation: number): Promise<number> {
  const deadline = performance.now() + OBSERVATION_DEADLINE_MILLISECONDS;
  while (getRebuildGeneration() === generation) {
    if (performance.now() > deadline)
      throw new Error('The watcher never observed the fixture edit.');
    await Bun.sleep(10);
  }
  return waitForPendingRebuild();
}

async function runRebuildProbe(cycles: number, port: number): Promise<unknown> {
  const component = 'button';
  const scenario = `measure-rebuild-${process.pid}`;
  const fixturePath = join(
    PLAYGROUND_ROOT,
    'src',
    'examples',
    component,
    `${scenario}.example.svelte`,
  );
  const server = await startServer(port);
  const origin = `http://localhost:${server.port}`;
  try {
    let generation = getRebuildGeneration();
    await writeFile(fixturePath, rebuildFixtureSource(0));
    generation = await waitForGenerationAfter(generation);
    await requestPageGraph(origin, component);
    const before = { server: snapshotRetainedArtifacts(), probeProcess: probeProcessMemory() };
    const recorded = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const startedAt = performance.now();
      await writeFile(fixturePath, rebuildFixtureSource(cycle));
      generation = await waitForGenerationAfter(generation);
      const invalidatedMilliseconds = performance.now() - startedAt;
      await requestPageGraph(origin, component);
      const source = await fetchText(`${origin}/example-src/${component}/${scenario}`);
      if (!source.includes(`Measurement cycle ${cycle}`)) {
        throw new Error(`Cycle ${cycle} served stale example source.`);
      }
      recorded.push({
        cycle,
        generation,
        invalidatedMilliseconds,
        rebuiltAndServedMilliseconds: performance.now() - startedAt,
        server: snapshotRetainedArtifacts(),
        probeProcess: probeProcessMemory(),
      });
    }
    await rm(fixturePath, { force: true });
    await waitForGenerationAfter(generation);
    await requestPageGraph(origin, component);
    const after = { server: snapshotRetainedArtifacts(), probeProcess: probeProcessMemory() };
    return {
      probe: 'rebuild',
      component,
      scenario,
      before,
      cycles: recorded,
      afterFixtureRemoved: after,
      growth: growthReport({
        pageArtifacts: recorded.map((item) => item.server.page.artifacts),
        pageArtifactBytes: recorded.map((item) => item.server.page.artifactBytes),
        totalArtifacts: recorded.map((item) => item.server.totalArtifacts),
        totalArtifactBytes: recorded.map((item) => item.server.totalArtifactBytes),
        inFlightBuilds: recorded.map((item) => item.server.inFlightBuilds),
        probeResidentBytes: recorded.map((item) => item.probeProcess.residentBytes),
        probeHeapUsedBytes: recorded.map((item) => item.probeProcess.heapUsedBytes),
      }),
    };
  } finally {
    await rm(fixturePath, { force: true });
    await server.dispose();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      output: { type: 'string' },
      cycles: { type: 'string', default: '5' },
      port: { type: 'string', default: '5610' },
    },
  });
  const [probe] = positionals;
  const cycles = Number(values.cycles);
  const port = Number(values.port);
  if (values.output === undefined) throw new Error('--output is required.');
  if (!Number.isInteger(cycles) || cycles < 1)
    throw new Error('--cycles must be a positive integer.');
  if (!Number.isInteger(port) || port < 1) throw new Error('--port must be a positive integer.');
  let result: unknown;
  if (probe === 'navigation') result = await runNavigationProbe(cycles, port);
  else if (probe === 'rebuild') result = await runRebuildProbe(cycles, port);
  else throw new Error(`Unknown probe ${JSON.stringify(probe)}; expected navigation or rebuild.`);
  await Bun.write(values.output, `${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      // Flush the diagnostic before exiting; a bare exit can truncate piped stderr.
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${detail}\n`, () => process.exit(1));
    },
  );
}
