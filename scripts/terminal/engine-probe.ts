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
  'integrity-and-source-provenance',
  'input-return-semantics',
  'split-utf8-and-control-sequences',
  'screen-cursor-attributes',
  'soft-wrap-selection-search',
  'read-only-reply-suppression',
  'initialization-cancellation-disposal',
  'chromium-csp-and-assets',
] as const;
const baseCsp =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const cspFor = (candidate: Candidate): string => {
  if (candidate.name === 'ghostty-web' || candidate.name === '@wterm/dom')
    return `${baseCsp}; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`;
  return candidate.name === '@xterm/xterm'
    ? acceptedXtermCsp
    : `${baseCsp}; script-src 'self'; connect-src 'self'`;
};
type Candidate = (typeof candidates)[number];
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type BrowserCell = { passed: boolean; observation: string };
type BrowserResult = {
  cells: Record<string, BrowserCell>;
  requests: string[];
  status: 'ready' | 'unavailable';
  diagnostics: string[];
  origin?: string;
  csp?: string;
  responses?: Array<{ url: string; status: number; contentType: string }>;
  failures?: string[];
};

export type BrowserAssetEvidence = {
  origin: string;
  csp: string;
  requests: Array<{ method: string; url: string; path: string }>;
  responses: Array<{ url: string; status: number; contentType: string }>;
  failures: string[];
};

const acceptedXtermCsp =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'";

export function validateBrowserAssetEvidence(evidence: BrowserAssetEvidence): boolean {
  if (evidence.csp !== acceptedXtermCsp || evidence.failures.length > 0) return false;
  const expected = new Map([
    ['/', 'text/html'],
    ['/candidate.css', 'text/css'],
    ['/probe.js', 'text/javascript'],
  ]);
  const origin = evidence.origin.replace(/\/$/, '');
  if (evidence.requests.length !== expected.size || evidence.responses.length !== expected.size)
    return false;
  if (
    evidence.requests.some(
      (request) =>
        request.method !== 'GET' ||
        !request.url.startsWith(`${origin}/`) ||
        !expected.has(request.path) ||
        new URL(request.url).origin !== origin,
    )
  )
    return false;
  return evidence.responses.every((response) => {
    const path = new URL(response.url).pathname;
    return (
      new URL(response.url).origin === origin &&
      response.status === 200 &&
      expected.get(path) === response.contentType.split(';', 1)[0]?.trim()
    );
  });
}
type RawBrowserResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function command(args: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    output: `${stdout}\n${stderr}`.trim().replaceAll(/token=\S+/g, 'token=[redacted]'),
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
    throw new Error('probe source is dirty; commit the exact source before collecting evidence');
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(child.stdout).text();
  return output.trim();
}

