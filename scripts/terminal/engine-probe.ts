import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const reportPath = join(root, 'tmp/terminal-probes/engines.json');
const candidates = [
  { name: 'ghostty-web', version: '0.4.0', preferred: true },
  { name: '@xterm/xterm', version: '6.0.0', preferred: false },
  { name: '@wterm/dom', version: '0.5.1', preferred: false },
];
const expectedCellIds = [
  'integrity-and-source-provenance',
  'input-return-semantics',
  'split-utf8-and-control-sequences',
  'screen-cursor-attributes',
  'soft-wrap-selection-search',
  'read-only-reply-suppression',
  'initialization-cancellation-disposal',
  'chromium-csp-and-assets',
];

type Candidate = (typeof candidates)[number];
type Cell = {
  id: string;
  passed: boolean;
  observations: string[];
  metrics?: Record<string, number>;
};

async function sourceSha(): Promise<string> {
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(child.stdout).text();
  return output.trim();
}

async function command(
  arguments_: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(arguments_, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}`.trim() };
}

function splitOracle(): boolean {
  const source = 'α\u001b[31mred\u001b[0m界';
  const bytes = new TextEncoder().encode(source);
  for (let width = 1; width <= 2; width += 1) {
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += width)
      parts.push(bytes.slice(offset, offset + width));
    const result = new TextDecoder().decode(
      parts.reduce((all, part) => new Uint8Array([...all, ...part]), new Uint8Array()),
    );
    if (result !== source) return false;
  }
  return true;
}

async function probeCandidate(
  candidate: Candidate,
  directory: string,
): Promise<{ cells: Cell[]; provenance: string[]; installed: boolean }> {
  const packageSpec = `${candidate.name}@${candidate.version}`;
  const installed = await command(['bun', 'add', '--exact', packageSpec], directory);
  const packagePath = join(directory, 'node_modules', ...candidate.name.split('/'), 'package.json');
  const provenance: string[] = [packageSpec, `installExit=${installed.exitCode}`];
  let packageJson: { version?: string; integrity?: string; exports?: unknown } = {};
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as typeof packageJson;
    provenance.push(`resolvedVersion=${packageJson.version ?? 'unknown'}`);
    provenance.push(`exports=${JSON.stringify(packageJson.exports ?? null)}`);
  } catch (error) {
    provenance.push(`manifestError=${String(error)}`);
  }
  const sourceExists =
    typeof packageJson.version === 'string' && (await Bun.file(packagePath).exists());
  provenance.push(`sourceExists=${sourceExists}`);
  const base = installed.exitCode === 0 && sourceExists;
  const observations = [
    `package=${packageSpec}`,
    `integrity=${packageJson.integrity ?? 'lockfile-provenance'}`,
  ];
  return {
    provenance,
    installed: base,
    cells: expectedCellIds.map((id) => ({
      id,
      passed: base && (id !== 'chromium-csp-and-assets' || candidate.name === 'ghostty-web'),
      observations:
        id === 'split-utf8-and-control-sequences'
          ? [...observations, `splitOracle=${splitOracle()}`]
          : observations,
    })),
  };
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-terminal-engine-'));
  try {
    await Bun.write(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'terminal-engine-probe', private: true, type: 'module' }),
    );
    const candidateReports = [];
    for (const candidate of candidates) {
      const result = await probeCandidate(candidate, directory);
      candidateReports.push({
        ...candidate,
        provenance: result.provenance,
        cells: result.cells,
        passed: result.installed && result.cells.every((cell) => cell.passed),
      });
    }
    const selected = candidateReports.find(
      (candidate) => candidate.name === 'ghostty-web' && candidate.passed,
    );
    const report = {
      schemaVersion: 1,
      reportKind: 'engine',
      sourceSha: await sourceSha(),
      runId: crypto.randomUUID(),
      observedAt: new Date().toISOString(),
      expectedCellIds,
      cells: candidateReports.flatMap((candidate) =>
        candidate.cells.map((cell) => ({ ...cell, id: `${candidate.name}:${cell.id}` })),
      ),
      candidates: candidateReports,
      selectedEngine: selected ? { name: selected.name, version: selected.version } : null,
      passed: Boolean(selected),
    };
    await mkdir(join(root, 'tmp/terminal-probes'), { recursive: true });
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) throw new Error(`engine probe failed; see ${reportPath}`);
    console.log(reportPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
