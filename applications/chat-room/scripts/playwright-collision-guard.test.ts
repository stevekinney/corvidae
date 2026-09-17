import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import playwrightConfig from '../playwright.config.ts';

/**
 * Proves the CIN-509 guard the way the issue asks: occupy a `webServer` port
 * with a server that belongs to "another checkout", run the suite, and assert
 * it refuses loudly instead of silently adopting the server.
 *
 * Two layers, because Playwright starts `webServer` entries in order and only
 * reaches a later entry's port after the earlier ones are up — a held dev port
 * (5175) is only checked after the preview has been built and started, which
 * is seconds of work that has nothing to do with the property under test:
 *
 * 1. The MECHANISM is proven live against the first entry (the fixture on
 *    4599): a fake foreign server holds the port, Playwright is spawned with
 *    `CI` cleared, and the run must refuse at startup naming the port.
 * 2. Every entry's `reuseExistingServer: false` is pinned by reading the config
 *    itself, so one entry drifting to the docs' recommended `!process.env.CI`
 *    (which would reopen the bug for that server alone) fails here.
 *
 * No timeouts, by design. The child is spawned asynchronously so the fake can
 * serve requests, and the fake ends the run deterministically: the only way it
 * ever receives an HTTP request is if Playwright adopted it and started running
 * specs — the drifted-config failure this test exists to catch — so the first
 * request kills the child and the assertions read the result. On the correct
 * config Playwright refuses before making any request and the run ends on its
 * own in about a second.
 */
const LAB_ROOT = join(import.meta.dir, '..');

/** The `webServer` entries as configured, in start order. */
const WEB_SERVERS = Array.isArray(playwrightConfig.webServer)
  ? playwrightConfig.webServer
  : playwrightConfig.webServer
    ? [playwrightConfig.webServer]
    : [];
const FIRST_PORT = WEB_SERVERS[0]?.port;

function matchesSpecification(
  path: string,
  patterns: string | RegExp | Array<string | RegExp> | undefined,
): boolean {
  return (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) => {
    if (pattern === undefined) return false;
    return typeof pattern === 'string' ? new Bun.Glob(pattern).match(path) : pattern.test(path);
  });
}

test('split specifications retain every browser project selected for their original file', () => {
  const parts = [...new Bun.Glob('src/**/*.part-*.e2e.ts').scanSync(LAB_ROOT)];
  expect(parts.length).toBeGreaterThan(0);
  for (const path of parts) {
    const originalPath = path.replace(/\.part-\d+(?=\.e2e\.ts$)/, '');
    for (const project of playwrightConfig.projects ?? []) {
      const match = project.testMatch ?? playwrightConfig.testMatch;
      const ignore = project.testIgnore ?? playwrightConfig.testIgnore;
      if (
        matchesSpecification(originalPath, match) &&
        !matchesSpecification(originalPath, ignore)
      ) {
        expect(
          matchesSpecification(path, match) && !matchesSpecification(path, ignore),
          `${project.name}: ${path}`,
        ).toBe(true);
      }
    }
  }
});

test('browser capability contracts select supported engines explicitly', () => {
  const clipboard = 'src/routes/exercises/utilities/utilities.clipboard.e2e.ts';
  const nativeTab =
    'src/routes/exercises/review-ssr-and-a11y/review-ssr-and-a11y.native-tab.e2e.ts';
  const projectsFor = (path: string) =>
    (playwrightConfig.projects ?? [])
      .filter(
        (project) =>
          matchesSpecification(path, project.testMatch ?? playwrightConfig.testMatch) &&
          !matchesSpecification(path, project.testIgnore ?? playwrightConfig.testIgnore),
      )
      .map((project) => project.name);
  expect(projectsFor(clipboard)).toEqual(['chromium']);
  expect(
    projectsFor('src/routes/exercises/conversation-list/conversation-list.clipboard.e2e.ts'),
  ).toEqual(['chromium']);
  expect(projectsFor(nativeTab)).toEqual(['chromium', 'firefox']);
});

function listenOrExplain(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is already held — by another checkout's server, or a stray one; this test needs it free to stand in as the foreign server`,
            )
          : error,
      );
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('chat-room Playwright refuses a web server it did not start', () => {
  let fake: Server | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;

  afterEach(async () => {
    if (child) {
      child.kill();
      await child.exited;
      child = undefined;
    }
    if (fake) {
      const server = fake;
      fake = undefined;
      // Only a listening server can be closed; when `listenOrExplain()` failed the
      // real error must surface rather than an ERR_SERVER_NOT_RUNNING from here.
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('every webServer entry sets reuseExistingServer to false', () => {
    expect(WEB_SERVERS.map((entry) => entry.port)).toEqual([4599, 4173, 5175]);
    for (const entry of WEB_SERVERS) {
      expect(entry.reuseExistingServer, `port ${entry.port}: ${entry.command}`).toBe(false);
    }
  });

  test('a held port fails the run at startup and names the port', async () => {
    expect(FIRST_PORT).toBeDefined();
    if (FIRST_PORT === undefined) return;
    let adopted = false;

    fake = createServer((_request, response) => {
      // Playwright only talks HTTP to this port if it adopted the fake and
      // began running specs against it. End the run right here.
      adopted = true;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>another checkout</title>');
      child?.kill();
    });
    await listenOrExplain(fake, FIRST_PORT);

    const environment = { ...process.env };
    delete environment['CI'];
    child = Bun.spawn(
      ['bunx', 'playwright', 'test', '--project=chromium', 'src/routes/page.svelte.e2e.ts'],
      { cwd: LAB_ROOT, env: environment, stdout: 'pipe', stderr: 'pipe' },
    );
    const stdoutPipe = child.stdout;
    const stderrPipe = child.stderr;
    if (stdoutPipe === undefined || typeof stdoutPipe === 'number') {
      throw new Error('Playwright child stdout was not piped.');
    }
    if (stderrPipe === undefined || typeof stderrPipe === 'number') {
      throw new Error('Playwright child stderr was not piped.');
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(stdoutPipe).text(),
      new Response(stderrPipe).text(),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(
      adopted,
      `Playwright adopted the fake server on port ${FIRST_PORT} and ran specs against it:\n${output}`,
    ).toBe(false);
    expect(exitCode, output).not.toBe(0);
    expect(output).toContain(`http://localhost:${FIRST_PORT} is already used`);
    expect(output).not.toMatch(/\d+ passed/);
  });
});
