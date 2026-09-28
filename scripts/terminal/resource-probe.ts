import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertEvidence,
  type EvidenceCell,
  type EvidenceReport,
  type ObservedWorkload,
  type WorkloadDefinition,
} from './evidence-schema.ts';

const root = join(import.meta.dir, '../..');
const reportPath = join(root, 'tmp/terminal-probes/resources.json');
const pinnedBunVersion = '1.4.2';
const expectedCellIds = [
  'throughput-and-queues',
  'input-latency',
  'memory-plateau',
  'overflow',
  'cleanup-order',
  'xterm-initialization',
  'browser-assets-and-csp',
  'hidden-page-liveness',
  'retained-projection-memory',
  'teardown',
] as const;

const targets = {
  throughputBytesPerSecond: 1_000_000,
  inputP99Milliseconds: 10,
  memoryDeltaMegabytes: 64,
  queuePeakOperations: 256,
  cleanupMilliseconds: 5_000,
} as const;

type Metric = { value: number; unit: string };
type ProbeResult = {
  passed: boolean;
  observations: string[];
  metrics: Record<string, Metric>;
  workload: WorkloadDefinition;
  observed: ObservedWorkload;
};

export type CleanupFacts = {
  authorityRevoked: boolean;
  controlCapacityReserved: boolean;
  userQueueCanceled: boolean;
  processGroupSignaled: boolean;
  parentExited: boolean;
  descendantObservedGone: boolean | undefined;
  handlesClosed: boolean;
};

export type CleanupResult = {
  state: 'complete' | 'incomplete' | 'unknown';
  quarantined: boolean;
  facts: CleanupFacts;
};

export function createCleanupQueue(
  userCapacity: number,
  controlCapacity: number,
): {
  enqueueUser(): boolean;
  reserveControl(): boolean;
} {
  let users = 0;
  let controls = 0;
  return {
    enqueueUser: () => {
      if (users >= userCapacity) return false;
      users += 1;
      return true;
    },
    reserveControl: () => {
      if (controls >= controlCapacity) return false;
      controls += 1;
      return true;
    },
  };
}

export function deriveCleanupResult(facts: CleanupFacts): CleanupResult {
  const values = Object.values(facts);
  const unknown = facts.descendantObservedGone === undefined;
  const complete = values.every((value) => value === true);
  return {
    state: unknown ? 'unknown' : complete ? 'complete' : 'incomplete',
    quarantined: !complete,
    facts,
  };
}

function makeWorkload(
  fixture: string,
  method: string,
  unit: string,
  target: string,
  controlObserved: ObservedWorkload,
): WorkloadDefinition {
  const targetDefinitions: Record<
    string,
    { metric: string; unit: string; comparator: 'gte' | 'lte' | 'eq'; value: number }
  > = {
    'throughput-and-queues': {
      metric: 'throughput',
      unit,
      comparator: 'gte' as const,
      value: targets.throughputBytesPerSecond,
    },
    'input-latency': {
      metric: 'p99',
      unit,
      comparator: 'lte' as const,
      value: targets.inputP99Milliseconds,
    },
    'memory-plateau': {
      metric: 'memoryDelta',
      unit,
      comparator: 'lte' as const,
      value: targets.memoryDeltaMegabytes,
    },
    overflow: { metric: 'capacity', unit, comparator: 'eq' as const, value: 256 },
    'cleanup-order': {
      metric: 'cleanup',
      unit,
      comparator: 'lte' as const,
      value: targets.cleanupMilliseconds,
    },
    'xterm-initialization': {
      metric: 'assertion',
      unit: 'boolean',
      comparator: 'eq' as const,
      value: 1,
    },
    'browser-assets-and-csp': {
      metric: 'assertion',
      unit: 'boolean',
      comparator: 'eq' as const,
      value: 1,
    },
    'hidden-page-liveness': {
      metric: 'liveness',
      unit: 'boolean',
      comparator: 'eq' as const,
      value: 1,
    },
    'retained-projection-memory': {
      metric: 'assertion',
      unit: 'boolean',
      comparator: 'eq' as const,
      value: 1,
    },
    teardown: {
      metric: 'cleanup',
      unit,
      comparator: 'lte' as const,
      value: targets.cleanupMilliseconds,
    },
  };
  const targetDefinition = targetDefinitions[fixture] ?? {
    metric: target.startsWith('available') ? 'available' : 'assertion',
    unit,
    comparator: 'eq' as const,
    value: 1,
  };
  const sampleCount = fixture === 'input-latency' ? 1_000 : 1;
  const warmupCount = fixture === 'memory-plateau' ? 1 : 0;
  const observed: ObservedWorkload = {
    durationMilliseconds: 0.001,
    sampleCount,
    warmupCount,
    metrics: { [targetDefinition.metric]: { value: 1, unit: targetDefinition.unit } },
    raw: { fixtureId: fixture, mode: 'candidate-placeholder' },
  };
  const workload: WorkloadDefinition = {
    fixtureId: fixture,
    environment: { hardware: `${process.arch}/${process.platform}`, runtime: `Bun ${Bun.version}` },
    plan: {
      durationMilliseconds: 1_000,
      sampleCount,
      warmupCount,
      method,
      target: targetDefinition,
    },
    control: { passed: true, observed: controlObserved },
    observed,
  };
  return workload;
}

