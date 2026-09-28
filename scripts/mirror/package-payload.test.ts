import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, Pax } from 'tar';

import { readPackagePayload } from './package-payload.ts';

async function packageTarball(
  options: {
    files?: Record<string, string>;
    executable?: string;
    entries?: string[];
    mtime?: Date;
    symlinkPath?: string;
  } = {},
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-package-payload-'));
  try {
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    const files = options.files ?? {
      'package.json': '{"name":"fixture","version":"1.0.0"}\n',
      'dist/index.js': 'export const answer = 42;\n',
      'dist/index.d.ts': 'export declare const answer: number;\n',
    };
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(packageRoot, path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, contents);
    }
    if (options.executable !== undefined) {
      await chmod(join(packageRoot, options.executable), 0o755);
    }
    if (options.symlinkPath !== undefined) {
      await symlink('index.js', join(packageRoot, options.symlinkPath));
    }

    const archive = join(root, 'package.tgz');
    const entries = options.entries ?? [
      ...Object.keys(files).map((path) => `package/${path}`),
      ...(options.symlinkPath === undefined ? [] : [`package/${options.symlinkPath}`]),
    ];
    await create.asyncFile(
      {
        cwd: root,
        file: archive,
        gzip: true,
        portable: true,
        preservePaths: true,
        ...(options.mtime === undefined ? {} : { mtime: options.mtime }),
      },
      entries,
    );
    return new Uint8Array(await Bun.file(archive).arrayBuffer());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function typedTarball(
  path: string,
  type: number,
  contents = Buffer.from('outside package\n'),
): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header[156] = type;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return new Uint8Array(
    Bun.gzipSync(Buffer.concat([header, contents, padding, Buffer.alloc(1024)])),
  );
}

test('canonicalizes package payload independently of archive metadata and ordering', async () => {
  const first = await packageTarball({
    entries: ['package/dist/index.d.ts', 'package/dist/index.js', 'package/package.json'],
    mtime: new Date('2020-01-01T00:00:00Z'),
  });
  const second = await packageTarball({
    entries: ['package/package.json', 'package/dist/index.js', 'package/dist/index.d.ts'],
    mtime: new Date('2026-01-01T00:00:00Z'),
  });

  const left = await readPackagePayload(first);
  const right = await readPackagePayload(second);

  expect(left.digest).toBe(right.digest);
  expect(left.files).toEqual([
    { path: 'package/dist/index.d.ts', executable: false },
    { path: 'package/dist/index.js', executable: false },
    { path: 'package/package.json', executable: false },
  ]);
});

test('binds the digest to shipped bytes and executable mode', async () => {
  const baseline = await readPackagePayload(await packageTarball());
  const changedBytes = await readPackagePayload(
    await packageTarball({
      files: {
        'package.json': '{"name":"fixture","version":"1.0.0"}\n',
        'dist/index.js': 'changed\n',
        'dist/index.d.ts': 'export declare const answer: number;\n',
      },
    }),
  );
  const changedDeclaration = await readPackagePayload(
    await packageTarball({
      files: {
        'package.json': '{"name":"fixture","version":"1.0.0"}\n',
        'dist/index.js': 'export const answer = 42;\n',
        'dist/index.d.ts': 'export declare const answer: string;\n',
      },
    }),
  );
  const changedMode = await readPackagePayload(
    await packageTarball({
      files: {
        'package.json': '{"name":"fixture","version":"1.0.0"}\n',
        'dist/index.js': 'export const answer = 42;\n',
        'dist/index.d.ts': 'export declare const answer: number;\n',
      },
      executable: 'dist/index.js',
    }),
  );

  expect(changedBytes.digest).not.toBe(baseline.digest);
  expect(changedDeclaration.digest).not.toBe(baseline.digest);
  expect(changedMode.digest).not.toBe(baseline.digest);
  expect(changedMode.files).toContainEqual({ path: 'package/dist/index.js', executable: true });
});

test('rejects symbolic links and paths outside package/', async () => {
  await expect(
    readPackagePayload(await packageTarball({ symlinkPath: 'dist/link.js' })),
  ).rejects.toThrow(/link|non-file|symbolic/i);

  await expect(readPackagePayload(typedTarball('../outside.txt', 0x30))).rejects.toThrow(
    /path|package|unsafe|traversal/i,
  );

  await expect(
    readPackagePayload(typedTarball('package/device', 0x33, Buffer.alloc(0))),
  ).rejects.toThrow(/unsupported|device|non-file/i);

  await expect(readPackagePayload(typedTarball('package/./dist/index.js', 0x30))).rejects.toThrow(
    /path|package|unsafe/i,
  );
  await expect(readPackagePayload(typedTarball('package', 0x30))).rejects.toThrow(
    /root|directory/i,
  );
  await expect(
    readPackagePayload(typedTarball('package/dist/', 0x35, Buffer.alloc(0))),
  ).resolves.toEqual(expect.objectContaining({ files: [] }));
});

test('rejects a truncated archive', async () => {
  const archive = await packageTarball();
  await expect(readPackagePayload(archive.slice(0, -20))).rejects.toThrow();
});

test('validates and hashes effective PAX paths and ignores valid directories', async () => {
  const longPath = `package/dist/${'x'.repeat(140)}.js`;
  const regular = Buffer.from(Bun.gunzipSync(typedTarball('package/short.js', 0x30)));
  const extended = (path: string) =>
    Bun.gzipSync(Buffer.concat([new Pax({ path }).encode(), regular]));
  const payload = await readPackagePayload(extended(longPath));
  expect(payload.files).toEqual([{ path: longPath, executable: false }]);
  await expect(readPackagePayload(extended('../outside.js'))).rejects.toThrow('path');
  const directories = Buffer.concat([
    Buffer.from(Bun.gunzipSync(typedTarball('package/', 0x35, Buffer.alloc(0))).slice(0, 512)),
    Buffer.from(Bun.gunzipSync(typedTarball('package/dist/', 0x35, Buffer.alloc(0))).slice(0, 512)),
    regular,
  ]);
  expect(await readPackagePayload(Bun.gzipSync(directories))).toEqual(
    await readPackagePayload(Bun.gzipSync(regular)),
  );
});

test('rejects absolute paths, backslashes, hard links, and FIFOs', async () => {
  for (const [path, type] of [
    ['/package/file', 0x30],
    ['package\\file', 0x30],
    ['package/hardlink', 0x31],
    ['package/fifo', 0x36],
  ] as const) {
    await expect(readPackagePayload(typedTarball(path, type, Buffer.alloc(0)))).rejects.toThrow();
  }
});

test('rejects backslashes before the tar reader normalizes Windows paths', async () => {
  const archive = typedTarball('package\\file.js', 0x30);
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { readPackagePayload } from ${JSON.stringify(new URL('./package-payload.ts', import.meta.url).pathname)};
    try { await readPackagePayload(Buffer.from(process.argv.at(-1), 'base64')); process.exitCode = 1; }
    catch (error) { if (!String(error).includes('unsafe package payload path')) throw error; }
  `,
      Buffer.from(archive).toString('base64'),
    ],
    {
      env: { ...Bun.env, TESTING_TAR_FAKE_PLATFORM: 'win32' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
});

test('rejects duplicate archive entries instead of collapsing them', async () => {
  await expect(
    readPackagePayload(
      await packageTarball({
        entries: ['package/dist/index.js', 'package/dist/index.js'],
      }),
    ),
  ).rejects.toThrow(/duplicate/i);
});
