import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { RootLock } from '@lostgradient/bungalow';

import { lockFixtureRoot, resetPinnedDirectory } from './fixture-directory.ts';

/** An explicitly disposable directory and the checkout that owns its fixtures. */
export interface FixtureOwnership {
  readonly root: string;
  readonly owner: string;
}

type Marker = {
  readonly home: string;
  readonly owner: string;
  readonly dev: string;
  readonly ino: string;
  readonly state: 'pending' | 'owned';
};
export type FixtureLease = RootLock & { validate(): Promise<void> };

function sync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function status(path: string) {
  return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function readMarker(path: string, repair = false): Promise<Marker | undefined> {
  const entry = await status(path);
  if (entry === undefined) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 2n)
    throw new Error('Fixture marker is not an ordinary file.');
  if (entry.nlink === 2n) {
    const matches: string[] = [];
    for (const candidate of await readdir(dirname(path))) {
      if (!candidate.startsWith(`${basename(path)}.`)) continue;
      const candidatePath = join(dirname(path), candidate);
      const candidateStatus = await status(candidatePath);
      if (
        candidateStatus?.isFile() &&
        !candidateStatus.isSymbolicLink() &&
        candidateStatus.dev === entry.dev &&
        candidateStatus.ino === entry.ino
      )
        matches.push(candidatePath);
    }
    if (matches.length !== 1) throw new Error('Fixture marker has an unverified hard link.');
    if (repair) {
      await rm(matches[0]!, { force: true });
      sync(dirname(path));
    }
  } else if (entry.nlink !== 1n) throw new Error('Fixture marker is not an ordinary file.');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Fixture marker is invalid.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('home' in value) ||
    !('owner' in value) ||
    !('dev' in value) ||
    !('ino' in value) ||
    !('state' in value) ||
    typeof value.home !== 'string' ||
    typeof value.owner !== 'string' ||
    typeof value.dev !== 'string' ||
    typeof value.ino !== 'string' ||
    !/^\d+$/.test(value.dev) ||
    !/^\d+$/.test(value.ino) ||
    (value.state !== 'pending' && value.state !== 'owned')
  )
    throw new Error('Fixture marker is invalid.');
  return value as Marker;
}

