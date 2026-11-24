import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { rootScriptEnvironment } from '../environment-configuration.ts';

const MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toHaveLength',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeTruthy',
  'toBeFalsy',
  'toMatch',
  'toThrow',
  'toBeGreaterThan',
  'toBeLessThan',
  'toBeVisible',
  'toBeHidden',
  'toHaveText',
  'toHaveValue',
  'toHaveAttribute',
  'toHaveCount',
  'toBeEnabled',
  'toBeDisabled',
  'toHaveScreenshot',
  'toBeGreaterThanOrEqual',
  'toBeLessThanOrEqual',
  'toMatchObject',
  'toHaveProperty',
  'toContainEqual',
  'toBeInstanceOf',
  'toBeCloseTo',
  'toHaveBeenCalled',
  'toHaveBeenCalledWith',
  'toThrowError',
  'toMatchSnapshot',
  'toHaveURL',
  'toHaveTitle',
  'toBeAttached',
  'toHaveClass',
  'toHaveCSS',
  'toHaveJSProperty',
  'toBeChecked',
  'toBeEmpty',
  'toBeFocused',
  'toBeEditable',
  'toBeInViewport',
  'toPass',
  'toContainText',
  'toHaveBeenCalledTimes',
  'toStartWith',
  'toBeString',
  'toContainClass',
  'toBeTrue',
  'toBeFalse',
  'toHaveBeenLastCalledWith',
  'toEndWith',
  'toBeFunction',
  'toChange',
  'toHaveAccessibleName',
  'toBeTypeOf',
  'toHaveAccessibleDescription',
]);

export interface ReplayAssertion {
  matcher: string;
  negated: boolean;
  modifier: 'resolves' | 'rejects' | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

export interface ReplayInput {
  runId: number;
  attempt: number;
  job: string;
  head: string;
  base: string;
  tree: string;
  lock: string;
  bun: string;
  command: string;
  selection: string[];
  output: string;
  workspace: string;
}

function hasTraversal(value: string): boolean {
  return /(?:^|[\s=/])\.\.(?:\/|$)/.test(value);
}

export function replayEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  noCredentials: boolean,
): Record<string, string | undefined> {
  const environment = { ...source };
  delete environment['CI_REPLAY_TOKEN'];
  if (noCredentials) {
    for (const key of Object.keys(environment)) {
      if (key === 'CORVIDAE_TEST_SLOTS_TOKEN') continue;
      if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)KEY(?:_|$))/i.test(key))
        delete environment[key];
    }
    for (const key of [
      'TURBO_TOKEN',
      'TURBO_TEAM',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
    ])
      delete environment[key];
  }
  return environment;
}

/** Only the workflow's named, bounded selection inputs can enter a replay record. */
export function replayParameters(environment: Readonly<Record<string, string | undefined>>) {
  const parameters: Record<string, string | null> = Object.create(null);
  for (const key of [
    'UNIT_WORKSPACE',
    'UNIT_PATHS',
    'UNIT_CONFIG',
    'CINDER_TEST_COMPONENTS',
    'FIXTURE_SPECS',
    'E2E_SPECS',
    'PLAYWRIGHT_SHARD',
    'TEST_LANES',
    'TURBO_SCM_BASE',
    'TZ',
    'LANG',
    'CI',
    'CINDER_VISUAL_DIFF',
    'CI_REPLAY_NO_CREDENTIALS',
    'CI_REPLAY_CREDENTIAL_BOUNDARY',
    'TURBO_ENV_MODE',
    'PLAYWRIGHT_BASE_IMAGE',
  ]) {
    const value = environment[key];
    if (value === undefined) continue;
    parameters[key] =
      value.length <= 32768 &&
      /^[A-Za-z0-9_./:@=,# -]*$/.test(value) &&
      !/(?:^|[ =])\/(?!\/#)|[A-Za-z]:[\\/]/.test(value) &&
      !hasTraversal(value)
        ? value
        : null;
  }
  return parameters;
}

/** Preserve only JUnit case outcomes; names, attributes and diagnostics may contain secrets. */
export async function sanitizeJUnit(xml: string): Promise<string> {
  if (Buffer.byteLength(xml) > 8 * 1024 * 1024 || /<!DOCTYPE/i.test(xml))
    throw new Error('JUnit report is too large or contains a doctype');
  const outcomes: ('pass' | 'failure' | 'error' | 'skipped')[] = [];
  let current: 'pass' | 'failure' | 'error' | 'skipped' | undefined;
  const { SaxesParser } = await import('saxes');
  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    if (tag.name === 'testcase') {
      if (current !== undefined || outcomes.length >= 10_000)
        throw new Error('invalid JUnit cases');
      current = 'pass';
    } else if (tag.name === 'failure' || tag.name === 'error' || tag.name === 'skipped') {
      if (current === undefined) throw new Error('JUnit outcome has no testcase');
      if (current === 'pass' || tag.name === 'error') current = tag.name;
    }
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 'testcase') {
      if (current === undefined) throw new Error('invalid JUnit testcase');
      outcomes.push(current);
      current = undefined;
    }
  });
  parser.write(xml).close();
  if (outcomes.length === 0) throw new Error('JUnit report has no testcases');
  const cases = outcomes
    .map(
      (outcome, index) =>
        `<testcase name="case-${index + 1}">${outcome === 'pass' ? '' : outcome === 'skipped' ? '<skipped/>' : `<${outcome} message="redacted"/>`}</testcase>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite tests="${outcomes.length}">${cases}</testsuite></testsuites>\n`;
}

