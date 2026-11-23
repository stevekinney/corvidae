import { expect, test } from 'bun:test';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('an independent listener installs the HTTP entry without provider dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-consumer-'));
  const packageDirectory = resolve(import.meta.dir, '..');
  try {
    const stagedPackage = join(directory, 'package');
    await mkdir(stagedPackage);
    await cp(join(packageDirectory, 'package.json'), join(stagedPackage, 'package.json'));
    await cp(join(packageDirectory, 'src'), join(stagedPackage, 'src'), { recursive: true });
    const archive = 'mcp.tgz';
    const pack = Bun.spawn(['tar', '-czf', archive, 'package'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await pack.exited).toBe(0);
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
    expect(await install.exited).toBe(0);
    const manifest = await Bun.file(
      join(directory, 'node_modules/@lostgradient/mcp/package.json'),
    ).json();
    expect(JSON.stringify(manifest.dependencies ?? {})).not.toMatch(/backchannel|velveteen/i);
    await writeFile(
      join(directory, 'listener.ts'),
      `import { createProtectedHttpHandler } from '@lostgradient/mcp/http';\nconst handler = createProtectedHttpHandler({ origin: 'https://example.com', resourcePath: '/mcp', issuer: 'https://issuer.example', scopes: [], verifyAccessToken: async () => null, resolvePrincipal: async () => null, dispatch: () => new Response() });\nconst server = Bun.serve({port: 0, fetch: handler});\nconst response = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', server.url));\nserver.stop(true);\nif (response.status !== 200) process.exit(1);`,
    );
    const listener = spawnWithHangGuard([process.execPath, 'listener.ts'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await listener.exited).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
