import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const evidence = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-consumer-'));
  const packageDirectory = resolve(import.meta.dir, '..');
  try {
    const stagedPackage = join(directory, 'package');
    const packageManifest = await Bun.file(join(packageDirectory, 'package.json')).json();
    const httpEntry = packageManifest.exports['./http'];
    if (typeof httpEntry !== 'string' || !httpEntry.startsWith('./src/'))
      throw new Error('The MCP HTTP export must name a source file');
    const stagedEntry = join(stagedPackage, httpEntry);
    await mkdir(dirname(stagedEntry), { recursive: true });
    await cp(join(packageDirectory, httpEntry), stagedEntry);
    await writeFile(
      join(stagedPackage, 'package.json'),
      JSON.stringify({
        name: packageManifest.name,
        version: packageManifest.version,
        private: packageManifest.private,
        type: packageManifest.type,
        exports: { './http': httpEntry },
        sideEffects: packageManifest.sideEffects,
      }),
    );
    const archive = 'mcp.tgz';
    const pack = spawnWithHangGuard(['tar', '-czf', archive, 'package'], {
      cwd: directory,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [packExit, packError] = await Promise.all([
      pack.exited,
      new Response(pack.stderr).text(),
    ]);
    if (packExit !== 0)
      throw new Error(`Packing the MCP HTTP fixture failed (${packExit}): ${packError}`);
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { '@lostgradient/mcp': `file:./${archive}` },
      }),
    );
    const install = spawnWithHangGuard([process.execPath, 'install'], {
      cwd: directory,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [installExit, installError] = await Promise.all([
      install.exited,
      new Response(install.stderr).text(),
    ]);
    if (installExit !== 0)
      throw new Error(`Installing the MCP HTTP fixture failed (${installExit}): ${installError}`);
    const manifest = await Bun.file(
      join(directory, 'node_modules/@lostgradient/mcp/package.json'),
    ).json();
    const dependencies = JSON.stringify(manifest.dependencies ?? {});
    const source = await Bun.file(join(packageDirectory, httpEntry)).text();
    const installedSource = await Bun.file(
      join(directory, 'node_modules/@lostgradient/mcp', httpEntry),
    ).text();
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
    return {
      packExit,
      installExit,
      dependencies,
      listenerExit,
      httpEntry,
      exports: manifest.exports,
      source,
      installedSource,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test('an independent listener installs the HTTP entry without provider dependencies', () => {
  expect(evidence.packExit).toBe(0);
  expect(evidence.installExit).toBe(0);
  expect(evidence.dependencies).not.toMatch(/backchannel|velveteen/i);
  expect(evidence.dependencies).toBe('{}');
  expect(evidence.exports).toEqual({ './http': evidence.httpEntry });
  expect(evidence.installedSource).toBe(evidence.source);
  expect(evidence.listenerExit).toBe(0);
});