function browserSource(candidate: Candidate): string {
  if (candidate.name === '@wterm/dom')
    return `import { WTerm } from '@wterm/dom'; import '@wterm/dom/css';
globalThis.probePhase = 'module-loaded'; const host = document.querySelector('#terminal'); const events = []; const terminal = new WTerm(host, { cols: 10, rows: 4, autoResize: false, onData: (data) => events.push(data) }); globalThis.probePhase = 'before-init'; await terminal.init(); globalThis.probePhase = 'after-init'; const writes = []; const write = (data) => { const result = terminal.write(data); writes.push(result === undefined); }; write('A'); write(new Uint8Array([0xCE])); write(new Uint8Array([0xB1])); write('\\x1b[3'); write('1mR'); write('\\x1b[0m'); write('\\x1b[6n'); const text = host.textContent ?? ''; terminal.resize(20, 8); const readText = await terminal.readText(); terminal.search('A'); await new Promise((resolve) => setTimeout(resolve, 50)); const search = terminal.getSearchState().count > 0; const resized = terminal.cols === 20 && terminal.rows === 8; const cursorX = terminal.cursorX; const cursorY = terminal.cursorY; const attributes = terminal.getCell?.(0, 0) ?? null; const replyCount = events.length; const replyPayload = events[0] ?? null; const suppression = replyCount === 1 && replyPayload === '\\x1b[1;4R'; terminal.destroy(); globalThis.probeResult = { writes, text: readText, readText, search, resized, events, replyCount, replyPayload, suppression, cursorX, cursorY, attributes, operationCancelled: false, disposed: host.textContent === '' };`;
  if (candidate.name === 'ghostty-web')
    return `import { Ghostty, Terminal } from 'ghostty-web';
globalThis.probePhase = 'module-loaded'; globalThis.probePhase = 'before-init'; const ghostty = await Ghostty.load('/ghostty-vt.wasm'); globalThis.probePhase = 'after-init'; const host = document.querySelector('#terminal'); const terminal = new Terminal({ cols: 10, rows: 4, ghostty }); terminal.open(host); globalThis.probePhase = 'opened'; const writes = []; const write = (data) => new Promise((resolve) => { const result = terminal.write(data, () => { writes.push(result === undefined); resolve(); }); }); await write(new Uint8Array([0x41])); await write(new Uint8Array([0xCE])); await write(new Uint8Array([0xB1])); await write(new Uint8Array([0x1b,0x5b,0x33])); await write(new Uint8Array([0x31,0x6d,0x52,0x1b,0x5b,0x30,0x6d])); let replies = 0; terminal.onData(() => { replies += 1; }); await write('\\x1b[6n'); const line = terminal.buffer.active.getLine(0); const cell = line?.getCell(1); const text = line?.translateToString(false) ?? ''; const softWrapMetadata = typeof line?.isWrapped === 'boolean' && line.isWrapped; terminal.resize(20, 8); const resized = terminal.cols === 20 && terminal.rows === 8; let operationSettled = false; const pendingOperation = new Promise((resolve) => terminal.write('cancel-me', () => { operationSettled = true; resolve(); })); const pendingAtDispose = !operationSettled; terminal.dispose(); const operationCancelled = pendingAtDispose && await Promise.race([pendingOperation.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]); globalThis.probeResult = { writes, text, cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY, red: cell?.getFgColor?.() ?? null, replies, suppression: replies === 1, softWrapMetadata, before: text, resized, operationCancelled, disposed: host.querySelector('.xterm') === null };`;
  return `import { Terminal } from '@xterm/xterm';
globalThis.probePhase = 'module-loaded';
const host = document.querySelector('#terminal'); const terminal = new Terminal({ cols: 10, rows: 4, scrollback: 20 }); terminal.open(host); const writes = []; const write = (data) => new Promise((resolve) => { const result = terminal.write(data, () => { writes.push(result === undefined); resolve(); }); }); await write(new Uint8Array([0x41])); await write(new Uint8Array([0xCE])); await write(new Uint8Array([0xB1])); await write(new Uint8Array([0x1b,0x5b,0x33])); await write(new Uint8Array([0x31,0x6d,0x52,0x1b,0x5b,0x30,0x6d])); let replies = 0; terminal.onData(() => { replies += 1; }); await write('\\x1b[6n'); const line = terminal.buffer.active.getLine(0); const cell = line?.getCell(2); await write('12345678901234567890'); const wrapped = terminal.buffer.active.getLine(1)?.isWrapped === true; const before = host.textContent ?? ''; const retainedText = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('').replaceAll(' ', ''); terminal.resize(20, 8); const resized = terminal.cols === 20 && terminal.rows === 8; terminal.select(0, 0, 1); const selection = terminal.getSelection(); const literalSearch = retainedText.includes('12345678901234567890'); let operationSettled = false; const pendingOperation = new Promise((resolve) => terminal.write('cancel-me', () => { operationSettled = true; resolve(); })); const pendingAtDispose = !operationSettled; terminal.dispose(); const operationCancelled = pendingAtDispose && await Promise.race([pendingOperation.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]); globalThis.probeResult = { writes, text: line?.translateToString(false) ?? '', cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY, red: cell?.getFgColor?.() ?? null, replies, suppression: replies === 1, before, wrapped, selection, literalSearch, resized, operationCancelled, disposed: host.querySelector('.xterm') === null };`;
}

