import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { enableDemoPlugin } from '../src/host/demo-plugin-home.ts';
import {
  assertOneRefundResult,
  assertRecoveryManifest,
  recoveryManifest,
  verifyRecovery,
} from './installed-recovery-manifest.ts';
import {
  defaultRunInstalledCliCommand,
  spawn,
  waitForListening,
} from './test-installed-release.ts';

type CommandResult = { exitCode: number; stdout: string; stderr: string };

/** Run against two separately installed packages, retaining each stage under a fresh evidence root. */
export async function rehearseInstalledRecovery(previous: string, candidate: string, root: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This rehearsal requires macOS arm64');
  previous = await realpath(resolve(previous));
  candidate = await realpath(resolve(candidate));
  root = resolve(root);
  if (previous === candidate) throw new Error('The previous and candidate executables must differ');
  await mkdir(root, { recursive: false });
  const artifact = async (executable: string) => {
    const release = JSON.parse(
      await readFile(join(dirname(executable), '..', 'release.json'), 'utf8'),
    ) as { sourceSha?: string; version?: string; target?: string };
    if (
      !/^[a-f0-9]{40}$/.test(release.sourceSha ?? '') ||
      release.target !== 'darwin-arm64' ||
      !release.version
    )
      throw new Error('Invalid installed release identity');
    return {
      executable,
      sha256: createHash('sha256')
        .update(await readFile(executable))
        .digest('hex'),
      ...release,
    };
  };
  const artifacts = { previous: await artifact(previous), candidate: await artifact(candidate) };
  await writeFile(join(root, 'installed-artifacts.json'), JSON.stringify(artifacts, null, 2));
  const home = join(root, 'home');
  const backup = join(root, 'backup');
  const restored = join(root, 'restored');
  const registryRequests: string[] = [];
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      registryRequests.push(request.url);
      return new Response('', { status: 404 });
    },
  });
  const trace: unknown[] = [];
  const binary = Uint8Array.from([0, 1, 127, 128, 255, 0, 42]);
  const digest = createHash('sha256').update(binary).digest('hex');
  const input = join(root, 'asset.bin');

  async function withHost<T>(
    executable: string,
    directory: string,
    action: (url: string) => Promise<T>,
  ): Promise<T> {
    const probe = spawn(
      executable,
      ['start', '--port', '0', '--home', directory],
      directory,
      root,
      registry.url.href,
    );
    let url: string | undefined;
    try {
      const listening = await waitForListening(probe);
      url = `http://127.0.0.1:${listening.port}`;
      return await action(url);
    } finally {
      if (probe.process.exitCode === null) probe.process.kill('SIGTERM');
      const exit = await probe.process.exited;
      await Promise.all([probe.stdout, probe.stderr]);
      if (exit !== 0) throw new Error(`Host shutdown exited ${exit}`);
      const children = [...probe.output().matchAll(/Started the host \(process (\d+)\)/g)].map(
        (match) => Number(match[1]),
      );
      for (const pid of children) {
        try {
          process.kill(pid, 0);
        } catch {
          continue;
        }
        throw new Error(`Host child ${pid} remained after shutdown`);
      }
      if (url !== undefined) {
        let response: Response | undefined;
        try {
          response = await fetch(url);
        } catch {
          /* listener closed */
        }
        if (response !== undefined) throw new Error('Host listener remained after shutdown');
      }
    }
  }
  async function command(
    executable: string,
    directory: string,
    url: string,
    args: string[],
    expected = 0,
  ): Promise<CommandResult> {
    const result = await defaultRunInstalledCliCommand(
      executable,
      [...args, '--url', url],
      directory,
      root,
      registry.url.href,
    );
    trace.push({ executable, args, ...result });
    await writeFile(join(root, 'commands.json'), JSON.stringify(trace, null, 2));
    if (result.exitCode !== expected)
      throw new Error(`${args.join(' ')} exited ${result.exitCode}: ${result.stderr}`);
    return result;
  }
  type CliResponse = {
    data?: {
      assetId?: string;
      reviews?: Array<{ id?: string; runId?: string; sessionId?: string }>;
      values?: Record<string, unknown>;
    };
    continuation?: { runId?: string };
  };
  const json = (result: CommandResult): CliResponse => JSON.parse(result.stdout) as CliResponse;
  try {
    await writeFile(input, binary);
    await enableDemoPlugin(home);
    const seeded = await withHost(previous, home, async (url) => {
      await command(previous, home, url, [
        'settings',
        'set',
        '--input',
        '{"tools.wakeup":false}',
        '--output',
        'json',
      ]);
      const settings = json(
        await command(previous, home, url, ['settings', 'get', '--output', 'json']),
      );
      if (settings.data?.values?.['tools.wakeup'] !== false)
        throw new Error('Previous host did not persist the setting');
      const upload = json(
        await command(previous, home, url, [
          'assets',
          'upload',
          '--file',
          input,
          '--output',
          'json',
        ]),
      );
      const assetId = upload.data?.assetId;
      if (typeof assetId !== 'string') throw new Error('Upload did not return an asset ID');
      const chat = await command(
        previous,
        home,
        url,
        ['chat', '--agent', 'demo:tool-runner', '--message', 'Refund order-1001', '--no-input'],
        5,
      );
      const runId = `${chat.stdout}\n${chat.stderr}`.match(/run-[A-Za-z0-9_-]+/)?.[0];
      const reviews = json(
        await command(previous, home, url, ['reviews', 'list', '--output', 'json']),
      );
      const review = reviews.data?.reviews?.find(
        (entry: { runId?: string }) => entry.runId === runId,
      );
      if (!runId || typeof review?.id !== 'string' || typeof review.sessionId !== 'string')
        throw new Error('The pending review was not found');
      return { assetId, reviewId: review.id, runId, sessionId: review.sessionId, wakeup: 'false' };
    });
    const before = await recoveryManifest(home, [digest], seeded);
    await writeFile(join(root, 'before-manifest.json'), JSON.stringify(before, null, 2));
    await cp(home, backup, { recursive: true, errorOnExist: true, force: false });
    assertRecoveryManifest(await recoveryManifest(backup, [digest], seeded), before);
    await withHost(candidate, home, async (url) => {
      const reviews = json(
        await command(candidate, home, url, ['reviews', 'list', '--output', 'json']),
      );
      if (!reviews.data?.reviews?.some((entry: { id?: string }) => entry.id === seeded.reviewId))
        throw new Error('Candidate lost the pending review');
      const settings = json(
        await command(candidate, home, url, ['settings', 'get', '--output', 'json']),
      );
      if (settings.data?.values?.['tools.wakeup'] !== false)
        throw new Error('Candidate lost the setting');
      const output = join(root, 'candidate-asset.bin');
      await command(candidate, home, url, [
        'assets',
        'download',
        seeded.assetId,
        '--output-file',
        output,
      ]);
      if (
        createHash('sha256')
          .update(await readFile(output))
          .digest('hex') !== digest
      )
        throw new Error('Candidate asset differs');
      await command(candidate, home, url, [
        'settings',
        'set',
        '--input',
        '{"tools.wakeup":true}',
        '--output',
        'json',
      ]);
    });
    await withHost(candidate, home, async (url) => {
      const settings = json(
        await command(candidate, home, url, ['settings', 'get', '--output', 'json']),
      );
      if (settings.data?.values?.['tools.wakeup'] !== true)
        throw new Error('Candidate action did not persist');
    });
    const afterUpgrade = await recoveryManifest(home, [digest], { ...seeded, wakeup: 'true' });
    await writeFile(
      join(root, 'after-upgrade-manifest.json'),
      JSON.stringify(afterUpgrade, null, 2),
    );
    const started = performance.now();
    await cp(backup, restored, { recursive: true, errorOnExist: true, force: false });
    assertRecoveryManifest(await recoveryManifest(restored, [digest], seeded), before);
    await withHost(previous, restored, async (url) => {
      await verifyRecovery(restored, url, join(root, 'before-manifest.json'));
      const settings = json(
        await command(previous, restored, url, ['settings', 'get', '--output', 'json']),
      );
      if (settings.data?.values?.['tools.wakeup'] !== false)
        throw new Error('Restored settings differ');
      const reviews = json(
        await command(previous, restored, url, ['reviews', 'list', '--output', 'json']),
      );
      if (
        !reviews.data?.reviews?.some(
          (entry: { id?: string; runId?: string }) =>
            entry.id === seeded.reviewId && entry.runId === seeded.runId,
        )
      )
        throw new Error('Restored review differs');
      const output = join(root, 'restored-asset.bin');
      await command(previous, restored, url, [
        'assets',
        'download',
        seeded.assetId,
        '--output-file',
        output,
      ]);
      if (
        createHash('sha256')
          .update(await readFile(output))
          .digest('hex') !== digest
      )
        throw new Error('Restored asset differs');
      const approval = json(
        await command(previous, restored, url, ['reviews', 'approve', seeded.reviewId]),
      );
      const continuation = approval.continuation?.runId;
      if (typeof continuation !== 'string')
        throw new Error('Approval did not return a continuation');
      const result = await command(previous, restored, url, [
        'runs',
        'watch',
        '--kind',
        'task',
        continuation,
        '--output',
        'jsonl',
      ]);
      if (!result.stdout.includes('completed')) throw new Error('Continuation did not complete');
      const repeated = await defaultRunInstalledCliCommand(
        previous,
        ['reviews', 'approve', seeded.reviewId, '--url', url],
        restored,
        root,
        registry.url.href,
      );
      trace.push({
        executable: previous,
        args: ['reviews', 'approve', seeded.reviewId],
        ...repeated,
      });
      await writeFile(join(root, 'commands.json'), JSON.stringify(trace, null, 2));
      if (repeated.exitCode === 0) throw new Error('A repeated review was accepted');
    });
    const database = new Database(join(restored, 'database.sqlite'), { readonly: true });
    try {
      const encoded = seeded.sessionId
        .split('')
        .map((character) => character.charCodeAt(0).toString(16).padStart(4, '0'))
        .join('');
      const row = database
        .query<{ value: Uint8Array }, [string]>('SELECT value FROM kv WHERE key = ?')
        .get(`agent-session-v2:body:${encoded}`);
      if (row === null) throw new Error('Restored session is missing');
      const session = JSON.parse(new TextDecoder().decode(row.value)) as {
        conversationHistory?: {
          messages?: Record<
            string,
            { toolResult?: { callId?: string; outcome?: string; content?: unknown } }
          >;
        };
      };
      const prefix = `approval:${seeded.runId}:`;
      if (!seeded.reviewId.startsWith(prefix))
        throw new Error('Review does not belong to the saved run');
      const callId = seeded.reviewId.slice(prefix.length);
      assertOneRefundResult(session.conversationHistory?.messages ?? {}, callId);
    } finally {
      database.close();
    }
    if (registryRequests.length !== 0)
      throw new Error('The installed hosts attempted registry access');
    const receipt = {
      artifacts,
      ...seeded,
      assetSha256: digest,
      recoveryMilliseconds: performance.now() - started,
      registryRequests,
    };
    await writeFile(join(root, 'recovery-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally {
    await registry.stop(true);
  }
}

if (import.meta.main) {
  const [previous, candidate, root] = Bun.argv.slice(2);
  if (!previous || !candidate || !root)
    throw new Error(
      'Expected previous executable, candidate executable, and fresh evidence directory',
    );
  console.info(await rehearseInstalledRecovery(previous, candidate, root));
}
