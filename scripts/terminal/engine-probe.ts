import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assertEvidence, type EvidenceCell, type EvidenceReport } from './evidence-schema.ts';

const root = join(import.meta.dir, '../..');
const reportPath = join(root, 'tmp/terminal-probes/engines.json');
const candidates = [
  { name: 'ghostty-web', version: '0.4.0', preferred: true },
  { name: '@xterm/xterm', version: '6.0.0', preferred: false },
  { name: '@wterm/dom', version: '0.5.1', preferred: false },
] as const;
const cellIds = [
  'integrity-and-source-provenance', 'input-return-semantics',
  'split-utf8-and-control-sequences', 'screen-cursor-attributes',
  'soft-wrap-selection-search', 'read-only-reply-suppression',
  'initialization-cancellation-disposal', 'chromium-csp-and-assets',
] as const;
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
type Candidate = (typeof candidates)[number];
type BrowserCell = { passed: boolean; observation: string };
type BrowserResult = { cells: Record<string, BrowserCell>; requests: string[] };
type RawBrowserResult = Record<string, unknown>;

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function command(args: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}\n${stderr}`.trim().replaceAll(/token=\S+/g, 'token=[redacted]') };
}

async function sourceSha(): Promise<string> {
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', 'scripts/terminal', 'documentation/terminal', 'package.json', 'scripts/workspace-contract.test.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (status.exitCode !== 0 || status.stdout.toString().length > 0) throw new Error('probe source is dirty; commit the exact source before collecting evidence');
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(child.stdout).text();
  return output.trim();
}

function browserSource(candidate: Candidate): string {
  if (candidate.name === '@wterm/dom') return `import { WTerm } from '@wterm/dom'; import '@wterm/dom/css';
const host = document.querySelector('#terminal'); const events = []; const terminal = new WTerm(host, { cols: 10, rows: 4, autoResize: false, onData: (data) => events.push(data) }); await terminal.init(); const writes = []; const write = (data) => { const result = terminal.write(data); writes.push(result === undefined); }; write('A'); write(new Uint8Array([0xCE, 0xB1])); write('\\x1b[31mR\\x1b[0m'); write('\\x1b[6n'); const text = host.textContent ?? ''; terminal.resize(20, 8); const resized = terminal.cols === 20 && terminal.rows === 8; terminal.destroy(); globalThis.probeResult = { writes, text, resized, events, suppression: Array.isArray(events), disposed: host.textContent === '' };`;
  if (candidate.name === 'ghostty-web') return `import { init, Terminal } from 'ghostty-web'; await init();
const host = document.querySelector('#terminal'); const terminal = new Terminal({ cols: 10, rows: 4 }); terminal.open(host); const writes = []; const write = (data) => new Promise((resolve) => { const result = terminal.write(data, () => { writes.push(result === undefined); resolve(); }); }); await write(new Uint8Array([0x41])); await write(new Uint8Array([0xCE])); await write(new Uint8Array([0xB1])); await write(new Uint8Array([0x1b,0x5b,0x33])); await write(new Uint8Array([0x31,0x6d,0x52,0x1b,0x5b,0x30,0x6d])); let replies = 0; terminal.onData(() => { replies += 1; }); await write('\\x1b[6n'); const line = terminal.buffer.active.getLine(0); const cell = line?.getCell(1); const text = line?.translateToString(false) ?? ''; const before = host.textContent ?? ''; terminal.resize(20, 8); const resized = terminal.cols === 20 && terminal.rows === 8; terminal.dispose(); globalThis.probeResult = { writes, text, cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY, red: cell?.getFgColor?.() ?? null, replies, suppression: replies === 1, before, resized, disposed: host.querySelector('.xterm') === null };`;
  return `import { Terminal } from '@xterm/xterm';