async function writeMarker(path: string, marker: Marker, exclusive: boolean): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    sync(temporary);
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    sync(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Validate ownership before writing, then hold the home's permanent Bungalow lock through reset. */
export async function resetOwnedFixture(
  home: string,
  ownership: FixtureOwnership,
  afterLock?: () => void | Promise<void>,
  beforePin?: () => void | Promise<void>,
  afterPending?: () => void | Promise<void>,
  afterRemove?: () => void,
  afterRootLock?: () => void | Promise<void>,
): Promise<FixtureLease> {
  const rootInput = ownership.root;
  const ownerInput = ownership.owner;
  const requestedRoot = resolve(rootInput);
  const requestedTarget = resolve(home);
  const child = relative(requestedRoot, requestedTarget);
  if (
    !isAbsolute(rootInput) ||
    !isAbsolute(home) ||
    child === '' ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error('Fixture home must be a child of its disposable root.');
  if (child.includes(sep))
    throw new Error('Fixture home must be a direct child of its disposable root.');
  const root = await realpath(requestedRoot);
  const target = join(root, child);
  const deployment = await status(join(root, 'deployment-id'));
  if (deployment !== undefined && (!deployment.isDirectory() || deployment.isSymbolicLink()))
    throw new Error('A fixture home cannot also be a disposable root.');
  const parentMarker = join(
    dirname(root),
    '.fixture-owners',
    createHash('sha256')
      .update(relative(dirname(root), root))
      .digest('hex'),
  );
  if ((await status(parentMarker)) !== undefined)
    throw new Error('A fixture home cannot also be a disposable root.');
  if (child === '.fixture-owners' || child === '.fixture-root' || child === 'lock')
    throw new Error('Fixture home overlaps the ownership directory.');
  const owner = await realpath(ownerInput);
  const markerDirectory = join(root, '.fixture-owners');
  const markerEntry = await status(markerDirectory);
  if (markerEntry !== undefined && (!markerEntry.isDirectory() || markerEntry.isSymbolicLink()))
    throw new Error('Fixture ownership directory is not a directory.');
  const markerPath = join(markerDirectory, createHash('sha256').update(child).digest('hex'));

  async function inspect(repair = false) {
    const entry = await status(target);
    if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error('Fixture path must contain only directories, not symbolic links.');
    const marker = await readMarker(markerPath, repair);
    if (marker !== undefined && (marker.home !== child || marker.owner !== owner))
      throw new Error('Fixture belongs to another owner.');
    if (
      marker !== undefined &&
      (entry === undefined ||
        marker.dev !== entry.dev.toString() ||
        marker.ino !== entry.ino.toString())
    )
      throw new Error('Fixture identity does not match its owner marker.');
    const names = entry === undefined ? [] : await readdir(target);
    if (names.includes('.fixture-root'))
      throw new Error('A disposable root cannot also be a fixture home.');
    if (marker === undefined && names.length !== 0)
      throw new Error('Refusing a nonempty unmarked fixture.');
    if (marker?.state === 'pending' && names.some((entryName) => entryName !== 'lock'))
      throw new Error('Pending fixture initialization is not empty.');
    return { entry, marker };
  }

  await inspect();
  const rootMarker = join(root, '.fixture-root');
  const rootIdentity = await lstat(root, { bigint: true });
  const rootLock = await lockFixtureRoot(root);
  try {
    await afterRootLock?.();
    if ((await status(parentMarker)) !== undefined)
      throw new Error('A fixture home cannot also be a disposable root.');
    const current = await inspect(true);
    const lockedDeployment = await status(join(root, 'deployment-id'));
    if (
      lockedDeployment !== undefined &&
      (!lockedDeployment.isDirectory() || lockedDeployment.isSymbolicLink())
    )
      throw new Error('A fixture home cannot also be a disposable root.');
    const pinnedRoot = await lstat(root, { bigint: true });
    if (pinnedRoot.dev !== rootIdentity.dev || pinnedRoot.ino !== rootIdentity.ino)
      throw new Error('Fixture root identity changed during initialization.');
    const rootMarkerStatus = await status(rootMarker);
    if (rootMarkerStatus === undefined)
      await writeFile(rootMarker, 'disposable fixture root\n', { flag: 'wx', mode: 0o600 });
    else if (
      !rootMarkerStatus.isFile() ||
      rootMarkerStatus.isSymbolicLink() ||
      rootMarkerStatus.nlink !== 1n ||
      (await readFile(rootMarker, 'utf8')) !== 'disposable fixture root\n'
    )
      throw new Error('Fixture root marker is invalid.');
    await mkdir(markerDirectory, { recursive: true });
    if (current.entry === undefined) await mkdir(target);
    const identity = await lstat(target, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new Error('Fixture path must contain only directories, not symbolic links.');
    if (
      current.entry !== undefined &&
      (identity.dev !== current.entry.dev || identity.ino !== current.entry.ino)
    )
      throw new Error('Fixture changed before it was pinned.');
    await beforePin?.();
    const lease = await resetPinnedDirectory(
      root,
      child,
      async (names) => {
        if (current.marker?.state !== 'owned') {
          if (names.some((entryName) => entryName !== 'lock'))
            throw new Error('Pending fixture initialization is not empty.');
          await writeMarker(
            markerPath,
            {
              home: child,
              owner,
              dev: identity.dev.toString(),
              ino: identity.ino.toString(),
              state: 'owned',
            },
            false,
          );
        }
        await afterLock?.();
      },
      { dev: identity.dev.toString(), ino: identity.ino.toString() },
      async () => {
        if (current.marker === undefined) {
          await writeMarker(
            markerPath,
            {
              home: child,
              owner,
              dev: identity.dev.toString(),
              ino: identity.ino.toString(),
              state: 'pending',
            },
            true,
          );
          await afterPending?.();
        }
      },
      afterRemove,
    );
    return {
      release: () => lease.release(),
      validate: async () => {
        const currentHome = await lstat(target, { bigint: true });
        if (
          !currentHome.isDirectory() ||
          currentHome.isSymbolicLink() ||
          currentHome.dev !== identity.dev ||
          currentHome.ino !== identity.ino
        )
          throw new Error('Fixture changed after reset.');
      },
    };
  } finally {
    rootLock.release();
  }
}