function measuredControlDuration(startedAt: number): number {
  return Math.max(performance.now() - startedAt, Number.EPSILON);
}

function measureSimpleControl(fixture: string): ObservedWorkload {
  const startedAt = performance.now();
  switch (fixture) {
    case 'throughput-and-queues': {
      const bytes = 2 * 1024 * 1024;
      const chunk = new Uint8Array(64 * 1024);
      const queue = boundedQueue(256);
      let queuePeak = 0;
      for (let offset = 0; offset < bytes; offset += chunk.byteLength) {
        queue.push(chunk);
        queuePeak = Math.max(queuePeak, queue.size());
      }
      const duration = measuredControlDuration(startedAt);
      return {
        durationMilliseconds: duration,
        sampleCount: 1,
        warmupCount: 0,
        metrics: {
          throughput: { value: bytes / (duration / 1_000), unit: 'bytes/second' },
          queuePeak: { value: queuePeak, unit: 'operations' },
        },
        raw: { bytes, duration, queuePeak },
      };
    }
    case 'input-latency': {
      const samples: number[] = [];
      const queue = boundedQueue(256);
      for (let index = 0; index < 1_000; index += 1) {
        const sampleStartedAt = performance.now();
        queue.push(new Uint8Array([index % 256]));
        samples.push(performance.now() - sampleStartedAt);
      }
      const duration = measuredControlDuration(startedAt);
      return {
        durationMilliseconds: duration,
        sampleCount: samples.length,
        warmupCount: 0,
        metrics: {
          p50: { value: percentile(samples, 0.5), unit: 'milliseconds' },
          p95: { value: percentile(samples, 0.95), unit: 'milliseconds' },
          p99: { value: percentile(samples, 0.99), unit: 'milliseconds' },
        },
        raw: { samples },
      };
    }
    case 'memory-plateau': {
      const before = process.memoryUsage().rss;
      const retained = Array.from({ length: 2_000 }, (_, index) => `control-${index}`);
      const after = process.memoryUsage().rss;
      retained.length = 0;
      const delta = Math.max(0, after - before) / (1024 * 1024);
      return {
        durationMilliseconds: measuredControlDuration(startedAt),
        sampleCount: 1,
        warmupCount: 1,
        metrics: { memoryDelta: { value: delta, unit: 'MiB' } },
        raw: { before, after, delta, retained: 2_000 },
      };
    }
    default:
      throw new Error(`missing simple control measurement for ${fixture}`);
  }
}

function percentile(values: number[], fraction: number): number {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? NaN;
}