/** Structured output excludes process diagnostics and arbitrary assertion values. */
export function replayRecord(input: ReplayInput) {
  const identityUnavailable: string[] = [];
  const revision = (label: string, value: string) => {
    if (/^[a-f0-9]{40}$/.test(value)) return value;
    identityUnavailable.push(label);
    return null;
  };
  const head = revision('head', input.head);
  const base = revision('base', input.base);
  const tree = revision('tree', input.tree);
  const lock = revision('lock', input.lock);
  if (![input.runId, input.attempt].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('invalid replay run identity');
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(input.job) ||
    !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?$/.test(input.bun)
  )
    throw new Error('invalid replay toolchain or job');
  const safeCommand =
    input.command.length <= 4096 &&
    /^[A-Za-z0-9_./:@=,# -]+$/.test(input.command) &&
    !/(?:^|[ =])\/(?!\/#)|[A-Za-z]:[\\/]/.test(input.command) &&
    !hasTraversal(input.command);
  const safeSelection =
    input.selection.length <= 15000 &&
    input.selection.reduce((length, value) => length + value.length + 1, 0) <= 32768 &&
    input.selection.every(
      (value) =>
        value.length <= 256 &&
        /^[A-Za-z0-9_./:@=,-]+$/.test(value) &&
        !/(?:^|=)\/|[A-Za-z]:[\\/]/.test(value) &&
        !hasTraversal(value),
    );
  const assertion = firstAssertion(input.output, input.workspace);
  return {
    runId: input.runId,
    attempt: input.attempt,
    job: input.job,
    head,
    base,
    tree,
    identityUnavailable,
    toolchain: { bun: input.bun, lock },
    command: safeCommand ? input.command : null,
    commandUnavailable: safeCommand
      ? null
      : input.command === ''
        ? 'failure occurred outside the replay producer; command was not captured'
        : 'command contains unsafe or unsupported values',
    replaySetup: {
      RUNNER_TEMP: 'fresh writable scratch directory',
      GITHUB_WORKSPACE: 'checkout root',
      GITHUB_OUTPUT: input.command.includes('scripts/chef/select-browser-suites.sh')
        ? '$RUNNER_TEMP/github-output'
        : null,
      TURBO_SCM_BASE: input.command.includes('scripts/chef/select-browser-suites.sh')
        ? 'restore recorded parameter and point its local ref at selectionBase; unavailable if either is missing'
        : null,
      GITHUB_PATH: input.command.includes('scripts/chef/prepare-postgres-path.sh')
        ? '$RUNNER_TEMP/github-path'
        : null,
      rawJUnit: '$RUNNER_TEMP/ci-replay-junit-raw.xml',
      PLAYWRIGHT_HTML_OUTPUT_DIR: input.command.includes('junit')
        ? '$GITHUB_WORKSPACE/playwright-output/report'
        : null,
      PLAYWRIGHT_JSON_OUTPUT_FILE: input.command.includes('junit')
        ? '$GITHUB_WORKSPACE/playwright-output/results.json'
        : null,
      PLAYWRIGHT_JUNIT_OUTPUT_FILE: input.command.includes('junit')
        ? '$RUNNER_TEMP/ci-replay-junit-raw.xml'
        : null,
    },
    selection: safeSelection ? input.selection : [],
    selectionUnavailable: safeSelection ? null : 'selection contains unsafe or unsupported values',
    assertion,
    assertionUnavailable: assertion === null ? 'no recognized assertion in captured output' : null,
    artifacts: {
      junit: { link: null, reason: 'no sanitized JUnit was emitted' },
      trace: { link: null, reason: 'raw browser traces are not retained' },
    },
  };
}

/** Extract a fixed matcher and repository-relative location, never assertion values or diagnostics. */
export function firstAssertion(output: string, workspace: string): ReplayAssertion | null {
  const normalized = Bun.stripANSI(output);
  const match =
    /(?:error|Error):\s*expect\([^\n]*?\)(?:\.(resolves|rejects))?(?:\.(not))?\.([A-Za-z]+)\(/.exec(
      normalized,
    );
  if (match === null || !MATCHERS.has(match[3]!)) return null;
  const firstMatcher = match[3]!;
  const negated = match[2] === 'not';
  const modifier = match[1] === 'resolves' || match[1] === 'rejects' ? match[1] : null;
  const following =
    normalized.slice(match.index + match[0].length).split(/(?:error|Error):\s*expect\(/, 1)[0] ??
    '';
  const root = workspace.replace(/\/+$/, '');
  for (const line of following.split('\n')) {
    const location = /\s+at (?:.*?\()?([^():]+):(\d+):(\d+)\)?\s*$/.exec(line);
    if (location === null || !location[1]!.startsWith(`${root}/`)) continue;
    const file = location[1]!.slice(root.length + 1);
    if (!/^[A-Za-z0-9_./-]+\.(?:ts|tsx)$/.test(file) || file.split('/').includes('..')) continue;
    const row = Number(location[2]);
    const column = Number(location[3]);
    if (!Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(column) || column < 1)
      continue;
    return { matcher: firstMatcher, negated, modifier, file, line: row, column };
  }
  return { matcher: firstMatcher, negated, modifier, file: null, line: null, column: null };
}

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function resolveSelectionBase(
  environment: Readonly<Record<string, string | undefined>>,
  resolve: (ref: string) => string,
): { selectionBase: string | null; selectionBaseUnavailable: string | null } {
  const ref = environment['TURBO_SCM_BASE'];
  if (!ref)
    return { selectionBase: null, selectionBaseUnavailable: 'selection base ref not provided' };
  if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-') || hasTraversal(ref))
    return { selectionBase: null, selectionBaseUnavailable: 'selection base ref is unsafe' };
  const sha = resolve(ref);
  return /^[a-f0-9]{40}$/.test(sha)
    ? { selectionBase: sha, selectionBaseUnavailable: null }
    : {
        selectionBase: null,
        selectionBaseUnavailable: 'selection base ref could not be resolved to a commit',
      };
}

export async function findRunningJob(
  loadPage: (page: number) => Promise<unknown>,
  runner: string,
  run: number,
  attempt: number,
): Promise<number | null> {
  const matches: number[] = [];
  const ids = new Set<number>();
  let expected: number | undefined;
  for (let page = 1; page <= 20; page += 1) {
    const body = await loadPage(page);
    if (
      typeof body !== 'object' ||
      body === null ||
      !('jobs' in body) ||
      !Array.isArray(body.jobs) ||
      !('total_count' in body) ||
      typeof body.total_count !== 'number' ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0
    )
      return null;
    expected ??= body.total_count;
    if (expected !== body.total_count || ids.size + body.jobs.length > expected) return null;
    for (const value of body.jobs as unknown[]) {
      if (typeof value !== 'object' || value === null) return null;
      const job = value as Record<string, unknown>;
      if (
        typeof job['id'] !== 'number' ||
        !Number.isSafeInteger(job['id']) ||
        job['id'] < 1 ||
        ids.has(job['id'])
      )
        return null;
      ids.add(job['id']);
      if (job['run_id'] !== run || job['run_attempt'] !== attempt) return null;
      if (job['runner_name'] === runner && job['status'] === 'in_progress') matches.push(job['id']);
    }
    if (ids.size === expected) return matches.length === 1 ? matches[0]! : null;
    if (body.jobs.length === 0) return null;
  }
  return null;
}

async function jobId(
  repository: string,
  run: number,
  attempt: number,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<number | null> {
  const token = environment['CI_REPLAY_TOKEN'];
  const runner = environment['RUNNER_NAME'];
  if (!token || !runner || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  try {
    return await findRunningJob(
      async (page) => {
        const url = `https://api.github.com/repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) throw new Error('provider job inventory unavailable');
        return response.json();
      },
      runner,
      run,
      attempt,
    );
  } catch {
    return null;
  }
}

async function saveRecord(
  command: string,
  output: string,
  captured?: {
    environment: Record<string, string | undefined>;
    selectionBase: ReturnType<typeof resolveSelectionBase>;
  },
): Promise<void> {
  const environment = captured?.environment ?? { ...rootScriptEnvironment() };
  const temporary = environment['RUNNER_TEMP'];
  const workspace = environment['GITHUB_WORKSPACE'];
  if (!temporary || !workspace) throw new Error('replay runner context unavailable');
  const destination = join(temporary, 'ci-replay-record.json');
  if (existsSync(destination)) return;
  const run = Number(environment['GITHUB_RUN_ID']);
  const attempt = Number(environment['GITHUB_RUN_ATTEMPT']);
  const repository = environment['GITHUB_REPOSITORY'] ?? '';
  const selection = (environment['CI_REPLAY_SELECTION'] ?? '').split(/\s+/).filter(Boolean);
  const record = replayRecord({
    runId: run,
    attempt,
    job: environment['GITHUB_JOB'] ?? '',
    head: environment['CI_REPLAY_HEAD'] ?? environment['GITHUB_SHA'] ?? '',
    base: environment['CI_REPLAY_BASE'] || git('rev-parse', 'origin/main'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    lock: git('rev-parse', 'HEAD:bun.lock'),
    bun: Bun.version,
    command,
    selection,
    output,
    workspace,
  });
  const parameters = replayParameters(environment);
  const image = environment['CI_REPLAY_IMAGE'] ?? '';
  const checked = environment['GITHUB_SHA'] ?? '';
  const imageVersion = environment['ImageVersion'] ?? '';
  const id = await jobId(repository, run, attempt, environment);
  const fixtureImage = /^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-[a-z0-9]+$/.test(image)
    ? image
    : null;
  let junit = { link: null as string | null, reason: 'no JUnit was emitted' as string | null };
  const rawJUnit = join(temporary, 'ci-replay-junit-raw.xml');
  if (existsSync(rawJUnit)) {
    try {
      const metadata = lstatSync(rawJUnit);
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error('invalid JUnit');
      const safe = await sanitizeJUnit(readFileSync(rawJUnit, 'utf8'));
      writeFileSync(join(temporary, 'ci-replay-junit.xml'), safe, { flag: 'wx', mode: 0o600 });
      junit = { link: 'ci-replay-junit.xml', reason: null };
    } catch {
      junit = { link: null, reason: 'JUnit was malformed, unsafe, or could not be sanitized' };
    }
  }
  const result = {
    ...record,
    ...(captured?.selectionBase ??
      resolveSelectionBase(environment, (ref) => git('rev-parse', '--verify', `${ref}^{commit}`))),
    parameters,
    toolchain: {
      ...record.toolchain,
      node: /^v\d+\.\d+\.\d+$/.test(process.version) ? process.version : null,
      platform: ['linux', 'darwin', 'win32'].includes(process.platform) ? process.platform : null,
      architecture: ['x64', 'arm64'].includes(process.arch) ? process.arch : null,
      runnerImageVersion: /^[A-Za-z0-9_.-]{1,80}$/.test(imageVersion) ? imageVersion : null,
    },
    jobId: id,
    jobIdUnavailable: id === null ? 'provider job identity unavailable or ambiguous' : null,
    checkedRevision: /^[a-f0-9]{40}$/.test(checked) ? checked : null,
    fixtureImage,
    artifacts: { ...record.artifacts, junit },
    artifactIndex: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      ? `https://github.com/${repository}/actions/runs/${run}`
      : null,
  };
  writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function runCommand(args: string[]): Promise<number> {
  if (args.length === 0) throw new Error('replay command missing');
  const command = args.join(' ');
  const source = { ...rootScriptEnvironment() };
  const selectionBase = resolveSelectionBase(source, (ref) =>
    git('rev-parse', '--verify', `${ref}^{commit}`),
  );
  const environment = replayEnvironment(source, source['CI_REPLAY_NO_CREDENTIALS'] === 'true');
  const child = Bun.spawn(['bash', '-c', 'exec "$@" 2>&1', 'ci-replay', ...args], {
    stdout: 'pipe',
    stderr: 'inherit',
    env: environment,
  });
  const decoder = new TextDecoder();
  let capture = '';
  let found = false;
  for await (const bytes of child.stdout) {
    if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
    const text = decoder.decode(bytes, { stream: true });
    if (!found) {
      capture = (capture + text).slice(-262144);
      found = /(?:error|Error):\s*expect\(/.test(capture);
    } else if (capture.length < 327680) capture += text.slice(0, 327680 - capture.length);
  }
  const code = await child.exited;
  if (code !== 0) await saveRecord(command, capture, { environment: source, selectionBase });
  return code;
}

if (import.meta.main) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'run' && args[0] === '--') process.exitCode = await runCommand(args.slice(1));
    else if (mode === 'isolated' && args[0] === '--' && args.length > 1) {
      const child = Bun.spawn(args.slice(1), {
        env: replayEnvironment(rootScriptEnvironment(), true),
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      process.exitCode = await child.exited;
    } else if (mode === 'finalize' && args.length === 0)
      await saveRecord(rootScriptEnvironment()['CI_REPLAY_COMMAND'] ?? '', '');
    else throw new Error('invalid replay invocation');
  } catch {
    process.stderr.write('could not write bounded CI replay record\n');
    process.exitCode = 1;
  }
}
