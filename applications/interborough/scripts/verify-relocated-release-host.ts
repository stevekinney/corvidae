import { lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Start the relocated archive with Bun off PATH and verify an external plugin's built panel. */
export async function verifyRelocatedHost(
  root: string,
  prebuilt: readonly string[],
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<void> {
  const home = await mkdtemp(join('/tmp', 'interborough-release-home-'));
  await writeFile(join(home, 'deployment-id'), '01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
  const plugin = join(home, 'plugins', 'runtime-proof');
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugin, 'plugin.ts'),
    `import { definePlugin } from '@lostgradient/interborough-plugin';
import { canonicalJson } from '@lostgradient/interborough-plugin/testing';
const testingExportProof = canonicalJson({ release: 'proof' });
if (testingExportProof !== '{"release":"proof"}') throw new Error('Testing export map is broken');
export default definePlugin({ name: 'runtime-proof', title: 'Runtime proof', version: '1.0.0', description: 'Release proof', setup: () => ({ panels: [{ name: 'external-proof', title: 'External proof', uri: 'ui://runtime-proof/external/v1', entry: new URL('./app.ts', import.meta.url), styles: '', allowedTools: ['bureau.workflows-list'], opensFromTool: 'bureau.workflows-list' }] }) });
`,
  );
  // A Cinder panel: the page the relocated host builds from the plugin runtime with Bun off PATH.
  await writeFile(
    join(plugin, 'app.ts'),
    `import { mountPanel } from '@lostgradient/cinder/panel';
import Proof from './app.svelte';
mountPanel(Proof, { props: { label: 'external runtime' } });
`,
  );
  await writeFile(
    join(plugin, 'app.svelte'),
    `<script lang="ts">
  import { Badge } from '@lostgradient/cinder';
  let { label }: { label: string } = $props();
</script>

<Badge>{label}</Badge>
`,
  );
  const childProcess = Bun.spawn(
    [join(root, 'bin', 'interborough'), 'start', '--port', '0', '--home', home],
    {
      cwd: '/tmp',
      env: { PATH: '', HOME: home, INTERBOROUGH_HOME: home, INTERBOROUGH_PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  // The host binds port 0 itself and reports the port the operating system gave it, so no other
  // process can take the port between choosing it and listening on it.
  const reported = Promise.withResolvers<number | undefined>();
  let sawPort = false;
  const stdout = (async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of childProcess.stdout) {
      text += decoder.decode(chunk, { stream: true });
      const match = text.match(/Interborough is listening on http:\/\/127\.0\.0\.1:(\d+)\n/);
      if (match !== null && !sawPort) {
        sawPort = true;
        reported.resolve(Number(match[1]));
      }
    }
    reported.resolve(undefined);
    return text + decoder.decode();
  })();
  const stderr = new Response(childProcess.stderr).text();
  let stopped = false;
  const stopChild = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (childProcess.exitCode === null || childProcess.exitCode === undefined)
      childProcess.kill('SIGTERM');
    await childProcess.exited;
    await Promise.all([stdout, stderr]);
  };
  try {
    const deadline = now() + 20_000;
    const link = join(home, 'plugins', 'node_modules');
    while (now() < deadline) {
      try {
        await lstat(link);
        break;
      } catch {
        await sleep(100);
      }
    }
    try {
      await lstat(link);
    } catch {
      await stopChild();
      const errorOutput = await stderr;
      throw new Error(
        `Relocated host did not create plugin runtime link (exit ${childProcess.exitCode ?? 'running'}): ${errorOutput}`,
      );
    }
    const target = await readlink(link);
    const expected = join(
      await realpath(root),
      'share',
      'interborough',
      'plugin-runtime',
      'node_modules',
    );
    if ((await realpath(resolve(join(home, 'plugins'), target))) !== (await realpath(expected)))
      throw new Error(`Relocated plugin link targets the wrong runtime: ${target} !== ${expected}`);
    for (const name of prebuilt) {
      if (!(await Bun.file(join(root, 'share', 'interborough', 'panels', `${name}.json`)).exists()))
        throw new Error(`Prebuilt panel ${name} is missing`);
    }
    let listing: Record<string, unknown> | undefined;
    let snapshot: Record<string, unknown> | undefined;
    // Wait for the host's own report of its port: an event, which ends when the host exits too.
    const giveUp = Promise.withResolvers<undefined>();
    const giveUpTimer = setTimeout(() => giveUp.resolve(undefined), 20_000);
    const port = await Promise.race([reported.promise, giveUp.promise]);
    clearTimeout(giveUpTimer);
    while (now() < deadline) {
      // Without a reported port there is nothing to ask; `listing` stays undefined below.
      if (port === undefined) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/host/plugins`);
        if (response.ok) {
          snapshot = (await response.json()) as Record<string, unknown>;
          const plugins = Array.isArray(snapshot['plugins']) ? snapshot['plugins'] : [];
          listing = plugins.find(
            (entry): entry is Record<string, unknown> =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof Reflect.get(Reflect.get(entry, 'descriptor'), 'name') === 'string' &&
              Reflect.get(Reflect.get(entry, 'descriptor'), 'name') === 'runtime-proof',
          );
          if (listing !== undefined) break;
        }
      } catch {
        // The supervisor may not have bound its port yet.
      }
      await sleep(100);
    }
    if (listing === undefined || Reflect.get(listing, 'status') !== 'running') {
      const exitBeforeCleanup = childProcess.exitCode;
      await stopChild();
      const [standardOutput, standardError] = await Promise.all([stdout, stderr]);
      throw new Error(
        `Relocated SDK plugin did not run: ${JSON.stringify(snapshot)}\n` +
          `child exit before cleanup: ${exitBeforeCleanup ?? 'running'}\n` +
          `child exit after cleanup: ${childProcess.exitCode ?? 'running'}\n` +
          `standard output:\n${standardOutput}\n` +
          `standard error:\n${standardError}`,
      );
    }
    const contributions = Reflect.get(listing, 'contributions');
    if (
      !Array.isArray(contributions) ||
      !contributions.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          Reflect.get(entry, 'kind') === 'panel' &&
          Reflect.get(entry, 'id') === 'runtime-proof:external-proof',
      )
    )
      throw new Error('Relocated SDK plugin did not register its external MCP app');
    const appResponse = await fetch(
      `http://127.0.0.1:${port}/host/plugins/runtime-proof/apps/external-proof`,
    );
    if (!appResponse.ok) {
      const problems = listing['problems'];
      throw new Error(
        `External MCP app response was ${appResponse.status}: ${JSON.stringify(problems ?? [])}`,
      );
    }
    const app = (await appResponse.json()) as { html?: unknown };
    if (typeof app.html !== 'string' || !app.html.includes('external runtime'))
      throw new Error('External MCP app response did not contain its generated page');
    // Built with Cinder: the kit's token rule is in the one inline stylesheet, and nothing is loaded
    // from beside the page.
    if (!app.html.includes('--cinder-status-info-background') || /<link\b/.test(app.html))
      throw new Error('External MCP app response was not a self-contained Cinder page');
  } finally {
    try {
      await stopChild();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
