/** Measure a real settings change against a checkout's normal dev or production command. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { runInProcessGroup } from '../../../scripts/run-exclusively.ts';
import { processEnvironment } from '../src/host/environment-configuration.ts';

if (process.argv[2] === '--supervise') {
  const [, , , checkout, mode] = process.argv;
  if (!checkout || !mode) throw new Error('Missing supervised checkout or mode');
  process.exitCode = await runInProcessGroup(
    ['bun', 'run', '--filter=@lostgradient/interborough', mode],
    {
      cwd: checkout,
      environment: processEnvironment(),
      report: console.error,
      recordProcessGroup: async (group) => {
        console.error(`STARTUP_GROUP ${group}`);
      },
    },
  );
} else {
  const [checkoutArgument, homeArgument, outputArgument, profile] = process.argv.slice(2);
  if (
    !checkoutArgument ||
    !homeArgument ||
    !outputArgument ||
    !['dev', 'production'].includes(profile ?? '')
  ) {
    throw new Error(
      'Usage: bun qualify-startup.ts <checkout> <home> <output.json> <dev|production>',
    );
  }
  const checkout = resolve(checkoutArgument);
  const home = resolve(homeArgument);
  const output = resolve(outputArgument);
  await mkdir(home, { recursive: true });
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: checkout,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (git.exitCode !== 0) throw new Error(new TextDecoder().decode(git.stderr));
  const revision = new TextDecoder().decode(git.stdout).trim();
  const started = performance.now();
  const lines: Array<{ milliseconds: number; text: string }> = [];
  let productionBuildOutput = '';
  const receipt: Record<string, unknown> = {
    revision,
    checkout,
    home,
    profile,
    startedAt: new Date().toISOString(),
    runner: {
      hostname: hostname(),
      cpus: cpus().length,
      load: loadavg(),
      freeMemory: freemem(),
      totalMemory: totalmem(),
    },
  };
  if (profile === 'production') {
    const buildStarted = performance.now();
    const build = Bun.spawn(['bun', import.meta.path, '--supervise', checkout, 'build'], {
      cwd: checkout,
      env: { ...processEnvironment(), INTERBOROUGH_STARTUP_PROFILE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    receipt.productionBuild = {
      milliseconds: performance.now() - buildStarted,
      exit,
      stdout,
      stderr,
    };
    productionBuildOutput = `${stdout}\n${stderr}`;
    if (exit !== 0) {
      await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
      throw new Error(`Production build exited ${exit}`);
    }
  }
  const command = [
    'bun',
    import.meta.path,
    '--supervise',
    checkout,
    profile === 'dev' ? 'dev' : 'start',
  ];
  receipt.command = [
    'bun',
    'run',
    '--filter=@lostgradient/interborough',
    profile === 'dev' ? 'dev' : 'start',
  ];
  const host = Bun.spawn(command, {
    cwd: checkout,
    env: {
      ...processEnvironment(),
      INTERBOROUGH_HOME: home,
      INTERBOROUGH_PORT: '0',
      INTERBOROUGH_STARTUP_PROFILE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let resolveListener!: (url: string) => void;
  const listener = new Promise<string>((resolvePromise) => {
    resolveListener = resolvePromise;
  });
  async function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      pending += result.value;
      const chunks = pending.split('\n');
      pending = chunks.pop() ?? '';
      for (const line of chunks) {
        lines.push({ milliseconds: performance.now() - started, text: line });
        const match = /Interborough is listening on (http:\/\/\S+)/.exec(line);
        if (match?.[1]) resolveListener(match[1]);
      }
    }
    if (pending) lines.push({ milliseconds: performance.now() - started, text: pending });
  }
  const streams = Promise.all([collect(host.stdout), collect(host.stderr)]);
  try {
    const url = await Promise.race([
      listener,
      host.exited.then((code) => {
        throw new Error(`Host exited before listening: ${code}`);
      }),
    ]);
    receipt.listenerMilliseconds = performance.now() - started;
    receipt.url = url;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const settingsResponse = page.waitForResponse((response) => {
        const request = response.request();
        if (!request.url().endsWith('/bureau/jsonrpc') || request.method() !== 'POST') return false;
        try {
          return (
            JSON.parse(request.postData() ?? '{}').method === 'bureau.settings.get' && response.ok()
          );
        } catch {
          return false;
        }
      });
      const [navigation, response] = await Promise.all([
        page.goto(new URL('/settings/data-and-retention', url).href),
        settingsResponse,
      ]);
      const settingsBody: unknown = await response.json();
      if (
        typeof settingsBody !== 'object' ||
        settingsBody === null ||
        !('result' in settingsBody)
      ) {
        throw new Error('Settings request returned no result');
      }
      receipt.settingsRequestMilliseconds = performance.now() - started;
      const row = page.locator('[data-setting="retention.audit"]');
      const days = row.getByRole('spinbutton');
      const previous = await days.inputValue();
      const next = previous === '365' ? '90' : '365';
      await days.fill(next);
      await days.blur();
      await row.getByText('Saved just now').waitFor();
      await page.reload();
      await expect(days).toHaveValue(next);
      const persisted = await days.inputValue();
      if (navigation?.status() !== 200 || persisted !== next || errors.length > 0) {
        throw new Error(
          JSON.stringify({ status: navigation?.status(), persisted, expected: next, errors }),
        );
      }
      receipt.actionMilliseconds = performance.now() - started;
      receipt.settings = { previous, persisted, errors };
    } finally {
      await browser.close();
    }
  } catch (error) {
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    host.kill('SIGTERM');
    const hostExit = await host.exited;
    receipt.hostExit = hostExit;
    if (hostExit !== 0 && hostExit !== 143) {
      receipt.cleanupError = `The supervised host exited ${hostExit}`;
      process.exitCode = 1;
    }
    await streams;
    receipt.missingStages = ['cinder', 'ui-bundle', 'panel'].filter(
      (stage) =>
        !productionBuildOutput.includes(`"stage":"${stage}"`) &&
        !lines.some(({ text }) => text.includes(`"stage":"${stage}"`)),
    );
    receipt.lines = lines;
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}
