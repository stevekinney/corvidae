import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const evidence = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-consumer-'));
  const packageDirectory = resolve(import.meta.dir, '..');
  try {
    const stagedPackage = join(directory, 'package');
    await mkdir(stagedPackage);
    await cp(join(packageDirectory, 'package.json'), join(stagedPackage, 'package.json'));
    await cp(join(packageDirectory, 'src'), join(stagedPackage, 'src'), { recursive: true });
    const archive = 'mcp.tgz';
    const pack = spawnWithHangGuard(['tar', '-czf', archive, 'package'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const packExit = await pack.exited;
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { '@lostgradient/mcp': `file:./${archive}` },
      }),
    );
    const install = spawnWithHangGuard([process.execPath, 'install'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const installExit = await install.exited;
    const manifest = await Bun.file(
      join(directory, 'node_modules/@lostgradient/mcp/package.json'),
    ).json();
    const dependencies = JSON.stringify(manifest.dependencies ?? {});
    await writeFile(
      join(directory, 'listener.ts'),
      `import { createProtectedHttpHandler } from '@lostgradient/mcp/http';\nconst handler = createProtectedHttpHandler({ origin: 'https://example.com', resourcePath: '/mcp', issuer: 'https://issuer.example', scopes: [], verifyAccessToken: async () => null, resolvePrincipal: async () => null, dispatch: () => new Response() });\nconst server = Bun.serve({port: 0, fetch: handler});\nconst response = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', server.url));\nserver.stop(true);\nif (response.status !== 200) process.exit(1);`,
    );
    const listener = spawnWithHangGuard([process.execPath, 'listener.ts'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const listenerExit = await listener.exited;
    return { packExit, installExit, dependencies, listenerExit };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test('an independent listener installs the HTTP entry without provider dependencies', () => {
  expect(evidence.packExit).toBe(0);
  expect(evidence.installExit).toBe(0);
  expect(evidence.dependencies).not.toMatch(/backchannel|velveteen/i);
  expect(evidence.listenerExit).toBe(0);
});
