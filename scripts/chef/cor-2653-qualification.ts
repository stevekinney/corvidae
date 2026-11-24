import { existsSync, readFileSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { END_TO_END_PORT_COUNT } from '../../applications/interborough/scripts/environment-configuration.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import {
  actionAfterRelease,
  actionsBracketAssertion,
  competitorActions,
  observedRelease,
  qualificationMode,
} from './cor-2653-overlap.ts';

const root = resolve(import.meta.dir, '../..');
const environment = rootScriptEnvironment();
const output = join(root, 'qualification-output');
const candidate = environment['QUALIFICATION_SHA'] ?? '';
const request = environment['QUALIFICATION_REQUEST'] ?? '';
const mode = qualificationMode(request, candidate);
const competitionOnly = mode === 'competition-only';
const base = '299f3776324f7ea124e635c3befc1f493ae55e87';
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ request, candidate }));
if (mode === undefined)
  throw new Error('Qualification request must name the exact checked-out SHA.');

type Run = {
  child: ReturnType<typeof Bun.spawn>;
  output: string;
  stdout: string;
  finished: boolean;
  code?: number;
  startedAt: string;
  finishedAt?: string;
  assertionAt?: string;
  verdictAt?: string;
  done: Promise<number>;
};
function start(
  name: string,
  cwd: string,
  argumentsList: string[],
  variables: Record<string, string> = {},
): Run {
  const child = Bun.spawn(argumentsList, {
    cwd,
    env: { ...environment, ...variables },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const run: Run = {
    child,
    output: '',
    stdout: '',
    finished: false,
    startedAt: new Date().toISOString(),
    done: Promise.resolve(1),
  };
  const forward = async (stream: ReadableStream<Uint8Array>, standardOutput: boolean) => {
    let tail = '';
    for await (const bytes of stream) {
      const chunk = new TextDecoder().decode(bytes);
      run.output += chunk;
      if (standardOutput) run.stdout += chunk;
      const scanned = tail + chunk;
      const assertion = /COR2653_ASSERTION (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)/.exec(
        scanned,
      )?.[1];
      const verdict = /COR2653_(?:VERDICT|TEST_END) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)/.exec(
        scanned,
      )?.[1];
      if (run.assertionAt === undefined && assertion !== undefined) run.assertionAt = assertion;
      if (run.verdictAt === undefined && verdict !== undefined) run.verdictAt = verdict;
      tail = scanned.slice(-128);
      await appendFile(join(output, `${name}.log`), chunk);
    }
  };
  run.done = Promise.all([
    child.exited,
    forward(child.stdout as ReadableStream<Uint8Array>, true),
    forward(child.stderr as ReadableStream<Uint8Array>, false),
  ]).then(async ([code]) => {
    run.finished = true;
    run.code = code;
    run.finishedAt = new Date().toISOString();
    return code;
  });
  return run;
}
async function command(
  name: string,
  cwd: string,
  args: string[],
  variables: Record<string, string> = {},
): Promise<void> {
  const run = start(name, cwd, args, variables);
  const code = await run.done;
  if (code !== 0) throw new Error(`${name} failed with ${String(code)}; see ${name}.log`);
}
function requireResult(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function portOf(run: Run): number | undefined {
  const match = /gated browser suite: starting on ports (\d+)-/.exec(run.output);
  return match === null ? undefined : Number(match[1]);
}
async function ready(run: Run): Promise<number> {
  await waitUntil(
    () =>
      run.finished ||
      (portOf(run) !== undefined && run.output.includes('Interborough E2E host listening')),
    { message: 'browser host startup' },
  );
  requireResult(!run.finished, `browser host exited before readiness: ${run.output.slice(-2000)}`);
  const port = portOf(run);
  requireResult(port !== undefined, 'browser did not report its port');
  return port;
}
async function json<T>(port: number, path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method });
  requireResult(response.ok, `${String(port)}${path}: ${String(response.status)}`);
  return response.json() as Promise<T>;
}
async function listenerOwners(
  ports: number[],
): Promise<Map<number, { pid: number; cwd: string; run: string }>> {
  const sockets = new Map<string, number>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const tableContents = await readFile(table, 'utf8');
    for (const line of tableContents.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const address = fields[1];
      const inode = fields[9];
      if (!address || !inode || fields[3] !== '0A') continue;
      const port = Number.parseInt(address.split(':')[1] ?? '', 16);
      if (ports.includes(port)) sockets.set(inode, port);
    }
  }
  const owners = new Map<number, { pid: number; cwd: string; run: string }>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const directory = `/proc/${entry}`;
    const descriptors = await readdir(`${directory}/fd`).catch(() => []);
    for (const descriptor of descriptors) {
      const target = await readlink(`${directory}/fd/${descriptor}`).catch(() => '');
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      const port = inode === undefined ? undefined : sockets.get(inode);
      if (port === undefined) continue;
      const processEnvironmentText = await readFile(`${directory}/environ`, 'utf8').catch(() => '');
      const run =
        processEnvironmentText
          .split('\0')
          .find((item) => item.startsWith('INTERBOROUGH_E2E_RUN_ID='))
          ?.split('=')[1] ?? '';
      const cwd = await readlink(`${directory}/cwd`).catch(() => '');
      owners.set(port, { pid: Number(entry), cwd, run });
    }
  }
  return owners;
}
const worktrees = join(environment['RUNNER_TEMP'] ?? root, 'cor-2653-worktrees');
const a = join(worktrees, 'a');
const b = join(worktrees, 'b');
const control = join(worktrees, 'base');
const bad = join(worktrees, 'bad');
const allRuns: Run[] = [];
const sentinels: ReturnType<typeof Bun.serve>[] = [];
let activeMeasurement: { label: string; stop: () => number } | undefined;
const evidence: Record<string, unknown> = {
  base,
  candidate,
  mode: competitionOnly ? 'competition-only' : 'full',
  runner: process.platform,
  architecture: process.arch,
  processors: cpus().length,
  totalMemoryBytes: totalmem(),
  runnerClass: environment['RUNNER_NAME'] ?? 'unknown',
  runnerImage: 'ubuntu-latest / mcr.microsoft.com/playwright:v1.63.0-jammy',
  workers: 1,
  playwrightRetries: 0,
  hangGuardMilliseconds: 120000,
  testTimeoutMilliseconds: 240000,
};
function measureCondition() {
  let peak = 0;
  let failure: unknown;
  const sample = () => {
    try {
      const value = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      if (!Number.isFinite(value) || value <= 0) throw new Error('No cgroup memory measurement');
      peak = Math.max(peak, value);
    } catch (error) {
      failure = error;
    }
  };
  sample();
  const timer = setInterval(sample, 500);
  timer.unref();
  return () => {
    clearInterval(timer);
    sample();
    if (failure !== undefined) throw failure;
    return peak;
  };
}
try {
  await mkdir(worktrees, { recursive: true });
  for (const [name, path, revision] of [
    ['a', a, candidate],
    ['b', b, candidate],
    ['base', control, base],
    ['bad', bad, candidate],
  ] as const) {
    if (competitionOnly && name === 'base') continue;
    await command(`checkout-${name}`, root, ['git', 'worktree', 'add', '--detach', path, revision]);
    await command(`install-${name}`, path, ['bun', 'install', '--frozen-lockfile']);
    await command(`metadata-${name}`, path, ['bunx', 'turbo', 'run', 'metadata']);
  }
  for (let port = 7399; port < 7399 + END_TO_END_PORT_COUNT; port += 1)
    sentinels.push(
      Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: () => new Response(`sentinel-${String(port)}`),
      }),
    );
  const browser = (
    name: string,
    path: string,
    extra: string[],
    variables: Record<string, string> = {},
  ) => {
    const run = start(
      name,
      join(path, 'applications/interborough'),
      ['bun', 'run', 'test:browser', ...extra],
      variables,
    );
    allRuns.push(run);
    return run;
  };
  const qualification = ['tests/e2e/browser-isolation.qualification.ts', '--reporter=line'];
  const shared = { COR_2653_QUALIFICATION: '1', COR_2653_REVISION: candidate.slice(0, 7) };
  if (!competitionOnly) {
    const baseline = browser('baseline-package-collision', control, [
      'tests/e2e/29-goals.spec.ts',
      '--grep',
      'lists the seeded goal at 375 pixels',
      '--reporter=line',
    ]);
    requireResult(
      (await baseline.done) !== 0 && baseline.output.includes('EADDRINUSE'),
      'baseline did not reproduce the occupied default block',
    );
    const healthy = start('baseline-gated-control', join(control, 'applications/interborough'), [
      'bun',
      'scripts/run-gated-browser-suite.ts',
      'tests/e2e/29-goals.spec.ts',
      '--grep',
      'lists the seeded goal at 375 pixels',
      '--reporter=line',
    ]);
    allRuns.push(healthy);
    requireResult((await healthy.done) === 0, 'baseline gated control failed');
    evidence['baseline'] = { packageExit: baseline.code, gatedExit: healthy.code };
    const first = browser('concurrent-a', a, qualification, {
      ...shared,
      INTERBOROUGH_E2E_RUN_ID: 'A',
    });
    const second = browser('concurrent-b', b, qualification, {
      ...shared,
      INTERBOROUGH_E2E_RUN_ID: 'B',
    });
    const [firstPort, secondPort] = await Promise.all([ready(first), ready(second)]);
    requireResult(
      Math.abs(firstPort - secondPort) >= END_TO_END_PORT_COUNT,
      'A and B have overlapping port blocks',
    );
    type Identity = { run: string; build: { commit: string }; port: number };
    const identities = await Promise.all([
      json<Identity>(firstPort + 1, '/identity'),
      json<Identity>(secondPort + 1, '/identity'),
    ]);
    requireResult(
      identities[0].run === 'A' &&
        identities[1].run === 'B' &&
        identities.every((identity) => identity.build.commit === candidate),
      'identity or build mismatch',
    );
    await waitUntil(
      async () => {
        if (first.finished || second.finished)
          throw new Error('A or B ended before both browser actions');
        const states = await Promise.all([
          json<{ started: boolean }>(firstPort + 1, '/qualification'),
          json<{ started: boolean }>(secondPort + 1, '/qualification'),
        ]);
        return states.every((state) => state.started);
      },
      { message: 'both browsers to verify their seeded host and revision' },
    );
    const workflows: unknown[] = [];
    for (const [port, own, other] of [
      [firstPort, 'qualification-a', 'qualification-b'],
      [secondPort, 'qualification-b', 'qualification-a'],
    ] as const) {
      for (const id of [own, other]) {
        const response = await fetch(`http://127.0.0.1:${String(port)}/bureau/jsonrpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'bureau.workflows.get',
            params: { id },
          }),
        });
        const answer = (await response.json()) as { result?: { id?: string }; error?: unknown };
        requireResult(
          id === own ? answer.result?.id === own : answer.error !== undefined,
          `workflow ${id} was not isolated at ${String(port)}`,
        );
        workflows.push({ port, id, answer });
      }
    }
    for (const port of [firstPort, secondPort])
      for (let offset = 0; offset < END_TO_END_PORT_COUNT; offset += 1) {
        const response = await fetch(
          `http://127.0.0.1:${String(port + offset)}${offset === 1 ? '/waiting' : '/'}`,
          {
            headers: {
              accept: 'text/html',
              ...(offset === 8 ? { 'x-api-key': 'chat-owner-browser-key' } : {}),
            },
          },
        );
        requireResult(response.ok, `missing listener at ${String(port + offset)}`);
      }
    const sharing: unknown[] = [];
    for (const port of [firstPort, secondPort]) {
      const response = await fetch(`http://127.0.0.1:${String(port + 8)}/bureau/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'chat-owner-browser-key' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'sharing',
          method: 'bureau.agents.list',
          params: {},
        }),
      });
      const answer = (await response.json()) as { result?: { agents?: Array<{ name?: string }> } };
      requireResult(
        response.ok && answer.result?.agents?.some((agent) => agent.name === 'echo-text'),
        `sharing host failed authenticated probe on ${String(port + 8)}`,
      );
      sharing.push({ port: port + 8, agent: 'echo-text' });
    }
    const addresses = [firstPort, secondPort].flatMap((port) =>
      Array.from({ length: END_TO_END_PORT_COUNT }, (_, offset) => port + offset),
    );
    const owners = await listenerOwners(addresses);
    for (const [port, path, id] of [
      [firstPort, a, 'A'],
      [secondPort, b, 'B'],
    ] as const) {
      for (let offset = 0; offset < END_TO_END_PORT_COUNT; offset += 1) {
        const owner = owners.get(port + offset);
        requireResult(
          owner?.run === id && owner.cwd.startsWith(path),
          `listener ${String(port + offset)} belongs to ${JSON.stringify(owner)}`,
        );
      }
    }
    for (let port = 7399; port < 7399 + END_TO_END_PORT_COUNT; port += 1) {
      const response = await fetch(`http://127.0.0.1:${String(port)}`);
      const body = await response.text();
      requireResult(body === `sentinel-${String(port)}`, `sentinel ${String(port)} changed`);
    }
    first.child.kill('SIGTERM');
    first.child.kill('SIGTERM');
    const firstExit = await first.done;
    const remainingA = await listenerOwners(
      Array.from({ length: END_TO_END_PORT_COUNT }, (_, offset) => firstPort + offset),
    );
    requireResult(
      remainingA.size === 0,
      `A's listeners remained after cleanup: ${JSON.stringify(Object.fromEntries(remainingA))}`,
    );
    requireResult(!second.finished, 'B ended before A stopped');
    await json(secondPort + 1, '/qualification', 'POST');
    const secondExit = await second.done;
    requireResult(secondExit === 0, `B failed with ${String(secondExit)}`);
    evidence['concurrent'] = {
      firstPort,
      secondPort,
      identities,
      workflows,
      sharing,
      listenerOwners: Object.fromEntries(owners),
      firstExit,
      secondExit,
      firstStarted: first.startedAt,
      firstFinished: first.finishedAt,
      secondStarted: second.startedAt,
      secondFinished: second.finishedAt,
    };
    const races: Record<string, unknown> = {};
    evidence['allocationRaces'] = races;
    for (const offset of [1, 6, 8]) {
      const race = browser(`allocation-race-${String(offset)}`, a, [
        'tests/e2e/29-goals.spec.ts',
        '--grep',
        'lists the seeded goal at 375 pixels',
        '--reporter=line',
      ]);
      await waitUntil(() => race.finished || portOf(race) !== undefined, {
        message: 'port allocation',
      });
      requireResult(!race.finished, 'race ended before allocation');
      const allocatedPort = portOf(race);
      requireResult(allocatedPort !== undefined, 'race did not report its port');
      const collisionPort = allocatedPort + offset;
      const collision = Bun.serve({
        hostname: '127.0.0.1',
        port: collisionPort,
        fetch: () => new Response('race sentinel'),
      });
      sentinels.push(collision);
      await waitUntil(() => race.finished || race.output.includes('retrying with a fresh block'), {
        message: 'collision retry',
      });
      requireResult(!race.finished, 'allocation collision was not retried');
      const collisionResponse = await fetch(`http://127.0.0.1:${String(collisionPort)}`);
      const collisionBody = await collisionResponse.text();
      requireResult(collisionBody === 'race sentinel', 'race sentinel changed');
      requireResult((await race.done) === 0, 'allocation race failed');
      races[String(offset)] = { collisionPort, exit: race.code };
    }
    const explicit = browser('occupied-override', a, qualification, {
      ...shared,
      INTERBOROUGH_E2E_PORT: '7399',
    });
    requireResult(
      (await explicit.done) === 2 && explicit.output.includes('not a free block'),
      'occupied override did not fail clearly',
    );
    evidence['override'] = { exit: explicit.code };
  }
  const integrationPath = 'applications/interborough/src/host/supervisor.integration.test.ts';
  const integration = (name: string, path: string, directory: string | undefined) => {
    const run = start(
      name,
      path,
      ['bun', 'scripts/bun-test.ts', integrationPath],
      directory
        ? { COR_2653_TRACE_ASSERTIONS: '1', COR_2653_COMPETITION_DIRECTORY: directory }
        : {},
    );
    allRuns.push(run);
    return run;
  };
  const seeded = (name: string, path: string, directory: string | undefined) =>
    browser(
      name,
      path,
      [
        'tests/e2e/29-goals.spec.ts',
        '--grep',
        'lists the seeded goal at 375 pixels',
        directory
          ? `--reporter=line,${join(path, 'scripts/chef/cor-2653-reporter.ts')}`
          : '--reporter=line',
      ],
      directory ? { COR_2653_COMPETITION_DIRECTORY: directory } : {},
    );
  const supervisor = join(bad, 'applications/interborough/src/host/supervisor.ts');
  const supervisorSource = await readFile(supervisor, 'utf8');
  const supervisorBad = supervisorSource.replace(
    'if (code !== RESTART_EXIT_CODE) return code;',
    'if (code !== RESTART_EXIT_CODE || code === 75) return code;',
  );
  requireResult(supervisorBad !== supervisorSource, 'integration mutation did not apply');
  await writeFile(supervisor, supervisorBad);
  const seed = join(bad, 'plugins/demo/src/seed.ts');
  const seedSource = await readFile(seed, 'utf8');
  const seedBad = seedSource.replace("name: 'say-hello'", "name: 'incorrect-goal'");
  requireResult(seedBad !== seedSource, 'browser mutation did not apply');
  await writeFile(seed, seedBad);
  const outcomes: Record<string, number[]> = {};
  evidence['matrix'] = outcomes;
  for (const [label, path, expected] of [
    ['correct', a, 0],
    ['incorrect', bad, 1],
  ] as const) {
    for (const order of (competitionOnly
      ? ['competing-worktree']
      : ['integration-first', 'browser-first', 'concurrent', 'competing-worktree']) as readonly (
      'integration-first' | 'browser-first' | 'concurrent' | 'competing-worktree'
    )[]) {
      const finishMeasurement = measureCondition();
      activeMeasurement = { label: `${label}-${order}`, stop: finishMeasurement };
      const directory =
        order === 'competing-worktree' ? join(output, `competition-${label}`) : undefined;
      if (directory) await mkdir(directory, { recursive: true });
      let integrationResult: Run | undefined;
      let browserResult: Run | undefined;
      const integrationRun = () =>
        (integrationResult = integration(`${label}-${order}-integration`, path, directory));
      const browserRun = () =>
        (browserResult = seeded(`${label}-${order}-browser`, path, directory));
      let codes: number[];
      if (order === 'competing-worktree') {
        if (!directory) throw new Error('Missing competition control directory');
        const x = integrationRun();
        const y = browserRun();
        const competitor = browser(
          `${label}-competitor`,
          b,
          ['tests/e2e/browser-competition.qualification.ts', '--reporter=line'],
          {
            ...shared,
            COR_2653_COMPETITION_DIRECTORY: directory,
            INTERBOROUGH_E2E_RUN_ID: `${label}-competitor`,
          },
        );
        const competitorPort = await ready(competitor);
        await waitUntil(
          () => {
            if (
              competitor.finished ||
              (x.finished && !x.assertionAt) ||
              (y.finished && !y.assertionAt)
            )
              throw new Error('A case ended before the readiness handshake');
            return competitorActions(competitor.stdout).length > 0;
          },
          { message: 'the first real competing browser action' },
        );
        await writeFile(join(directory, 'release'), 'release');
        await waitUntil(
          () => {
            if (
              competitor.finished ||
              (x.finished && !x.assertionAt) ||
              (y.finished && !y.assertionAt)
            )
              throw new Error('A case ended before both target assertions');
            return x.assertionAt !== undefined && y.assertionAt !== undefined;
          },
          { message: 'both target assertions' },
        );
        await json(competitorPort + 1, '/qualification', 'POST');
        codes = await Promise.all([x.done, y.done]);
        requireResult((await competitor.done) === 0, 'competing browser case failed');
        const actions = competitorActions(competitor.stdout);
        evidence[`${label}-overlap`] = {
          competitor: {
            startedAt: competitor.startedAt,
            finishedAt: competitor.finishedAt,
            exit: competitor.code,
          },
          competitorActions: actions,
          competitorReleaseObserved: observedRelease(competitor.stdout),
          integrationStarted: x.startedAt,
          integrationFirstAssertion: x.assertionAt,
          integrationFirstVerdict: x.verdictAt,
          integrationFinished: x.finishedAt,
          browserStarted: y.startedAt,
          browserFirstAssertion: y.assertionAt,
          browserFirstVerdict: y.verdictAt,
          browserFinished: y.finishedAt,
        };
        requireResult(
          actionsBracketAssertion(x.assertionAt, actions),
          'integration first assertion was not bracketed by real competitor actions',
        );
        requireResult(
          actionsBracketAssertion(y.assertionAt, actions),
          'browser first assertion was not bracketed by real competitor actions',
        );
        requireResult(
          actionAfterRelease(competitor.stdout),
          'competitor did not perform a verified action after observing release',
        );
        requireResult(
          x.verdictAt !== undefined && y.verdictAt !== undefined,
          'first verdict timestamps are missing',
        );
      } else if (order === 'concurrent') {
        const x = integrationRun();
        const y = browserRun();
        codes = await Promise.all([x.done, y.done]);
      } else if (order === 'integration-first')
        codes = [await integrationRun().done, await browserRun().done];
      else {
        const y = await browserRun().done;
        codes = [await integrationRun().done, y];
      }
      outcomes[`${label}-${order}`] = codes;
      evidence[`${label}-${order}-sampledCgroupPeakMemoryBytes`] = finishMeasurement();
      activeMeasurement = undefined;
      requireResult(
        codes.every((code) => (expected === 0 ? code === 0 : code !== 0)),
        `${label} ${order} verdict mismatch: ${codes.join(',')}`,
      );
      if (label === 'incorrect') {
        requireResult(
          integrationResult?.output.includes('starts the host again on exit code 75'),
          'incorrect integration did not reach its expected assertion',
        );
        requireResult(
          browserResult?.output.includes('say-hello'),
          'incorrect browser did not reach its expected assertion',
        );
      }
    }
  }
  if (!competitionOnly) {
    const connectTest = 'applications/interborough/tests/e2e/connect-host.integration.test.ts';
    const connectFixture = 'applications/interborough/tests/e2e/connect-host.test-support.ts';
    await writeFile(join(control, connectTest), await readFile(join(a, connectTest)));
    await writeFile(join(control, connectFixture), await readFile(join(a, connectFixture)));
    const baseConnect = start('base-connect-control', control, [
      'bun',
      'scripts/bun-test.ts',
      connectTest,
    ]);
    const candidateConnect = start('candidate-connect-control', a, [
      'bun',
      'scripts/bun-test.ts',
      connectTest,
    ]);
    allRuns.push(baseConnect, candidateConnect);
    const connectCodes = await Promise.all([baseConnect.done, candidateConnect.done]);
    requireResult(
      connectCodes[0] !== 0 && connectCodes[1] === 0,
      `connect control verdict mismatch: ${connectCodes.join(',')}`,
    );
    requireResult(
      baseConnect.output.includes('Expected EADDRINUSE'),
      'base control failed before the intended bind assertion',
    );
    requireResult(
      !candidateConnect.output.includes('did not build'),
      'candidate connect control emitted panel build warnings',
    );
    evidence['connectControl'] = { base: connectCodes[0], candidate: connectCodes[1] };
  }
  const peak = await Bun.file('/sys/fs/cgroup/memory.peak').text();
  requireResult(Number(peak) > 0, 'runner did not provide peak memory');
} catch (error) {
  evidence['failure'] = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  if (activeMeasurement !== undefined) {
    try {
      evidence[`${activeMeasurement.label}-sampledCgroupPeakMemoryBytes`] =
        activeMeasurement.stop();
    } catch (error) {
      evidence['memoryMeasurementError'] = String(error);
    }
  }
  for (const run of allRuns) if (!run.finished) run.child.kill('SIGTERM');
  await Promise.allSettled(allRuns.map((run) => run.done));
  for (const sentinel of sentinels) await sentinel.stop(true);
  evidence['runs'] = allRuns.map((run) => ({
    pid: run.child.pid,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exit: run.code,
  }));
  evidence['aggregateCgroupPeakMemoryBytes'] = await Bun.file('/sys/fs/cgroup/memory.peak')
    .text()
    .catch(() => 'unavailable');
  for (const [name, path] of [
    ['a', a],
    ['b', b],
    ['base', control],
    ['bad', bad],
  ] as const) {
    const results = join(path, 'applications/interborough/test-results');
    if (existsSync(results))
      await cp(results, join(output, `browser-${name}`), { recursive: true });
  }
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
