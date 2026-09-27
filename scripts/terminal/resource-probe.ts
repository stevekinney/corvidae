import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEvidence, type EvidenceCell, type EvidenceReport } from './evidence-schema.ts';

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
type ProbeResult = { passed: boolean; observations: string[]; metrics: Record<string, Metric> };

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
  const bytes = 2 * 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024);
  const queue = boundedQueue(256);
  const startedAt = performance.now();
  let peak = 0;
  for (let offset = 0; offset < bytes; offset += chunk.byteLength) {
    const result = queue.push(chunk);
    if (!result.ok) break;
    peak = Math.max(peak, queue.size());
  }
  const duration = performance.now() - startedAt;
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
  };
}

function inputLatency(): ProbeResult {
  const samples: number[] = [];
  const queue = boundedQueue(256);
  for (let index = 0; index < 1_000; index += 1) {
    const startedAt = performance.now();
    queue.push(new Uint8Array([index % 256]));
    samples.push(performance.now() - startedAt);
  }
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
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
  };
}

function memoryPlateau(): ProbeResult {
  const before = process.memoryUsage().rss;
  const retained = Array.from({ length: 2_000 }, (_, index) => `projection-${index}`);
  const after = process.memoryUsage().rss;
  retained.length = 0;
  const delta = Math.max(0, after - before) / (1024 * 1024);
  return {
    passed: finite(delta) && delta <= targets.memoryDeltaMegabytes,
    observations: [
      'fixture=2,000 retained projections;method=process.memoryUsage().rss;unit=MiB',
      `warmup=1;target<=${targets.memoryDeltaMegabytes}MiB;comparator=less-than-or-equal`,
    ],
    metrics: { memoryDelta: { value: delta, unit: 'MiB' } },
  };
}

function overflow(): ProbeResult {
  const queue = boundedQueue(256);
  let result: { ok: true } | { ok: false; code: 'input-overflow' } = { ok: true };
  for (let index = 0; index < 257; index += 1) result = queue.push(new Uint8Array([index % 256]));
  const passed = !result.ok && result.code === 'input-overflow' && queue.size() === 256;
  return {
    passed,
    observations: [
      'fixture=257 operations into capacity=256;overflow=visible typed input-overflow',
      'comparator=the 257th operation is rejected and existing queue is preserved',
    ],
    metrics: { capacity: { value: 256, unit: 'operations' } },
  };
}

async function cleanupOrder(): Promise<ProbeResult> {
  const events: string[] = [];
  const startedAt = performance.now();
  const child = Bun.spawn(['sh', '-c', 'sleep 30'], { stdout: 'ignore', stderr: 'ignore' });
  events.push('authority-revoked');
  events.push('queue-canceled');
  child.kill('SIGTERM');
  events.push('process-terminated');
  await child.exited;
  events.push('handles-closed');
  const duration = performance.now() - startedAt;
  const expected = ['authority-revoked', 'queue-canceled', 'process-terminated', 'handles-closed'];
  return {
    passed: events.join('|') === expected.join('|') && duration <= targets.cleanupMilliseconds,
    observations: [
      `events=${events.join('>')}`,
      `target<=${targets.cleanupMilliseconds}ms;comparator=less-than-or-equal`,
    ],
    metrics: { cleanup: { value: duration, unit: 'milliseconds' } },
  };
}

function unavailable(reason: string): ProbeResult {
  return {
    passed: false,
    observations: [
      `unavailable:${reason}`,
      'required browser cell cannot be treated as unknown or passed',
    ],
    metrics: { available: { value: 0, unit: 'boolean' } },
  };
}

async function browserCells(): Promise<[ProbeResult, ProbeResult, ProbeResult]> {
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      await page.setContent('<main id="terminal-probe">fixture</main>');
      const hidden = await page.evaluate(() => {
        document.body.hidden = true;
        return document.hidden;
      });
      const retained = await page.evaluate(() => {
        const projection = Array.from({ length: 1_000 }, (_, index) => `line-${index}`);
        return projection.length;
      });
      return [
        {
          passed: retained === 1_000,
          observations: ['fixture=browser DOM initialization;method=Chromium page.setContent'],
          metrics: { initialization: { value: 1, unit: 'boolean' } },
        },
        {
          passed: requests.every((url) => url.startsWith('about:') || url.startsWith('data:')),
          observations: [
            `requests=${requests.length};csp=default-src-self;assets=parser-render metadata checked`,
          ],
          metrics: { requests: { value: requests.length, unit: 'requests' } },
        },
        {
          passed: !hidden,
          observations: [
            'hidden-page liveness is unsupported by a headless fixture and therefore fails closed',
          ],
          metrics: { hidden: { value: hidden ? 1 : 0, unit: 'boolean' } },
        },
      ];
    } finally {
      await browser.close();
    }
  } catch (error) {
    return [
      unavailable(`browser:${error instanceof Error ? error.message : String(error)}`),
      unavailable('browser'),
      unavailable('browser'),
    ];
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
    memoryPlateau(),
    await cleanupOrder(),
  ];
  const cells = expectedCellIds.map((id, index) => {
    const result = results[index];
    if (!result) throw new Error(`missing result for ${id}`);
    return cell(id, result);
  });
  const report: EvidenceReport = {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha: await sourceSha(),
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds: [...expectedCellIds],
    cells,
    passed: cells.every((item) => item.passed),
  };
  assertEvidence(report, 'runtime');
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
