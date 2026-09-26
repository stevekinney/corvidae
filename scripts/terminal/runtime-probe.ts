import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEvidence, type EvidenceCell, type EvidenceReport } from './evidence-schema.ts';

const root = join(import.meta.dir, '../..');
const reportPath = join(root, 'tmp/terminal-probes/runtime.json');
const expectedCellIds = ['pipe-launch-input-output-exit', 'pipe-capabilities-and-pause', 'pty-launch-input-output', 'pty-resize-and-eof', 'pty-cancellation', 'descendant-cleanup'];

async function sourceSha(): Promise<string> {
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', 'scripts/terminal', 'documentation/terminal', 'package.json', 'scripts/workspace-contract.test.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (status.exitCode !== 0 || status.stdout.toString().length > 0) throw new Error('probe source is dirty; commit the exact source before collecting evidence');
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(child.stdout).text();
  return output.trim();
}

function cell(id: string, passed: boolean, observations: string[], metric: number, unit: string): EvidenceCell { return { id, passed, observations, versions: { bun: Bun.version }, metrics: { measured: { value: metric, unit } } }; }

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; while (true) { const item = await reader.read(); if (item.done) break; chunks.push(item.value); } reader.releaseLock(); const result = new Uint8Array(chunks.reduce((sum, item) => sum + item.byteLength, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}

async function pipeProbe(): Promise<EvidenceCell[]> {
  const child = Bun.spawn(['sh', '-c', 'read value; printf "pipe:%s" "$value"; printf "err" >&2'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const outputPromise = streamBytes(child.stdout as ReadableStream<Uint8Array>); const errorPromise = streamBytes(child.stderr as ReadableStream<Uint8Array>); await child.stdin.write('ok\n'); child.stdin.end(); const [output, error, exitCode] = await Promise.all([outputPromise, errorPromise, child.exited]); const stdout = new TextDecoder().decode(output); const stderr = new TextDecoder().decode(error); const stream = child.stdout as ReadableStream<Uint8Array>; const pauseMethods = ['pause', 'resume'].filter((name) => typeof (stream as unknown as Record<string, unknown>)[name] === 'function');
  return [cell('pipe-launch-input-output-exit', stdout === 'pipe:ok' && stderr === 'err' && exitCode === 0, [`stdout=${JSON.stringify(stdout)}`, `stderr=${JSON.stringify(stderr)}`, `exitCode=${exitCode}`], stdout.length, 'bytes'), cell('pipe-capabilities-and-pause', pauseMethods.length === 0 && typeof child.kill === 'function', [`stdout/stderr=separate`, `pauseMethods=${pauseMethods.join(',') || 'none'}`, 'resize=unsupported-by-pipe'], pauseMethods.length === 0 ? 1 : 0, 'boolean')];
}

async function processIds(parent: number): Promise<number[]> { const result = await Bun.spawn(['ps', '-o', 'pid=', '--ppid', String(parent)]).stdout.text(); return result.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger); }

async function ptyProbe(): Promise<EvidenceCell[]> {
  if (process.platform === 'win32') return expectedCellIds.slice(2).map((id) => cell(id, false, ['unsupported-runtime:Bun PTY is POSIX-only'], 0, 'boolean'));
  const output: Uint8Array[] = []; let eofCode: number | undefined; let eofAt = 0; const child = Bun.spawn(['sh', '-c', 'printf "pty-ready\\r\\n"; sleep 0.15; exit 0'], { terminal: { cols: 40, rows: 10, data(_terminal, bytes) { output.push(bytes); }, exit(_terminal, code) { eofCode = code; eofAt = Date.now(); } } }); const terminal = child.terminal;
  if (!terminal) return expectedCellIds.slice(2).map((id) => cell(id, false, ['unsupported-runtime:no terminal returned'], 0, 'boolean'));
  const startedAt = Date.now(); terminal.resize(80, 24); terminal.write(''); const processExit = await child.exited; const processExitAt = Date.now(); terminal.close(); const bytes = output.reduce((sum, item) => sum + item.byteLength, 0); const text = new TextDecoder().decode(output.reduce((all, item) => new Uint8Array([...all, ...item]), new Uint8Array()));
  const cancellation = await cancelLivePty(); const descendants = await descendantCleanup();
  return [cell('pty-launch-input-output', text.includes('pty-ready') && processExit === 0, [`output=${JSON.stringify(text)}`, `processExit=${processExit}`], bytes, 'bytes'), cell('pty-resize-and-eof', terminal.closed && eofCode === 0 && eofAt > 0 && processExitAt >= eofAt, [`resize=80x24`, `ptyEofCode=${eofCode}`, `ptyEofAt=${eofAt - startedAt}ms`, `processExitAt=${processExitAt - startedAt}ms`], 80, 'columns'), cell('pty-cancellation', cancellation.passed, [cancellation.observation], cancellation.exitCode === 0 ? 0 : 1, 'boolean'), cell('descendant-cleanup', descendants.passed, [descendants.observation], descendants.remaining, 'processes')];
}

async function cancelLivePty(): Promise<{ passed: boolean; exitCode: number; observation: string }> {
  const child = Bun.spawn(['sh', '-c', 'sleep 30'], { terminal: { cols: 20, rows: 8, data() {}, exit() {} } }); const terminal = child.terminal; if (!terminal) return { passed: false, exitCode: -1, observation: 'unsupported-runtime:no terminal returned' }; terminal.close(); child.kill('SIGTERM'); const exitCode = await child.exited; return { passed: exitCode !== 0, exitCode, observation: `terminal.close plus kill cancelled live PTY; pid=${child.pid}; exitCode=${exitCode}` };
}

async function descendantCleanup(): Promise<{ passed: boolean; remaining: number; observation: string }> {
  const child = Bun.spawn(['sh', '-c', 'sleep 30 & printf "%s" $!; wait'], { terminal: { cols: 20, rows: 8, data() {}, exit() {} } }); const terminal = child.terminal; if (!terminal) return { passed: false, remaining: -1, observation: 'unsupported-runtime:no terminal returned' }; await new Promise((resolve) => setTimeout(resolve, 40)); const before = await processIds(child.pid); terminal.close(); child.kill('SIGTERM'); await child.exited; await new Promise((resolve) => setTimeout(resolve, 40)); const after = await processIds(child.pid); for (const pid of after) Bun.spawnSync(['kill', '-9', String(pid)]); return { passed: before.length > 0 && after.length === 0, remaining: after.length, observation: `parentPid=${child.pid}; descendantsBefore=${before.join(',') || 'none'}; descendantsAfter=${after.join(',') || 'none'}` };
}

async function main(): Promise<void> { const cells = [...(await pipeProbe()), ...(await ptyProbe())]; const report: EvidenceReport = { schemaVersion: 1, reportKind: 'runtime', sourceSha: await sourceSha(), runId: crypto.randomUUID(), observedAt: new Date().toISOString(), expectedCellIds, cells, passed: cells.length === expectedCellIds.length && cells.every((item) => item.passed) }; assertEvidence(report, 'runtime'); await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true }); await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(reportPath); if (!report.passed) throw new Error(`runtime probe failed; see ${reportPath}`); }
try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