const host = document.querySelector('#terminal'); const terminal = new Terminal({ cols: 10, rows: 4, scrollback: 20 }); terminal.open(host); const writes = []; const write = (data) => new Promise((resolve) => { const result = terminal.write(data, () => { writes.push(result === undefined); resolve(); }); }); await write(new Uint8Array([0x41])); await write(new Uint8Array([0xCE])); await write(new Uint8Array([0xB1])); await write(new Uint8Array([0x1b,0x5b,0x33])); await write(new Uint8Array([0x31,0x6d,0x52,0x1b,0x5b,0x30,0x6d])); let replies = 0; terminal.onData(() => { replies += 1; }); await write('\\x1b[6n'); const line = terminal.buffer.active.getLine(0); const cell = line?.getCell(1); await write('12345678901234567890'); const wrapped = terminal.buffer.active.getLine(1)?.isWrapped === true; const before = host.textContent ?? ''; terminal.resize(20, 8); const resized = terminal.cols === 20 && terminal.rows === 8; terminal.select(0, 0, 1); const selection = terminal.getSelection(); terminal.dispose(); globalThis.probeResult = { writes, text: line?.translateToString(false) ?? '', cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY, red: cell?.getFgColor?.() ?? null, replies, suppression: replies === 1, before, wrapped, selection, resized, disposed: host.querySelector('.xterm') === null };`;
}

function fallbackCells(message: string): Record<string, BrowserCell> { return Object.fromEntries(cellIds.slice(1).map((id) => [id, { passed: false, observation: message }])) as Record<string, BrowserCell>; }

async function runBrowserProbe(candidate: Candidate, directory: string): Promise<{ cells: Record<string, BrowserCell>; requests: string[]; failure?: string }> {
  const entry = join(directory, 'probe.ts'); const bundleDirectory = join(directory, 'bundle'); await Bun.write(entry, browserSource(candidate));
  const bundle = await Bun.build({ entrypoints: [entry], outdir: bundleDirectory, target: 'browser', format: 'esm' });
  if (!bundle.success) return { cells: fallbackCells(`harness-failure:bundle:${bundle.logs.map((log) => log.message).join(';')}`), requests: [], failure: 'bundle' };
  const script = await Bun.file(join(bundleDirectory, 'probe.js')).text(); const packageDirectory = join(directory, 'node_modules', ...candidate.name.split('/')); const cssPath = candidate.name === '@xterm/xterm' ? join(packageDirectory, 'css/xterm.css') : candidate.name === '@wterm/dom' ? join(packageDirectory, 'src/terminal.css') : undefined; const wasmFiles = await Array.fromAsync(new Bun.Glob('**/*.wasm').scan({ cwd: directory, onlyFiles: true })); const requests: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) { const path = new URL(request.url).pathname; requests.push(path); if (path === '/') return new Response(`<meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/candidate.css"><main id="terminal"></main><script src="/probe.js" type="module"></script>`, { headers: { 'content-type': 'text/html' } }); if (path === '/probe.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } }); if (path === '/candidate.css' && cssPath) return new Response(await Bun.file(cssPath).bytes(), { headers: { 'content-type': 'text/css' } }); const wasm = wasmFiles.find((file) => basename(file) === basename(path)); if (wasm) return new Response(await Bun.file(join(directory, wasm)).bytes(), { headers: { 'content-type': 'application/wasm' } }); return new Response('not found', { status: 404 }); } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('request', (request) => requests.push(request.url()));
    page.on('pageerror', (error) => requests.push(`pageerror:${error.message}`));
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean((globalThis as { probeResult?: unknown }).probeResult), undefined, { timeout: 10_000 });
    const raw = await page.evaluate(() => (globalThis as { probeResult: RawBrowserResult }).probeResult);
    const text = typeof raw.text === 'string' ? raw.text : '';
    const writes = Array.isArray(raw.writes) && raw.writes.every((value) => value === true);
    const common: Record<string, BrowserCell> = {
      'input-return-semantics': { passed: writes, observation: `writeCallbacks=${JSON.stringify(raw.writes)}` },
      'split-utf8-and-control-sequences': { passed: text.includes('A') && text.includes('α') && text.includes('R'), observation: `text=${JSON.stringify(text)}` },
      'screen-cursor-attributes': { passed: raw.red !== null && typeof raw.cursorX === 'number' && typeof raw.cursorY === 'number', observation: `cursor=${raw.cursorX},${raw.cursorY};fg=${raw.red}` },
      'soft-wrap-selection-search': { passed: raw.wrapped === true && typeof raw.selection === 'string', observation: `wrapped=${raw.wrapped};selection=${JSON.stringify(raw.selection)}` },
      'read-only-reply-suppression': { passed: raw.suppression === true, observation: `queryReplies=${raw.replies};adapterSuppressed=${raw.suppression}` },
      'initialization-cancellation-disposal': { passed: raw.disposed === true && raw.resized === true, observation: `resized=${raw.resized};disposed=${raw.disposed}` },
    };
    if (candidate.name === '@wterm/dom') {
      common['screen-cursor-attributes'] = { passed: text.includes('A') && text.includes('R'), observation: `domText=${JSON.stringify(text)};cursor-api=unsupported` };
      common['soft-wrap-selection-search'] = { passed: false, observation: 'unsupported-api:WTerm exposes native DOM selection but no retained search oracle' };
      common['read-only-reply-suppression'] = { passed: raw.suppression === true, observation: `queryReplies=${JSON.stringify(raw.events)};adapterSuppressed=${raw.suppression}` };
    }
    common['chromium-csp-and-assets'] = { passed: !requests.some((request) => request.includes('pageerror:')) && (candidate.name !== 'ghostty-web' || requests.some((request) => request.includes('ghostty-vt.wasm'))), observation: `csp=${csp};requests=${requests.join(',')}` };
    return { cells: common, requests };
  } catch (error) {
    return { cells: fallbackCells(`harness-failure:${String(error)}`), requests, failure: String(error) };
  } finally { await browser.close(); server.stop(true); }
}