function fallbackCells(message: string): Record<string, BrowserCell> {
  return Object.fromEntries(
    cellIds.slice(1).map((id) => [id, { passed: false, observation: message }]),
  );
}

function formatUnknown(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? typeof value : json;
}

export async function classifyBrowserFailure(
  readPhase: () => Promise<unknown>,
  error: unknown,
  requests: string[],
  diagnostics: string[],
): Promise<BrowserResult> {
  const message = String(error);
  const kind = message.includes('TimeoutError') ? 'timeout' : 'harness-failure';
  const phase = await readPhase().catch(() => 'page-unavailable');
  const phaseText = formatUnknown(phase);
  diagnostics.push(`phase:${phaseText}`);
  return {
    cells: fallbackCells(`unavailable:${kind}:${phaseText}:${message}`),
    requests,
    status: 'unavailable',
    diagnostics,
  };
}

async function runBrowserProbe(candidate: Candidate, directory: string): Promise<BrowserResult> {
  const entry = join(directory, 'probe.ts');
  const bundleDirectory = join(directory, 'bundle');
  await Bun.write(entry, browserSource(candidate));
  const bundle = await Bun.build({
    entrypoints: [entry],
    outdir: bundleDirectory,
    target: 'browser',
    format: 'esm',
  });
  if (!bundle.success)
    return {
      cells: fallbackCells(`unavailable:bundle:${bundle.logs.map((log) => log.message).join(';')}`),
      requests: [],
      status: 'unavailable',
      diagnostics: ['bundle failure'],
    };
  const script = await Bun.file(join(bundleDirectory, 'probe.js')).text();
  const packageDirectory = join(directory, 'node_modules', ...candidate.name.split('/'));
  const cssPath =
    candidate.name === '@xterm/xterm'
      ? join(packageDirectory, 'css/xterm.css')
      : candidate.name === '@wterm/dom'
        ? join(directory, 'node_modules/@wterm/dom/src/terminal.css')
        : undefined;
  const wasmFiles = await Array.fromAsync(
    new Bun.Glob('**/*.wasm').scan({ cwd: directory, onlyFiles: true }),
  );
  const requests: string[] = [];
  const diagnostics: string[] = [];
  const responses: Array<{ url: string; status: number; contentType: string }> = [];
  const failures: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return new Response(
          `<!doctype html>${cssPath ? '<link rel="stylesheet" href="/candidate.css">' : ''}<main id="terminal"></main><script src="/probe.js" type="module"></script>`,
          {
            headers: { 'content-type': 'text/html', 'content-security-policy': cspFor(candidate) },
          },
        );
      if (path === '/probe.js')
        return new Response(script, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/candidate.css' && cssPath)
        return new Response(await Bun.file(cssPath).bytes(), {
          headers: { 'content-type': 'text/css' },
        });
      const wasm =
        candidate.name === 'ghostty-web' && path === '/ghostty-vt.wasm'
          ? wasmFiles.find((file) => basename(file) === 'ghostty-vt.wasm')
          : undefined;
      if (wasm)
        return new Response(await Bun.file(join(directory, wasm)).bytes(), {
          headers: { 'content-type': 'application/wasm' },
        });
      return new Response('not found', { status: 404 });
    },
  });
  let browser: Browser | undefined;
  let page: Awaited<ReturnType<Browser['newPage']>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on('request', (request) => requests.push(`request:${request.method()}:${request.url()}`));
    page.on('response', (response) => {
      const contentType = response.headers()['content-type'] ?? '';
      responses.push({ url: response.url(), status: response.status(), contentType });
      diagnostics.push(`response:${response.status()}:${contentType}:${response.url()}`);
    });
    page.on('console', (message) =>
      diagnostics.push(`console:${message.type()}:${message.text()}`),
    );
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`));
    page.on('requestfailed', (request) => {
      const failure = `requestfailed:${request.url()}:${request.failure()?.errorText ?? 'unknown'}`;
      failures.push(failure);
      diagnostics.push(failure);
    });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => Boolean((globalThis as { probeResult?: unknown }).probeResult),
      undefined,
      { timeout: 10_000 },
    );
    const rawValue = await page.evaluate(
      () => (globalThis as typeof globalThis & { probeResult?: unknown }).probeResult,
    );
    const raw: RawBrowserResult = isRecord(rawValue) ? rawValue : Object.fromEntries([]);
    const text = typeof raw['text'] === 'string' ? raw['text'] : '';
    const writes = Array.isArray(raw['writes']) && raw['writes'].every((value) => value === true);
    const common: Record<string, BrowserCell> = {
      'input-return-semantics': {
        passed: writes,
        observation: `writeCallbacks=${JSON.stringify(raw['writes'])}`,
      },
      'split-utf8-and-control-sequences': {
        passed: text.includes('A') && text.includes('α') && text.includes('R'),
        observation: `text=${JSON.stringify(text)}`,
      },
      'screen-cursor-attributes': {
        passed:
          raw['red'] !== null &&
          typeof raw['cursorX'] === 'number' &&
          typeof raw['cursorY'] === 'number',
        observation: `cursor=${formatUnknown(raw['cursorX'])},${formatUnknown(raw['cursorY'])};fg=${formatUnknown(raw['red'])}`,
      },
      'soft-wrap-selection-search': {
        passed:
          raw['wrapped'] === true && raw['selection'] === 'A' && raw['literalSearch'] === true,
        observation: `wrapped=${formatUnknown(raw['wrapped'])};selection=${formatUnknown(raw['selection'])};literalSearch=${formatUnknown(raw['literalSearch'])}`,
      },
      'read-only-reply-suppression': {
        passed: raw['suppression'] === true,
        observation: `queryReplies=${formatUnknown(raw['replies'])};adapterSuppressed=${formatUnknown(raw['suppression'])}`,
      },
      'initialization-cancellation-disposal': {
        passed:
          raw['disposed'] === true && raw['resized'] === true && raw['operationCancelled'] === true,
        observation: `resized=${formatUnknown(raw['resized'])};operationCancelled=${formatUnknown(raw['operationCancelled'])};disposed=${formatUnknown(raw['disposed'])}`,
      },
    };
    if (candidate.name === '@wterm/dom') {
      common['screen-cursor-attributes'] = {
        passed:
          typeof raw['cursorX'] === 'number' &&
          typeof raw['cursorY'] === 'number' &&
          raw['attributes'] !== null,
        observation: `domText=${JSON.stringify(text)};cursor=${formatUnknown(raw['cursorX'])},${formatUnknown(raw['cursorY'])};attributes=${formatUnknown(raw['attributes'])}`,
      };
      common['soft-wrap-selection-search'] = {
        passed: raw['search'] === true && typeof raw['readText'] === 'string',
        observation: `readText=${formatUnknown(raw['readText'])};search=${formatUnknown(raw['search'])};retained-dom=virtualized`,
      };
      common['read-only-reply-suppression'] = {
        passed:
          raw['suppression'] === true &&
          raw['replyCount'] === 1 &&
          raw['replyPayload'] === '\u001b[1;1R',
        observation: `queryReplies=${formatUnknown(raw['replyCount'])};replyPayload=${formatUnknown(raw['replyPayload'])};adapterSuppressed=${formatUnknown(raw['suppression'])}`,
      };
    }
    if (candidate.name === '@xterm/xterm')
      common['screen-cursor-attributes'] = {
        passed: raw['cursorX'] === 12 && raw['cursorY'] === 2 && raw['red'] === 1,
        observation: `cursor=${formatUnknown(raw['cursorX'])},${formatUnknown(raw['cursorY'])};fg=${formatUnknown(raw['red'])}`,
      };
    if (candidate.name === 'ghostty-web')
      common['soft-wrap-selection-search'] = {
        passed: false,
        observation: `hard-gate:soft-wrap-metadata-untrustworthy;observed=${formatUnknown(raw['softWrapMetadata'])}`,
      };
    const assetRequests = requests
      .filter((request) => request.startsWith('request:'))
      .map((request) => {
        const match = /^request:([^:]+):(https?:\/\/.*)$/.exec(request);
        if (!match) return { method: '', url: '', path: '' };
        const [, method, url] = match;
        return { method, url, path: new URL(url).pathname };
      });
    const assetEvidence: BrowserAssetEvidence = {
      origin: new URL(`http://127.0.0.1:${server.port}`).origin,
      csp: cspFor(candidate),
      requests: assetRequests,
      responses,
      failures,
    };
    common['chromium-csp-and-assets'] = {
      passed:
        candidate.name === '@xterm/xterm'
          ? validateBrowserAssetEvidence(assetEvidence)
          : diagnostics.every(
              (item) =>
                !item.startsWith('pageerror:') &&
                !item.startsWith('requestfailed:') &&
                !item.startsWith('console:warning:') &&
                !item.startsWith('console:error:'),
            ) &&
            (candidate.name === 'ghostty-web' || requests.includes('/candidate.css')) &&
            (candidate.name !== 'ghostty-web' || requests.includes('/ghostty-vt.wasm')),
      observation: `csp=${cspFor(candidate)};requests=${requests.join(',')};responses=${JSON.stringify(responses)};diagnostics=${diagnostics.join('|')}`,
    };
    return {
      cells: common,
      requests,
      status: 'ready',
      diagnostics,
      origin: assetEvidence.origin,
      csp: assetEvidence.csp,
      responses,
      failures,
    };
  } catch (error) {
    return classifyBrowserFailure(
      () =>
        page
          ? page.evaluate(
              () => (globalThis as { probePhase?: unknown }).probePhase ?? 'not-started',
            )
          : Promise.resolve('page-unavailable'),
      error,
      requests,
      diagnostics,
    );
  } finally {
    if (browser) await browser.close();
    await server.stop(true);
  }
}

