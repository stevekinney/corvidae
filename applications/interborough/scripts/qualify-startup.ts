/** Measure a real settings change against a checkout's normal dev or production command. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { runInProcessGroup } from '../../../scripts/run-exclusively.ts';
import { processEnvironment } from '../src/host/environment-configuration.ts';

export function isSettingsRequest(
  url: string,
  origin: string,
  verb: string,
  body: string | null,
): boolean {
  const parsed = new URL(url);
  if (parsed.origin !== origin || parsed.pathname !== '/jsonrpc' || verb !== 'POST') return false;
  try {
    return JSON.parse(body ?? '{}').method === 'bureau.settings.get';
  } catch {
    return false;
  }
}

export function panelOutcomes(
  expected: readonly string[],
  mounted: readonly string[],
  reason = 'not listed by /host/panels; see startup log',
) {
  return expected.map((id) => ({
    id,
    outcome: mounted.includes(id) ? 'ready' : 'optional-degraded',
    ...(mounted.includes(id) ? {} : { reason }),
  }));
}

/** Classify observed evidence separately from whether all candidate stage events were emitted. */
export function classifyStartupReceipt(value: unknown): {
  action: 'valid' | 'invalid';
  instrumentation: 'complete' | 'incomplete';
} {
  const result = z
    .object({
      listenerMilliseconds: z.number().nonnegative(),
      settingsRequestMilliseconds: z.number().nonnegative(),
      actionMilliseconds: z.number().nonnegative(),
      navigation: z.object({ status: z.literal(200) }),
      settingsRequest: z.object({
        sameOrigin: z.literal(true),
        path: z.literal('/jsonrpc'),
        method: z.literal('POST'),
        rpcMethod: z.literal('bureau.settings.get'),
        status: z.number().min(200).max(299),
      }),
      settings: z.object({
        field: z.literal('retention.audit'),
        previous: z.string(),
        requested: z.string(),
        persisted: z.string(),
        errors: z.array(z.unknown()).length(0),
      }),
      missingStages: z.array(z.string()),
      inventoryError: z.string().optional(),
      cleanupError: z.string().optional(),
      qualification: z.object({
        name: z.literal('ordinary-empty-home'),
        required: z.array(z.object({ name: z.string(), outcome: z.string() })),
        expectedPanels: z.array(z.string()),
        panels: z.array(
          z.object({ id: z.string(), outcome: z.string(), reason: z.string().optional() }),
        ),
      }),
    })
    .safeParse(value);
  if (!result.success) return { action: 'invalid', instrumentation: 'incomplete' };
  const receipt = result.data;
  const required = receipt.qualification.required;
  const actionValid =
    receipt.listenerMilliseconds <= receipt.settingsRequestMilliseconds &&
    receipt.settingsRequestMilliseconds <= receipt.actionMilliseconds &&
    receipt.settings.previous !== receipt.settings.requested &&
    receipt.settings.requested === receipt.settings.persisted &&
    ['shell', 'settings-save-and-reload'].every(
      (name) =>
        required.filter((entry) => entry.name === name && entry.outcome === 'ready').length === 1 &&
        required.filter((entry) => entry.name === name).length === 1,
    );
  const { expectedPanels, panels } = receipt.qualification;
  const inventoryValid =
    expectedPanels.length > 0 &&
    new Set(expectedPanels).size === expectedPanels.length &&
    panels.length === expectedPanels.length &&
    expectedPanels.every(
      (id) =>
        /^inspectors:[^:]+$/.test(id) && panels.filter((panel) => panel.id === id).length === 1,
    ) &&
    panels.every(
      (panel) =>
        panel.outcome === 'ready' ||
        (panel.outcome === 'optional-degraded' && Boolean(panel.reason?.trim())),
    );
  return {
    action: actionValid ? 'valid' : 'invalid',
    instrumentation:
      actionValid &&
      inventoryValid &&
      receipt.missingStages.length === 0 &&
      receipt.inventoryError === undefined &&
      receipt.cleanupError === undefined
        ? 'complete'
        : 'incomplete',
  };
}

