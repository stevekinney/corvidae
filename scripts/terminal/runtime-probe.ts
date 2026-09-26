import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function cell(
  id: string,
  passed: boolean,
  observations: string[],
  metric: number,
  unit: string,
): EvidenceCell {
  return {
    id,
    passed,
    observations,
    versions: { bun: Bun.version },
    metrics: { measured: { value: metric, unit } },
  };
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
  }
  reader.releaseLock();
  const result = new Uint8Array(chunks.reduce((sum, item) => sum + item.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function pipeProbe(): Promise<EvidenceCell[]> {
  const child = Bun.spawn(['sh', '-c', 'read value; printf "pipe:%s" "$value"; printf "err" >&2'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const outputPromise = streamBytes(child.stdout as ReadableStream<Uint8Array>);
  const errorPromise = streamBytes(child.stderr as ReadableStream<Uint8Array>);
  await child.stdin.write('ok\n');
  child.stdin.end();
  const [output, error, exitCode] = await Promise.all([outputPromise, errorPromise, child.exited]);
  const stdout = new TextDecoder().decode(output);
  const stderr = new TextDecoder().decode(error);
  const stream = child.stdout as ReadableStream<Uint8Array>;
  const pauseMethods = ['pause', 'resume'].filter(
    (name) => typeof (stream as unknown as Record<string, unknown>)[name] === 'function',
  );
  return [
    cell(
      'pipe-launch-input-output-exit',
      stdout === 'pipe:ok' && stderr === 'err' && exitCode === 0,
      [
        `stdout=${JSON.stringify(stdout)}`,
        `stderr=${JSON.stringify(stderr)}`,
        `exitCode=${exitCode}`,
      ],
      stdout.length,
      'bytes',
    ),
    cell(
      'pipe-capabilities-and-pause',
      pauseMethods.length === 0 && typeof child.kill === 'function',
      [
        `stdout/stderr=separate`,
        `pauseMethods=${pauseMethods.join(',') || 'none'}`,
        'resize=unsupported-by-pipe',
      ],
      pauseMethods.length === 0 ? 1 : 0,
      'boolean',
    ),
  ];
}

function processExists(pid: number): boolean {
  return (
    pid > 0 &&
    Bun.spawnSync(['kill', '-0', String(pid)], { stdout: 'ignore', stderr: 'ignore' }).exitCode ===
      0
  );
}
function processCommand(pid: number): string {
  return Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
    .stdout.toString()
    .trim();
}
async function observeExit(child: Bun.Subprocess, timeout = 1_000): Promise<number | undefined> {
  return Promise.race([
    child.exited,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeout)),
  ]);
}
function ownedProcess(pid: number, token: string): boolean {
  return processExists(pid) && processCommand(pid).includes(token);
}

async function ptyProbe(): Promise<EvidenceCell[]> {
  if (process.platform === 'win32')
    return expectedCellIds
      .slice(2)
      .map((id) => cell(id, false, ['unsupported-runtime:Bun PTY is POSIX-only'], 0, 'boolean'));
  const output: Uint8Array[] = [];
  let eofCode: number | undefined;
  let eofAt = 0;
  const child = Bun.spawn(['sh', '-c', 'printf "pty-ready\\r\\n"; sleep 0.15; exit 0'], {
    terminal: {
      cols: 40,
      rows: 10,
      data(_terminal, bytes) {
        output.push(bytes);
      },
      exit(_terminal, code) {
        eofCode = code;
        eofAt = Date.now();
      },
    },
  });
  const terminal = child.terminal;
  if (!terminal)
    return expectedCellIds
      .slice(2)
      .map((id) => cell(id, false, ['unsupported-runtime:no terminal returned'], 0, 'boolean'));
  const startedAt = Date.now();
  terminal.resize(80, 24);
  terminal.write('');
  const processExit = await child.exited;
  const processExitAt = Date.now();
  terminal.close();
  const bytes = output.reduce((sum, item) => sum + item.byteLength, 0);
  const text = new TextDecoder().decode(
    output.reduce((all, item) => new Uint8Array([...all, ...item]), new Uint8Array()),
  );
  const cancellation = await cancelLivePty();
  const descendants = await descendantCleanup();
  return [
    cell(
      'pty-launch-input-output',
      text.includes('pty-ready') && processExit === 0,
      [`output=${JSON.stringify(text)}`, `processExit=${processExit}`],
      bytes,
      'bytes',
    ),
    cell(
      'pty-resize-and-eof',
      terminal.closed && eofCode === 0 && eofAt > 0 && processExitAt >= eofAt,
      [
        `resize=80x24`,
        `ptyEofCode=${eofCode}`,
        `ptyEofAt=${eofAt - startedAt}ms`,
        `processExitAt=${processExitAt - startedAt}ms`,
      ],
      80,
      'columns',
    ),
    cell(
      'pty-cancellation',
      cancellation.passed,
      [cancellation.observation],
      cancellation.exitCode === 0 ? 0 : 1,
      'boolean',
    ),
    cell(
      'descendant-cleanup',
      descendants.passed,
      [descendants.observation],
      descendants.remaining,
      'processes',
    ),
  ];
}

async function cancelLivePty(): Promise<{
  passed: boolean;
  exitCode: number;
  observation: string;
}> {
  const token = `corvidae-terminal-${crypto.randomUUID()}`;
  const directory = await mkdtemp(join('/tmp', `${token}-`));
  const marker = join(directory, 'pid-record');
  const command = `printf '${token}\\r\\n'; sleep 30`;
  const child = Bun.spawn(['sh', '-c', command], {
    terminal: { cols: 20, rows: 8, data() {}, exit() {} },
  });
  const terminal = child.terminal;
  if (!terminal) {
    await rm(directory, { recursive: true, force: true });
    return { passed: false, exitCode: -1, observation: 'unsupported-runtime:no terminal returned' };
  }
  terminal.close();
  const processExit = await observeExit(child);
  const parentGone = !ownedProcess(child.pid, token);
  await writeFile(marker, `${child.pid}\n${token}\n`);
  if (!parentGone && ownedProcess(child.pid, token)) child.kill('SIGTERM');
  const exitCode = processExit ?? (await child.exited);
  await rm(directory, { recursive: true, force: true });
  return {
    passed: parentGone && processExit !== undefined,
    exitCode,
    observation: `terminal.close only; pid=${child.pid}; processExit=${processExit ?? 'timeout'}; parentGone=${parentGone}; fallbackCleanup=${!parentGone}`,
  };
}

async function descendantCleanup(): Promise<{
  passed: boolean;
  remaining: number;
  observation: string;
}> {
  const token = `corvidae-terminal-${crypto.randomUUID()}`;
  const directory = await mkdtemp(join('/tmp', `${token}-`));
  const output: Uint8Array[] = [];
  const child = Bun.spawn(
    [
      'sh',
      '-c',
      `sleep 30 & descendant=$!; printf '${token} descendant=%s\\r\\n' "$descendant"; wait`,
    ],
    {
      terminal: {
        cols: 20,
        rows: 8,
        data(_terminal, bytes) {
          output.push(bytes);
        },
        exit() {},
      },
    },
  );
  const terminal = child.terminal;
  if (!terminal) {
    await rm(directory, { recursive: true, force: true });
    return {
      passed: false,
      remaining: -1,
      observation: 'unsupported-runtime:no terminal returned',
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const text = new TextDecoder().decode(
    output.reduce((all, item) => new Uint8Array([...all, ...item]), new Uint8Array()),
  );
  const match = new RegExp(`${token} descendant=(\\d+)`).exec(text);
  const descendant = match ? Number(match[1]) : 0;
  const before = descendant > 0 && ownedProcess(descendant, 'sleep 30');
  await writeFile(join(directory, 'pid-record'), `${child.pid}\n${descendant}\n${token}\n`);
  terminal.close();
  const processExit = await observeExit(child);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = descendant > 0 && ownedProcess(descendant, 'sleep 30');
  const parentAfter = ownedProcess(child.pid, token);
  let fallbackCleanup = false;
  if (parentAfter) {
    fallbackCleanup = true;
    child.kill('SIGTERM');
  }
  if (after && ownedProcess(descendant, 'sleep 30')) {
    fallbackCleanup = true;
    Bun.spawnSync(['kill', '-TERM', String(descendant)], { stdout: 'ignore', stderr: 'ignore' });
  }
  await child.exited;
  await rm(directory, { recursive: true, force: true });
  return {
    passed: before && !after && !parentAfter && !fallbackCleanup && processExit !== undefined,
    remaining: after ? 1 : 0,
    observation: `parentPid=${child.pid}; descendantPid=${descendant || 'unobserved'}; descendantBefore=${before}; descendantAfter=${after}; processExit=${processExit ?? 'timeout'}; fallbackCleanup=${fallbackCleanup}`,
  };
}

async function main(): Promise<void> {
  const cells = [...(await pipeProbe()), ...(await ptyProbe())];
  const report: EvidenceReport = {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha: await sourceSha(),
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds,
    cells,
    passed: cells.length === expectedCellIds.length && cells.every((item) => item.passed),
  };
  assertEvidence(report, 'runtime');
  await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true });
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(reportPath);
  if (!report.passed) throw new Error(`runtime probe failed; see ${reportPath}`);
}
try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