export async function probeCandidate(
  candidate: Candidate,
  directory: string,
): Promise<{
  provenance: Record<string, unknown>;
  cells: EvidenceCell[];
  passed: boolean;
  status: BrowserResult['status'];
  diagnostics: string[];
  origin?: string;
  csp?: string;
  requests?: string[];
  responses?: Array<{ url: string; status: number; contentType: string }>;
  failures?: string[];
}> {
  const spec = `${candidate.name}@${candidate.version}`;
  const installed = await command(['bun', 'add', '--exact', spec], directory);
  const packageDirectory = join(directory, 'node_modules', ...candidate.name.split('/'));
  const packagePath = join(packageDirectory, 'package.json');
  const lockfilePath = join(directory, 'bun.lock');
  const packageExists = await Bun.file(packagePath).exists();
  const lockfileExists = await Bun.file(lockfilePath).exists();
  const packageJson: Record<string, unknown> = packageExists
    ? JSON.parse(await readFile(packagePath, 'utf8'))
    : {};
  const files = packageExists
    ? await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: packageDirectory, onlyFiles: true }))
    : [];
  const artifacts = await Promise.all(
    files.map(
      async (file) => `${file}:${sha256(await Bun.file(join(packageDirectory, file)).bytes())}`,
    ),
  );
  const resolvedVersion = typeof packageJson['version'] === 'string' ? packageJson['version'] : '';
  const provenance = {
    requested: spec,
    resolvedVersion,
    lockfileSha256: lockfileExists ? sha256(await Bun.file(lockfilePath).bytes()) : '',
    packageSha256: packageExists ? sha256(await Bun.file(packagePath).bytes()) : '',
    artifacts,
    exports: packageJson['exports'] ?? null,
    entrypoints: {
      main: packageJson['main'] ?? null,
      module: packageJson['module'] ?? null,
      style: packageJson['style'] ?? null,
    },
    notices: files.filter((file) => /(?:license|notice|copying)/i.test(basename(file))),
    installExit: installed.exitCode,
    diagnostics: installed.output.slice(0, 2_000),
  };
  const provenancePass =
    installed.exitCode === 0 &&
    resolvedVersion === candidate.version &&
    files.length > 0 &&
    lockfileExists &&
    provenance.lockfileSha256.length === 64;
  const browser: BrowserResult = provenancePass
    ? await runBrowserProbe(candidate, directory)
    : {
        cells: fallbackCells('unavailable:install-or-source-failed'),
        requests: [],
        status: 'unavailable',
        diagnostics: [installed.output],
      };
  const cell = (id: string, passed: boolean, observation: string): EvidenceCell => ({
    id,
    passed,
    observations: [observation],
    versions: { bun: Bun.version, candidate: resolvedVersion || candidate.version },
    metrics: { assertion: { value: passed ? 1 : 0, unit: 'boolean' } },
  });
  const cells = [
    cell('integrity-and-source-provenance', provenancePass, JSON.stringify(provenance)),
    ...cellIds
      .slice(1)
      .map((id) =>
        cell(
          id,
          browser.cells[id]?.passed ?? false,
          browser.cells[id]?.observation ?? 'unavailable:missing-cell',
        ),
      ),
  ];
  return {
    provenance,
    cells,
    passed: browser.status === 'ready' && cells.every((item) => item.passed),
    status: browser.status,
    diagnostics: browser.diagnostics,
    origin: browser.origin,
    csp: browser.csp,
    requests: browser.requests,
    responses: browser.responses,
    failures: browser.failures,
  };
}