if (import.meta.main && process.argv[2] === '--profile-control') {
  const outcomes = panelOutcomes(['inspectors:one', 'inspectors:two'], ['inspectors:one']);
  if (
    outcomes[0]?.outcome !== 'ready' ||
    outcomes[1]?.outcome !== 'optional-degraded' ||
    !outcomes[1]?.reason
  ) {
    throw new Error('Panel profile control failed');
  }
  console.log(JSON.stringify({ profileControl: 'passed', outcomes }));
} else if (import.meta.main && process.argv[2] === '--matcher-control') {
  const origin = 'http://127.0.0.1:1234';
  const body = JSON.stringify({ method: 'bureau.settings.get' });
  const cases = [
    isSettingsRequest(`${origin}/jsonrpc`, origin, 'POST', body),
    isSettingsRequest(`${origin}/bureau/jsonrpc`, origin, 'POST', body),
    isSettingsRequest('http://127.0.0.1:1235/jsonrpc', origin, 'POST', body),
    isSettingsRequest(`${origin}/jsonrpc`, origin, 'GET', body),
    isSettingsRequest(
      `${origin}/jsonrpc`,
      origin,
      'POST',
      JSON.stringify({ method: 'bureau.settings.schema' }),
    ),
    isSettingsRequest(`${origin}/jsonrpc`, origin, 'POST', '{'),
  ];
  if (JSON.stringify(cases) !== JSON.stringify([true, false, false, false, false, false])) {
    throw new Error('Settings response matcher control failed');
  }
  console.log(JSON.stringify({ matcherControl: 'passed', cases }));
} else if (import.meta.main && process.argv[2] === '--supervise') {
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
} else if (import.meta.main) {
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
  const checkout = resolvePath(checkoutArgument);
  const home = resolvePath(homeArgument);
  const output = resolvePath(outputArgument);
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
    receipt['productionBuild'] = {
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
  receipt['command'] = [
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
  const listener = new Promise<string>((resolve) => {
    resolveListener = resolve;
  });
  async function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      const chunks = pending.split('\n');
      pending = chunks.pop() ?? '';
      for (const line of chunks) {
        lines.push({ milliseconds: performance.now() - started, text: line });
        const match = /Interborough is listening on (http:\/\/\S+)/.exec(line);
        if (match?.[1]) resolveListener(match[1]);
      }
    }
    pending += decoder.decode();
    if (pending) lines.push({ milliseconds: performance.now() - started, text: pending });
  }
  const streams = Promise.all([collect(host.stdout), collect(host.stderr)]);
  let listenerUrl: string | undefined;
  let shellReady = false;
  let settingsReady = false;
  try {
    const url = await Promise.race([
      listener,
      host.exited.then((code) => {
        throw new Error(`Host exited before listening: ${code}`);
      }),
    ]);
    listenerUrl = url;
    receipt['listenerMilliseconds'] = performance.now() - started;
    receipt['url'] = url;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: Array<{ name: string; messageLength: number }> = [];
      const consoleMessages: Array<{ type: string; length: number }> = [];
      const responses: Array<{
        milliseconds: number;
        kind: string;
        method: string;
        settingsGet: boolean;
        status: number;
      }> = [];
      const failedRequests: Array<{ milliseconds: number; kind: string }> = [];
      const requestKind = (requestUrl: string): string => {
        const path = new URL(requestUrl).pathname;
        if (path === '/jsonrpc') return 'jsonrpc';
        if (path === '/settings/data-and-retention') return 'settings-navigation';
        return path.startsWith('/assets/') ? 'asset' : 'other';
      };
      receipt['browser'] = { errors, consoleMessages, responses, failedRequests };
      page.on('pageerror', (error) =>
        errors.push({ name: error.name, messageLength: error.message.length }),
      );
      page.on('console', (message) =>
        consoleMessages.push({ type: message.type(), length: message.text().length }),
      );
      page.on('response', (response) => {
        const request = response.request();
        if (responses.length < 50)
          responses.push({
            milliseconds: performance.now() - started,
            kind: requestKind(response.url()),
            method: request.method(),
            settingsGet: isSettingsRequest(
              request.url(),
              new URL(url).origin,
              request.method(),
              request.postData(),
            ),
            status: response.status(),
          });
      });
      page.on('requestfailed', (request) => {
        if (failedRequests.length < 50)
          failedRequests.push({
            milliseconds: performance.now() - started,
            kind: requestKind(request.url()),
          });
      });
      const settingsResponse = page.waitForResponse((response) => {
        const request = response.request();
        return (
          response.ok() &&
          isSettingsRequest(
            request.url(),
            new URL(url).origin,
            request.method(),
            request.postData(),
          )
        );
      });
      const [navigation, response] = await Promise.all([
        page.goto(new URL('/settings/data-and-retention', url).href).then((result) => {
          receipt['navigation'] = {
            status: result?.status() ?? null,
            milliseconds: performance.now() - started,
          };
          return result;
        }),
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
      receipt['settingsRequestMilliseconds'] = performance.now() - started;
      receipt['settingsRequest'] = {
        sameOrigin: isSettingsRequest(
          response.request().url(),
          new URL(url).origin,
          response.request().method(),
          response.request().postData(),
        ),
        path: '/jsonrpc',
        method: 'POST',
        rpcMethod: 'bureau.settings.get',
        status: response.status(),
      };
      const row = page.locator('[data-setting="retention.audit"]');
      const days = row.getByRole('spinbutton');
      await days.waitFor();
      shellReady = true;
      const previous = await days.inputValue();
      const next = previous === '365' ? '90' : '365';
      await days.fill(next);
      await days.blur();
      await row.getByText('Saved just now').waitFor();
      await page.reload();
      await expect(days).toHaveValue(next);
      const persisted = await days.inputValue();
      if (
        navigation?.status() !== 200 ||
        persisted !== next ||
        errors.length > 0 ||
        consoleMessages.some((entry) => entry.type === 'error')
      ) {
        throw new Error(
          JSON.stringify({ status: navigation?.status(), persisted, expected: next, errors }),
        );
      }
      receipt['actionMilliseconds'] = performance.now() - started;
      settingsReady = true;
      receipt['settings'] = {
        field: 'retention.audit',
        previous,
        requested: next,
        persisted,
        errors,
      };
    } finally {
      await browser.close();
    }
  } catch (error) {
    receipt['error'] = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  }
  {
    // Inventory follows the timed action, even if it failed, so it cannot warm source files first.
    let expected: string[] = [];
    try {
      const identities = z
        .object({ entries: z.array(z.object({ kind: z.string(), id: z.string() })) })
        .parse(
          await Bun.file(resolvePath(checkout, 'plugins/inspectors/plugin-identities.json')).json(),
        );
      expected = identities.entries
        .filter((entry) => entry.kind === 'panel')
        .map((entry) => entry.id);
      if (expected.length === 0 || expected.some((id) => !id.startsWith('inspectors:'))) {
        throw new Error('The ordinary profile has no valid inspector panel inventory');
      }
      if (listenerUrl === undefined)
        throw new Error('No listener was available for panel inventory');
      const panelsResponse = await fetch(new URL('/host/panels', listenerUrl));
      if (!panelsResponse.ok) throw new Error(`/host/panels returned ${panelsResponse.status}`);
      const panels = z
        .object({ apps: z.array(z.object({ plugin: z.string(), app: z.string() })) })
        .parse(await panelsResponse.json());
      receipt['qualification'] = {
        name: 'ordinary-empty-home',
        required: [
          { name: 'shell', outcome: shellReady ? 'ready' : 'failed' },
          { name: 'settings-save-and-reload', outcome: settingsReady ? 'ready' : 'failed' },
        ],
        panelSources: [
          'applications/interborough/src/host/plugins.ts',
          'plugins/inspectors/plugin-identities.json',
          'plugins/inspectors/src/plugin.ts',
        ],
        expectedPanels: expected,
        panels: panelOutcomes(
          expected,
          panels.apps.map(({ plugin, app }) => `${plugin}:${app}`),
        ),
      };
    } catch (error) {
      receipt['inventoryError'] = error instanceof Error ? error.message : String(error);
      receipt['qualification'] = {
        name: 'ordinary-empty-home',
        required: [
          { name: 'shell', outcome: shellReady ? 'ready' : 'failed' },
          { name: 'settings-save-and-reload', outcome: settingsReady ? 'ready' : 'failed' },
        ],
        panelSources: ['plugins/inspectors/plugin-identities.json'],
        expectedPanels: expected,
        panels: panelOutcomes(expected, [], 'panel inventory could not be observed'),
      };
      process.exitCode = 1;
    }
    host.kill('SIGTERM');
    const hostExit = await host.exited;
    receipt['hostExit'] = hostExit;
    if (hostExit !== 0 && hostExit !== 143) {
      receipt['cleanupError'] = `The supervised host exited ${hostExit}`;
      process.exitCode = 1;
    }
    await streams;
    receipt['pluginStatuses'] = lines.flatMap(({ text }) => {
      const match = /Plugin ([^@\s]+)@[^ ]+ \([^)]*\): ([^;\s]+)/.exec(text);
      return match?.[1] && match[2] ? [{ plugin: match[1], status: match[2] }] : [];
    });
    receipt['missingStages'] = ['cinder', 'ui-bundle', 'panel'].filter(
      (stage) =>
        !productionBuildOutput.includes(`"stage":"${stage}"`) &&
        !lines.some(({ text }) => text.includes(`"stage":"${stage}"`)),
    );
    receipt['contract'] = classifyStartupReceipt(receipt);
    receipt['lines'] = lines;
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}
