import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';

const root = resolve(import.meta.dir, '../..');
const output = join(process.env['RUNNER_TEMP'] ?? root, 'cor-2653-qualification');
const candidate = process.env['QUALIFICATION_SHA'] ?? '';
const request = process.env['QUALIFICATION_REQUEST'] ?? '';
const base = '299f3776324f7ea124e635c3befc1f493ae55e87';
await mkdir(output, { recursive: true });
if (request !== `COR-2653-qualification:${candidate}` || !/^[a-f0-9]{40}$/.test(candidate))
  throw new Error('Qualification request must name the exact checked-out SHA.');

type Run = {
  child: ReturnType<typeof Bun.spawn>;
  output: string;
  finished: boolean;
  code?: number;
  startedAt: string;
  finishedAt?: string;
  done: Promise<number>;
};
function start(
  name: string,
  cwd: string,
  command: string[],
  variables: Record<string, string> = {},
): Run {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...variables },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const run: Run = {
    child,
    output: '',
    finished: false,
    startedAt: new Date().toISOString(),
    done: Promise.resolve(1),
  };
  const forward = async (stream: ReadableStream<Uint8Array>) => {
    for await (const bytes of stream) {
      const chunk = new TextDecoder().decode(bytes);
      run.output += chunk;
      await appendFile(join(output, `${name}.log`), chunk);
    }
  };
  run.done = Promise.all([
    child.exited,
    forward(child.stdout as ReadableStream<Uint8Array>),
    forward(child.stderr as ReadableStream<Uint8Array>),
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
const worktrees = join(output, 'worktrees');
const a = join(worktrees, 'a');
const b = join(worktrees, 'b');
const control = join(worktrees, 'base');
const bad = join(worktrees, 'bad');
const allRuns: Run[] = [];
const sentinels: ReturnType<typeof Bun.serve>[] = [];
const evidence: Record<string, unknown> = {
  base,
  candidate,
  runner: process.platform,
  architecture: process.arch,
  workers: 1,
  playwrightRetries: 0,
  hangGuardMilliseconds: 120000,
  testTimeoutMilliseconds: 240000,
};
try {
  await mkdir(worktrees, { recursive: true });
  for (const [name, path, revision] of [
    ['a', a, candidate],
    ['b', b, candidate],
    ['base', control, base],
    ['bad', bad, candidate],
  ] as const) {
    await command(`checkout-${name}`, root, ['git', 'worktree', 'add', '--detach', path, revision]);
    await command(`install-${name}`, path, ['bun', 'install', '--frozen-lockfile']);
    await command(`metadata-${name}`, path, ['bunx', 'turbo', 'run', 'metadata']);
  }
  for (let port = 7399; port <= 7406; port += 1)
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
  const qualification = ['tests/e2e/browser-isolation.qualification.ts', '--reporter=line'];
  const shared = { COR_2653_QUALIFICATION: '1', COR_2653_REVISION: candidate.slice(0, 7) };
  const first = browser('concurrent-a', a, qualification, {
    ...shared,
    INTERBOROUGH_E2E_RUN_ID: 'A',
  });
  const second = browser('concurrent-b', b, qualification, {
    ...shared,
    INTERBOROUGH_E2E_RUN_ID: 'B',
  });
  const [firstPort, secondPort] = await Promise.all([ready(first), ready(second)]);
  requireResult(Math.abs(firstPort - secondPort) >= 8, 'A and B have overlapping port blocks');
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
  for (const port of [firstPort, secondPort])
    for (let offset = 0; offset < 8; offset += 1) {
      const response = await fetch(
        `http://127.0.0.1:${String(port + offset)}${offset === 1 ? '/waiting' : '/'}`,
        { headers: { accept: 'text/html' } },
      );
      requireResult(response.ok, `missing listener at ${String(port + offset)}`);
    }
  for (let port = 7399; port <= 7406; port += 1)
    requireResult(
      (await (await fetch(`http://127.0.0.1:${String(port)}`)).text()) ===
        `sentinel-${String(port)}`,
      `sentinel ${String(port)} changed`,
    );
  first.child.kill('SIGTERM');
  first.child.kill('SIGTERM');
  const firstExit = await first.done;
  requireResult(!second.finished, 'B ended before A stopped');
  await json(secondPort + 1, '/qualification', 'POST');
  const secondExit = await second.done;
  requireResult(secondExit === 0, `B failed with ${String(secondExit)}`);
  evidence['concurrent'] = {
    firstPort,
    secondPort,
    identities,
    firstExit,
    secondExit,
    firstStarted: first.startedAt,
    firstFinished: first.finishedAt,
    secondStarted: second.startedAt,
    secondFinished: second.finishedAt,
  };
  const race = browser('allocation-race', a, [
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
  const collisionPort = allocatedPort + 1;
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
  requireResult(
    (await (await fetch(`http://127.0.0.1:${String(collisionPort)}`)).text()) === 'race sentinel',
    'race sentinel changed',
  );
  requireResult((await race.done) === 0, 'allocation race failed');
  evidence['allocationRace'] = { collisionPort, exit: race.code };
  const explicit = browser('occupied-override', a, qualification, {
    ...shared,
    INTERBOROUGH_E2E_PORT: '7399',
  });
  requireResult(
    (await explicit.done) === 2 && explicit.output.includes('not a free block'),
    'occupied override did not fail clearly',
  );
  evidence['override'] = { exit: explicit.code };
  const integrationPath = 'applications/interborough/src/host/supervisor.integration.test.ts';
  const integration = (name: string, path: string) => {
    const run = start(name, path, ['bun', 'scripts/bun-test.ts', integrationPath]);
    allRuns.push(run);
    return run;
  };
  const seeded = (name: string, path: string) =>
    browser(name, path, [
      'tests/e2e/29-goals.spec.ts',
      '--grep',
      'lists the seeded goal at 375 pixels',
      '--reporter=line',
    ]);
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
    for (const order of [
      'integration-first',
      'browser-first',
      'concurrent',
      'competing-worktree',
    ] as const) {
      let integrationResult: Run | undefined;
      let browserResult: Run | undefined;
      const integrationRun = () =>
        (integrationResult = integration(`${label}-${order}-integration`, path));
      const browserRun = () => (browserResult = seeded(`${label}-${order}-browser`, path));
      let codes: number[];
      if (order === 'competing-worktree') {
        const competitor = browser(`${label}-competitor`, b, qualification, {
          ...shared,
          INTERBOROUGH_E2E_RUN_ID: `${label}-competitor`,
        });
        const competitorPort = await ready(competitor);
        const x = integrationRun();
        const y = browserRun();
        codes = await Promise.all([x.done, y.done]);
        requireResult(!competitor.finished, 'competing worktree ended before the cases');
        await json(competitorPort + 1, '/qualification', 'POST');
        requireResult((await competitor.done) === 0, 'competing worktree failed');
        evidence[`${label}-overlap`] = {
          competitorStarted: competitor.startedAt,
          competitorFinished: competitor.finishedAt,
          integrationStarted: x.startedAt,
          integrationFinished: x.finishedAt,
          browserStarted: y.startedAt,
          browserFinished: y.finishedAt,
        };
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
  const connectTest = 'applications/interborough/tests/e2e/connect-host.integration.test.ts';
  await writeFile(join(control, connectTest), await readFile(join(a, connectTest)));
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
    !candidateConnect.output.includes('did not build'),
    'candidate connect control emitted panel build warnings',
  );
  evidence['connectControl'] = { base: connectCodes[0], candidate: connectCodes[1] };
  const peak = await Bun.file('/sys/fs/cgroup/memory.peak').text();
  requireResult(Number(peak) > 0, 'runner did not provide peak memory');
} catch (error) {
  evidence['failure'] = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  for (const run of allRuns) if (!run.finished) run.child.kill('SIGTERM');
  await Promise.allSettled(allRuns.map((run) => run.done));
  for (const sentinel of sentinels) sentinel.stop(true);
  evidence['runs'] = allRuns.map((run) => ({
    pid: run.child.pid,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exit: run.code,
  }));
  evidence['memoryPeakBytes'] = await Bun.file('/sys/fs/cgroup/memory.peak')
    .text()
    .catch(() => 'unavailable');
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