async function main(): Promise<void> {
  const reports: Array<{
    candidate: Candidate;
    provenance: Record<string, unknown>;
    cells: EvidenceCell[];
    passed: boolean;
    status: BrowserResult['status'];
    diagnostics: string[];
  }> = [];
  for (const candidate of candidates) {
    const directory = await mkdtemp(
      join(tmpdir(), `corvidae-terminal-engine-${candidate.name.replaceAll('/', '-')}-`),
    );
    try {
      await Bun.write(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'terminal-engine-probe', private: true, type: 'module' }),
      );
      reports.push({ candidate, ...(await probeCandidate(candidate, directory)) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const expectedCellIds = candidates.flatMap((candidate) =>
    cellIds.map((id) => `${candidate.name}:${id}`),
  );
  const resolved = reports.every((item) => item.status === 'ready');
  const selected = resolved
    ? (reports.find((item) => item.passed && item.candidate.preferred) ??
      reports.find((item) => item.passed))
    : undefined;
  const report: EvidenceReport & { candidates: unknown[]; selectedEngine: unknown } = {
    schemaVersion: 1,
    reportKind: 'engine',
    sourceSha: await sourceSha(),
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds,
    cells: reports.flatMap(({ candidate, cells }) =>
      cells.map((item) => ({ ...item, id: `${candidate.name}:${item.id}` })),
    ),
    candidates: reports.map(({ candidate, provenance, cells, passed, status, diagnostics }) => ({
      name: candidate.name,
      version: candidate.version,
      preferred: candidate.preferred,
      passed,
      status,
      diagnostics,
      provenance,
      cells,
    })),
    selectedEngine: selected
      ? { name: selected.candidate.name, version: selected.candidate.version }
      : null,
    passed: resolved && selected !== undefined,
  };
  assertEvidence(report, 'engine');
  await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true });
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(reportPath);
  if (!report.passed) throw new Error(`engine probe failed; see ${reportPath}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