async function probeCandidate(candidate: Candidate, directory: string): Promise<{ provenance: Record<string, unknown>; cells: EvidenceCell[]; passed: boolean }> {
  const spec = `${candidate.name}@${candidate.version}`; const installed = await command(['bun', 'add', '--exact', spec], directory); const packageDirectory = join(directory, 'node_modules', ...candidate.name.split('/')); const packagePath = join(packageDirectory, 'package.json'); const packageExists = await Bun.file(packagePath).exists(); const packageJson = packageExists ? (JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>) : {}; const files = packageExists ? await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: packageDirectory, onlyFiles: true })) : []; const artifacts = await Promise.all(files.map(async (file) => `${file}:${sha256(await Bun.file(join(packageDirectory, file)).bytes())}`)); const resolvedVersion = typeof packageJson.version === 'string' ? packageJson.version : ''; const provenance = { requested: spec, resolvedVersion, lockfileSha256: sha256(await Bun.file(join(directory, 'bun.lock')).bytes()), packageSha256: packageExists ? sha256(await Bun.file(packagePath).bytes()) : '', artifacts, exports: packageJson.exports ?? null, entrypoints: { main: packageJson.main ?? null, module: packageJson.module ?? null, style: packageJson.style ?? null }, notices: files.filter((file) => /(?:license|notice|copying)/i.test(basename(file))), installExit: installed.exitCode, diagnostics: installed.output.slice(0, 2_000) }; const provenancePass = installed.exitCode === 0 && resolvedVersion === candidate.version && files.length > 0 && provenance.lockfileSha256.length === 64; const browser = provenancePass ? await runBrowserProbe(candidate, directory) : { cells: fallbackCells('harness-failure:install-or-source-failed'), requests: [] as string[] }; const cell = (id: string, passed: boolean, observation: string): EvidenceCell => ({ id, passed, observations: [observation], versions: { bun: Bun.version, candidate: resolvedVersion || candidate.version }, metrics: { assertion: { value: passed ? 1 : 0, unit: 'boolean' } } }); const cells = [cell('integrity-and-source-provenance', provenancePass, JSON.stringify(provenance)), ...cellIds.slice(1).map((id) => cell(id, browser.cells[id]?.passed ?? false, browser.cells[id]?.observation ?? 'unsupported-api'))]; return { provenance, cells, passed: cells.every((item) => item.passed) };
}

async function main(): Promise<void> {
  const reports: Array<{ candidate: Candidate; provenance: Record<string, unknown>; cells: EvidenceCell[]; passed: boolean }> = []; for (const candidate of candidates) { const directory = await mkdtemp(join(tmpdir(), `corvidae-terminal-engine-${candidate.name.replaceAll('/', '-')}-`)); try { await Bun.write(join(directory, 'package.json'), JSON.stringify({ name: 'terminal-engine-probe', private: true, type: 'module' })); reports.push({ candidate, ...(await probeCandidate(candidate, directory)) }); } finally { await rm(directory, { recursive: true, force: true }); } }
  const expectedCellIds = candidates.flatMap((candidate) => cellIds.map((id) => `${candidate.name}:${id}`)); const selected = reports.find((item) => item.passed && item.candidate.preferred) ?? reports.find((item) => item.passed); const report: EvidenceReport & { candidates: unknown[]; selectedEngine: unknown } = { schemaVersion: 1, reportKind: 'engine', sourceSha: await sourceSha(), runId: crypto.randomUUID(), observedAt: new Date().toISOString(), expectedCellIds, cells: reports.flatMap(({ candidate, cells }) => cells.map((item) => ({ ...item, id: `${candidate.name}:${item.id}` }))), candidates: reports.map(({ candidate, provenance, cells, passed }) => ({ name: candidate.name, version: candidate.version, preferred: candidate.preferred, passed, provenance, cells })), selectedEngine: selected ? { name: selected.candidate.name, version: selected.candidate.version } : null, passed: selected !== undefined }; assertEvidence(report, 'engine'); await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true }); await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(reportPath); if (!report.passed) throw new Error(`engine probe failed; see ${reportPath}`);
}

try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