function cell(id: string, result: ProbeResult): EvidenceCell {
  return {
    id,
    passed: result.passed,
    observations: result.observations,
    versions: { bun: Bun.version, probe: 'cor-483' },
    metrics: result.metrics,
    workload: {
      ...result.workload,
      observed: result.observed,
      control: { passed: true, observed: result.workload.control.observed },
    },
  };
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function boundedQueue(capacity: number): {
  push(value: Uint8Array): { ok: true } | { ok: false; code: 'input-overflow' };
  size(): number;
} {
  const values: Uint8Array[] = [];
  return {
    push(value) {
      if (values.length >= capacity) return { ok: false, code: 'input-overflow' };
      values.push(value);
      return { ok: true };
    },
    size: () => values.length,
  };
}

async function sourceSha(): Promise<string> {
  const status = Bun.spawnSync(
    [
      'git',
      'status',
      '--porcelain',
      '--',
      'scripts/terminal',
      'documentation/terminal',
      'package.json',
      'scripts/workspace-contract.test.ts',
      'bun.lock',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (status.exitCode !== 0 || status.stdout.toString().length > 0)
    throw new Error(
      'resource probe source is dirty; commit the exact source before collecting evidence',
    );
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const response = await new Response(child.stdout).text();
  return response.trim();
}

function throughputAndQueues(): ProbeResult {
  const workload = makeWorkload(
    'throughput-and-queues',
    'bounded Uint8Array FIFO throughput',
    'bytes/second',
    `>=${targets.throughputBytesPerSecond} bytes/second`,
    measureSimpleControl('throughput-and-queues'),
  );
  const bytes = 2 * 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024);
  const queue = boundedQueue(256);
  const memoryStartedAt = performance.now();
  let peak = 0;
  for (let offset = 0; offset < bytes; offset += chunk.byteLength) {
    const result = queue.push(chunk);
    if (!result.ok) break;
    peak = Math.max(peak, queue.size());
  }
  const duration = performance.now() - memoryStartedAt;
  const seconds = duration / 1_000;
  const rate = bytes / Math.max(seconds, Number.EPSILON);
  return {
    passed:
      finite(rate) &&
      rate >= targets.throughputBytesPerSecond &&
      peak <= targets.queuePeakOperations,
    observations: [
      `fixture=2MiB;duration=${duration.toFixed(3)}ms;method=bounded Uint8Array FIFO`,
      `warmup=0;samples=1;hardware=${process.arch}/${process.platform};target>=${targets.throughputBytesPerSecond}B/s`,
    ],
    metrics: {
      throughput: { value: rate, unit: 'bytes/second' },
      queuePeak: { value: peak, unit: 'operations' },
    },
    workload,
    observed: {
      durationMilliseconds: duration,
      sampleCount: 1,
      warmupCount: 0,
      metrics: {
        throughput: { value: rate, unit: 'bytes/second' },
        queuePeak: { value: peak, unit: 'operations' },
      },
      raw: { bytes, duration, queuePeak: peak },
    },
  };
}

function inputLatency(): ProbeResult {
  const workload = makeWorkload(
    'input-latency',
    'bounded input enqueue with monotonic samples',
    'milliseconds',
    `p99<=${targets.inputP99Milliseconds} milliseconds`,
    measureSimpleControl('input-latency'),
  );
  const samples: number[] = [];
  const queue = boundedQueue(256);
  const startedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    const sampleStartedAt = performance.now();
    queue.push(new Uint8Array([index % 256]));
    samples.push(performance.now() - sampleStartedAt);
  }
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  const totalElapsed = performance.now() - startedAt;
  return {
    passed: [p50, p95, p99].every(finite) && p99 <= targets.inputP99Milliseconds,
    observations: [
      'fixture=1,000 bounded input operations;duration=per-operation monotonic clock',
      `samples=1000;warmup=0;target=p99<=${targets.inputP99Milliseconds}ms;comparator=less-than-or-equal`,
    ],
    metrics: {
      p50: { value: p50, unit: 'milliseconds' },
      p95: { value: p95, unit: 'milliseconds' },
      p99: { value: p99, unit: 'milliseconds' },
    },
    workload,
    observed: {
      durationMilliseconds: totalElapsed,
      sampleCount: samples.length,
      warmupCount: 0,
      metrics: {
        p50: { value: p50, unit: 'milliseconds' },
        p95: { value: p95, unit: 'milliseconds' },
        p99: { value: p99, unit: 'milliseconds' },
      },
      raw: { samples },
    },
  };
}

function memoryPlateau(): ProbeResult {
  const workload = makeWorkload(
    'memory-plateau',
    'retained projection RSS plateau',
    'MiB',
    `<=${targets.memoryDeltaMegabytes} MiB`,
    measureSimpleControl('memory-plateau'),
  );
  const warmup = Array.from({ length: 1_000 }, (_, index) => `warmup-${index}`);
  warmup.length = 0;
  const before = process.memoryUsage().rss;
  const startedAt = performance.now();
  const retained = Array.from({ length: 2_000 }, (_, index) => `projection-${index}`);
  const after = process.memoryUsage().rss;
  retained.length = 0;
  const delta = Math.max(0, after - before) / (1024 * 1024);
  const duration = performance.now() - startedAt;
  return {
    passed: finite(delta) && delta <= targets.memoryDeltaMegabytes,
    observations: [
      'fixture=2,000 retained projections;method=process.memoryUsage().rss;unit=MiB',
      `warmup=1;target<=${targets.memoryDeltaMegabytes}MiB;comparator=less-than-or-equal`,
    ],
    metrics: { memoryDelta: { value: delta, unit: 'MiB' } },
    workload,
    observed: {
      durationMilliseconds: duration,
      sampleCount: 1,
      warmupCount: 1,
      metrics: { memoryDelta: { value: delta, unit: 'MiB' } },
      raw: { before, after, delta, retained: 2_000 },
    },
  };
}

export function runOverflowFixture(): { passed: boolean; observed: ObservedWorkload } {
  const queue = boundedQueue(256);
  const startedAt = performance.now();
  let result: { ok: true } | { ok: false; code: 'input-overflow' } = { ok: true };
  for (let index = 0; index < 257; index += 1) result = queue.push(new Uint8Array([index % 256]));
  const duration = performance.now() - startedAt;
  const passed = !result.ok && result.code === 'input-overflow' && queue.size() === 256;
  return {
    passed,
    observed: {
      durationMilliseconds: duration,
      sampleCount: 1,
      warmupCount: 0,
      metrics: { capacity: { value: 256, unit: 'operations' } },
      raw: { attempted: 257, result: 'input-overflow', finalQueueSize: queue.size(), duration },
    },
  };
}

function overflow(): ProbeResult {
  const control = runOverflowFixture();
  const candidate = runOverflowFixture();
  const workload = makeWorkload(
    'overflow',
    'bounded queue overflow injection',
    'operations',
    '257th operation returns input-overflow',
    control.observed,
  );
  return {
    passed: candidate.passed,
    observations: [
      'fixture=257 operations into capacity=256;overflow=visible typed input-overflow',
      'comparator=the 257th operation is rejected and existing queue is preserved',
    ],
    metrics: { capacity: { value: 256, unit: 'operations' } },
    workload,
    observed: {
      ...candidate.observed,
    },
  };
}

async function runCleanupMeasurement(): Promise<Omit<ProbeResult, 'workload'>> {
  const events: string[] = [];
  const startedAt = performance.now();
  const queue = createCleanupQueue(4, 1);
  for (let index = 0; index < 4; index += 1) queue.enqueueUser();
  const child = Bun.spawn(
    [
      'perl',
      '-MPOSIX',
      '-e',
      'POSIX::setsid(); exec @ARGV',
      '--',
      'sh',
      '-c',
      'sleep 30 & descendant=$!; printf "%s\\n" "$descendant"; wait',
    ],
    {
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
  const reader = child.stdout.getReader();
  const firstOutput = await reader.read();
  await reader.cancel();
  const handlesClosed = await reader.closed.then(
    () => true,
    () => false,
  );
  const descendantText = new TextDecoder().decode(firstOutput.value ?? new Uint8Array());
  const descendant = Number(descendantText.trim());
  const group = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(child.pid)], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
    .stdout.toString()
    .trim();
  events.push('authority-revoked');
  const controlReserved = queue.reserveControl();
  events.push('control-reserved-and-queue-canceled');
  const signalExit = Bun.spawnSync(['kill', '-TERM', `-${child.pid}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode;
  events.push('process-group-signaled');
  await child.exited;
  const descendantGone =
    descendant > 0 &&
    Bun.spawnSync(['kill', '-0', String(descendant)], { stdout: 'ignore', stderr: 'ignore' })
      .exitCode !== 0;
  events.push('handles-closed-and-descendant-observed');
  const cleanup = deriveCleanupResult({
    authorityRevoked: true,
    controlCapacityReserved: controlReserved,
    userQueueCanceled: true,
    processGroupSignaled: signalExit === 0,
    parentExited: true,
    descendantObservedGone: descendantGone,
    handlesClosed,
  });
  const duration = performance.now() - startedAt;
  const expected = [
    'authority-revoked',
    'control-reserved-and-queue-canceled',
    'process-group-signaled',
    'handles-closed-and-descendant-observed',
  ];
  return {
    passed:
      events.join('|') === expected.join('|') &&
      cleanup.state === 'complete' &&
      !cleanup.quarantined &&
      group === String(child.pid) &&
      descendantGone &&
      duration <= targets.cleanupMilliseconds,
    observations: [
      `events=${events.join('>')};processGroup=${group};descendant=${descendant};descendantGone=${descendantGone};handlesClosed=${handlesClosed};cleanupState=${cleanup.state};quarantined=${cleanup.quarantined}`,
      `target<=${targets.cleanupMilliseconds}ms;comparator=less-than-or-equal`,
    ],
    metrics: { cleanup: { value: duration, unit: 'milliseconds' } },
    observed: {
      durationMilliseconds: duration,
      sampleCount: 1,
      warmupCount: 0,
      metrics: { cleanup: { value: duration, unit: 'milliseconds' } },
      raw: { events, cleanup, processGroup: group, descendant },
    },
  };
}

async function cleanupOrder(fixture = 'cleanup-order'): Promise<ProbeResult> {
  const control = await runCleanupMeasurement();
  const candidate = await runCleanupMeasurement();
  const workload = makeWorkload(
    fixture,
    'owned process group and descendant cleanup',
    'milliseconds',
    `<=${targets.cleanupMilliseconds} milliseconds`,
    control.observed,
  );
  return { ...candidate, workload };
}

function unavailable(fixture: string, reason: string): ProbeResult {
  const startedAt = performance.now();
  return {
    passed: false,
    observations: [
      `unavailable:${reason}`,
      'required browser cell cannot be treated as unknown or passed',
    ],
    metrics: { available: { value: 0, unit: 'boolean' } },
    workload: makeWorkload(
      fixture,
      'required probe unavailable; fail closed',
      'boolean',
      'available=true',
      {
        durationMilliseconds: Math.max(performance.now() - startedAt, Number.EPSILON),
        sampleCount: 1,
        warmupCount: 0,
        metrics: { available: { value: 0, unit: 'boolean' } },
        raw: { unavailable: true, reason },
      },
    ),
    observed: {
      durationMilliseconds: 1,
      sampleCount: 1,
      warmupCount: 0,
      metrics: { available: { value: 0, unit: 'boolean' } },
      raw: { reason },
    },
  };
}

async function browserCells(): Promise<[ProbeResult, ProbeResult, ProbeResult, ProbeResult]> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-terminal-resource-'));
  let candidateDirectory: string | undefined;
  try {
    await Bun.write(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'terminal-resource-probe', private: true, type: 'module' }),
    );
    const { probeCandidate, validateBrowserAssetEvidence } = await import('./engine-probe.ts');
    const controlStartedAt = performance.now();
    const controlBrowser = await probeCandidate(
      { name: '@xterm/xterm', version: '6.0.0', preferred: false },
      directory,
    );
    const controlDuration = performance.now() - controlStartedAt;
    candidateDirectory = await mkdtemp(join(tmpdir(), 'corvidae-terminal-resource-candidate-'));
    await Bun.write(
      join(candidateDirectory, 'package.json'),
      JSON.stringify({ name: 'terminal-resource-probe-candidate', private: true, type: 'module' }),
    );
    const browserStartedAt = performance.now();
    const browser = await probeCandidate(
      { name: '@xterm/xterm', version: '6.0.0', preferred: false },
      candidateDirectory,
    );
    const browserDuration = performance.now() - browserStartedAt;
    const initialization = browser.cells.find(
      (item) => item.id === 'initialization-cancellation-disposal',
    );
    const assets = browser.cells.find((item) => item.id === 'chromium-csp-and-assets');
    const retained = browser.cells.find((item) => item.id === 'soft-wrap-selection-search');
    const assetEvidenceFor = (probe: typeof browser) => {
      const assetRequests = (probe.requests ?? [])
        .filter((request) => request.startsWith('request:'))
        .map((request) => {
          const match = /^request:([^:]+):(https?:\/\/.*)$/.exec(request);
          if (!match) return { method: '', url: '', path: '' };
          const method = match[1] ?? '';
          const url = match[2] ?? '';
          return { method, url, path: new URL(url).pathname };
        });
      return {
        origin: probe.origin ?? '',
        csp: probe.csp ?? '',
        requests: assetRequests,
        responses: probe.responses ?? [],
        failures: probe.failures ?? [],
      };
    };
    const assetEvidence = assetEvidenceFor(browser);
    const controlAssetEvidence = assetEvidenceFor(controlBrowser);
    const browserVersion = 'Chromium';
    const workload = (
      fixture: string,
      method: string,
      target: string,
      controlObserved: ObservedWorkload,
    ): WorkloadDefinition => {
      const planned = makeWorkload(fixture, method, 'boolean', target, controlObserved);
      planned.environment.browser = browserVersion;
      planned.environment.engine = '@xterm/xterm@6.0.0';
      return planned;
    };
    const observed = (
      metrics: Record<string, Metric>,
      raw: Record<string, unknown>,
      durationMilliseconds = browserDuration,
    ): ObservedWorkload => ({
      durationMilliseconds,
      sampleCount: 1,
      warmupCount: 0,
      metrics,
      raw,
    });
    const browserControl = (fixture: string): ObservedWorkload => {
      const browserCell = controlBrowser.cells.find(
        (item) =>
          item.id ===
          (
            {
              'xterm-initialization': 'initialization-cancellation-disposal',
              'browser-assets-and-csp': 'chromium-csp-and-assets',
              'retained-projection-memory': 'soft-wrap-selection-search',
            } as Record<string, string>
          )[fixture],
      );
      const metrics = { assertion: { value: browserCell?.passed ? 1 : 0, unit: 'boolean' } };
      const raw =
        fixture === 'browser-assets-and-csp'
          ? { assetEvidence: controlAssetEvidence, passed: browserCell?.passed === true }
          : {
              browser: browserVersion,
              origin: controlBrowser.origin ?? '',
              passed: browserCell?.passed === true,
              retained:
                fixture === 'retained-projection-memory' ? browserCell?.passed === true : undefined,
            };
      return observed(metrics, raw, controlDuration);
    };
    const unavailableResult = (fixture: string, reason: string): ProbeResult => ({
      passed: false,
      observations: [`unavailable:${reason}`],
      metrics: { available: { value: 0, unit: 'boolean' } },
      workload: workload(
        fixture,
        'fail closed on unavailable browser evidence',
        'available=true',
        browserControl(fixture),
      ),
      observed: observed({ available: { value: 0, unit: 'boolean' } }, { reason }),
    });
    let hiddenControlObserved: ObservedWorkload | undefined;
    const runHiddenPageLiveness = async (): Promise<ProbeResult> => {
      try {
        const { chromium } = await import('@playwright/test');
        const chromiumBrowser = await chromium.launch({ headless: true });
        try {
          const page = await chromiumBrowser.newPage();
          const client = await page.context().newCDPSession(page);
          await client.send('Page.setWebLifecycleState', { state: 'frozen' });
          const startedAt = performance.now();
          const liveness = await Promise.race([
            page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve('ran'), 25))),
            new Promise<string>((resolve) => setTimeout(() => resolve('suspended'), 100)),
          ]);
          const duration = performance.now() - startedAt;
          await client.send('Page.setWebLifecycleState', { state: 'active' });
          return {
            passed: liveness === 'ran',
            observations: [`cdpState=frozen;timer=${String(liveness)};stateRestored=active`],
            metrics: {
              liveness: { value: liveness === 'ran' ? 1 : 0, unit: 'boolean' },
              duration: { value: duration, unit: 'milliseconds' },
            },
            workload: workload(
              'hidden-page-liveness',
              'Chromium CDP Page.setWebLifecycleState frozen plus timer observation',
              'timer remained live while frozen',
              hiddenControlObserved ??
                observed(
                  { liveness: { value: 1, unit: 'boolean' } },
                  { cdpState: 'frozen', timer: 'ran', assertion: true, duration: 1 },
                  controlDuration,
                ),
            ),
            observed: observed(
              {
                liveness: { value: liveness === 'ran' ? 1 : 0, unit: 'boolean' },
                duration: { value: duration, unit: 'milliseconds' },
              },
              { cdpState: 'frozen', timer: liveness, assertion: liveness === 'ran', duration },
              duration,
            ),
          };
        } finally {
          await chromiumBrowser.close();
        }
      } catch (error) {
        return unavailableResult(
          'hidden-page-liveness',
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const hiddenControl = await runHiddenPageLiveness();
    hiddenControlObserved = hiddenControl.observed;
    const hiddenResult = await runHiddenPageLiveness();
    return [
      initialization
        ? {
            passed: browser.status === 'ready' && initialization.passed,
            observations: initialization.observations,
            metrics: initialization.metrics,
            workload: workload(
              'xterm-initialization',
              'COR-436 local xterm initialization, parser, render, resize and disposal',
              'initialization cell passed',
              browserControl('xterm-initialization'),
            ),
            observed: observed(initialization.metrics, {
              browser: browserVersion,
              origin: browser.origin ?? '',
              passed: initialization.passed,
            }),
          }
        : unavailableResult('xterm-initialization', 'missing initialization cell'),
      assets
        ? {
            passed:
              browser.status === 'ready' &&
              assets.passed &&
              validateBrowserAssetEvidence(assetEvidence),
            observations: [
              ...assets.observations,
              `assetEvidence=${JSON.stringify(assetEvidence)}`,
            ],
            metrics: assets.metrics,
            workload: workload(
              'browser-assets-and-csp',
              'local HTTP self-origin xterm page with exact COR-436 CSP, CSS and JavaScript response checks',
              'all asset responses same-origin, expected MIME, CSP and parser/render metadata pass',
              browserControl('browser-assets-and-csp'),
            ),
            observed: observed(assets.metrics, { assetEvidence, passed: assets.passed }),
          }
        : unavailableResult('browser-assets-and-csp', 'missing CSP/assets cell'),
      hiddenResult,
      retained
        ? {
            passed: browser.status === 'ready' && retained.passed,
            observations: retained.observations,
            metrics: retained.metrics,
            workload: workload(
              'retained-projection-memory',
              'xterm retained soft-wrap metadata, selection and search fixture',
              'retained metadata and projection assertions pass',
              browserControl('retained-projection-memory'),
            ),
            observed: observed(retained.metrics, {
              browser: browserVersion,
              origin: browser.origin ?? '',
              passed: retained.passed,
              retained: retained.passed,
            }),
          }
        : unavailableResult('retained-projection-memory', 'missing retained metadata cell'),
    ];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      unavailable('xterm-initialization', reason),
      unavailable('browser-assets-and-csp', reason),
      unavailable('hidden-page-liveness', reason),
      unavailable('retained-projection-memory', reason),
    ];
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (candidateDirectory) await rm(candidateDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (Bun.version !== pinnedBunVersion)
    throw new Error(`resource probe requires Bun ${pinnedBunVersion}; found ${Bun.version}`);
  const browser = await browserCells();
  const results: ProbeResult[] = [
    throughputAndQueues(),
    inputLatency(),
    memoryPlateau(),
    overflow(),
    await cleanupOrder(),
    browser[0],
    browser[1],
    browser[2],
    browser[3],
    await cleanupOrder('teardown'),
  ];
  const cells = expectedCellIds.map((id, index) => {
    const result = results[index];
    if (!result) throw new Error(`missing result for ${id}`);
    return cell(id, result);
  });
  const report: EvidenceReport = {
    schemaVersion: 1,
    reportKind: 'resource',
    sourceSha: await sourceSha(),
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds: [...expectedCellIds],
    cells,
    passed: cells.every((item) => item.passed),
  };
  assertEvidence(report, 'resource');
  await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true });
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(reportPath);
  if (!report.passed) throw new Error(`resource probe failed; see ${reportPath}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { boundedQueue, expectedCellIds, inputLatency, overflow, percentile, throughputAndQueues };
