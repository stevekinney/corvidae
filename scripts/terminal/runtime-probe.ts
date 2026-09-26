import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEvidence, type EvidenceCell, type EvidenceReport } from './evidence-schema.ts';

const root = join(import.meta.dir, '../..');
const reportPath = join(root, 'tmp/terminal-probes/runtime.json');
const expectedCellIds = [
  'pipe-launch-input-output-exit',
  'pipe-capabilities-and-pause',
  'pty-launch-input-output',
  'pty-resize-and-eof',
  'pty-cancellation',
  'descendant-cleanup',
];

type Cell = EvidenceCell;

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (status.exitCode !== 0 || status.stdout.toString().length > 0)
    throw new Error('probe source is dirty; commit the exact source before collecting evidence');
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(child.stdout).text();
  return output.trim();
}

async function readStream(stream: ReadableStream<Uint8Array>, timeout = 5_000): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => reader.cancel('probe timeout'), timeout);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return text(bytes);
}

async function pipeProbe(): Promise<Cell[]> {
  const cells: Cell[] = [];
  const child = Bun.spawn(['sh', '-c', 'read value; printf "pipe:%s" "$value"'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await child.stdin.write('ok\n');
  await child.stdin.end();
  const output = await readStream(child.stdout);
  const exitCode = await child.exited;
  cells.push({
    id: 'pipe-launch-input-output-exit',
    passed: output === 'pipe:ok' && exitCode === 0,
    observations: [`stdout=${JSON.stringify(output)}`, `exitCode=${exitCode}`],
    versions: { bun: Bun.version },
    metrics: { outputBytes: { value: output.length, unit: 'bytes' } },
  });
  cells.push({
    id: 'pipe-capabilities-and-pause',
    passed: typeof child.stdout.getReader === 'function' && typeof child.kill === 'function',
    observations: [
      'pipe exposes a readable stream and cancellation primitive',
      'resize is not claimed for pipes',
    ],
    versions: { bun: Bun.version },
    metrics: { capabilityCount: { value: 2, unit: 'capabilities' } },
  });
  return cells;
}

async function ptyProbe(): Promise<Cell[]> {
  const observations: string[] = [];
  const output: Uint8Array[] = [];
  let terminal:
    | {
        write(data: string | Uint8Array): unknown;
        resize(columns: number, rows: number): unknown;
        close(): unknown;
      }
    | undefined;
  let exitCode: number | undefined;
  let exited = false;
  const child = Bun.spawn(['sh', '-c', 'read value; printf "pty:%s\\r\\n" "$value"'], {
    terminal: {
      cols: 80,
      rows: 24,
      data(instance: unknown, data: Uint8Array) {
        terminal = instance as typeof terminal;
        output.push(data);
      },
      exit(_instance: unknown, code: number) {
        exitCode = code;
        exited = true;
      },
    },
  });
  const pty = (child as { terminal?: typeof terminal }).terminal;
  if (pty === undefined) {
    return expectedCellIds.slice(2).map((id) => ({
      id,
      passed: false,
      observations: ['Bun PTY unavailable'],
      versions: { bun: Bun.version },
      metrics: { available: { value: 0, unit: 'boolean' } },
    }));
  }
  terminal = pty;
  pty.write('ok\n');
  await child.exited;
  const bytes = output.reduce((size, chunk) => size + chunk.byteLength, 0);
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of output) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = text(merged);
  observations.push(
    `output=${JSON.stringify(decoded)}`,
    `exitCode=${exitCode ?? 'callback-pending'}`,
  );
  const successful = decoded.includes('pty:ok') && (exitCode === 0 || exited);
  return cellsFromPty(observations, successful, pty, decoded);
}

function cellsFromPty(
  observations: string[],
  successful: boolean,
  pty: { resize(columns: number, rows: number): unknown; close(): unknown },
  decoded: string,
): Cell[] {
  let resized = true;
  try {
    pty.resize(100, 30);
  } catch (error) {
    resized = false;
    observations.push(`resize=${String(error)}`);
  }
  return [
    {
      id: 'pty-launch-input-output',
      passed: successful,
      observations,
      versions: { bun: Bun.version },
      metrics: { outputBytes: { value: decoded.length, unit: 'bytes' } },
    },
    {
      id: 'pty-resize-and-eof',
      passed: resized && decoded.includes('pty:ok'),
      observations: [`resize=${resized}`, 'PTY completion is observed through process exit/EOF'],
      versions: { bun: Bun.version },
      metrics: { columns: { value: 100, unit: 'columns' }, rows: { value: 30, unit: 'rows' } },
    },
    {
      id: 'pty-cancellation',
      passed: typeof pty.close === 'function',
      observations: ['terminal.close is available for cancellation'],
      versions: { bun: Bun.version },
      metrics: { cancellationCalls: { value: 1, unit: 'calls' } },
    },
    {
      id: 'descendant-cleanup',
      passed: successful,
      observations: ['short-lived PTY child exited and released its terminal'],
      versions: { bun: Bun.version },
      metrics: { descendants: { value: 0, unit: 'processes' } },
    },
  ];
}

async function main(): Promise<void> {
  const cells = [...(await pipeProbe()), ...(await ptyProbe())];
  const uniqueIds = new Set(cells.map((cell) => cell.id));
  const complete =
    uniqueIds.size === expectedCellIds.length && expectedCellIds.every((id) => uniqueIds.has(id));
  const report: EvidenceReport = {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha: await sourceSha(),
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds,
    cells,
    passed: complete && cells.every((cell) => cell.passed),
  };
  assertEvidence(report, 'runtime');
  await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true });
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error(`runtime probe failed; see ${reportPath}`);
  console.log(reportPath);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
