import { beforeEach, describe, expect, it } from 'bun:test';

import { publishShellArtifacts, shellArtifactByPath } from './build-artifacts-shared.ts';

/** What one shell build publishes: its entry and the content-hashed chunks it imports. */
function shellBuild(hash: string): Map<string, string> {
  return new Map([
    [`shell-shell-${hash}.js`, `entry ${hash}`],
    [`chunk-shell-core-${hash}.js`, `core ${hash}`],
    [`chunk-shell-panels-${hash}.js`, `panels ${hash}`],
  ]);
}

describe('publishShellArtifacts', () => {
  beforeEach(() => shellArtifactByPath.clear());

  // With the landing page open, every watched edit marks the shell stale and the reload rebuilds
  // it. The previous set is the last-good fallback only until a new build succeeds, so keeping it
  // afterwards grew the server's memory with every edit and left each old set servable.
  it('holds one build of the shell after repeated rebuilds, not one per edit', () => {
    for (const hash of ['a1', 'a2', 'a3', 'a4']) publishShellArtifacts(shellBuild(hash), true);

    expect([...shellArtifactByPath.keys()].toSorted()).toEqual(
      [...shellBuild('a4').keys()].toSorted(),
    );
  });

  it('keeps the last-good shell until a build succeeds', () => {
    publishShellArtifacts(shellBuild('a1'), true);

    // A failed rebuild publishes nothing, so the previous set is still what is served.
    expect([...shellArtifactByPath.keys()].toSorted()).toEqual(
      [...shellBuild('a1').keys()].toSorted(),
    );
  });

  it('adds a build that lost a race with an invalidation without evicting the current shell', () => {
    publishShellArtifacts(shellBuild('current'), true);

    // The request that started this build still needs its own entry's chunks to resolve.
    publishShellArtifacts(shellBuild('late'), false);

    expect(shellArtifactByPath.has('shell-shell-current.js')).toBe(true);
    expect(shellArtifactByPath.has('shell-shell-late.js')).toBe(true);
    expect(shellArtifactByPath.has('chunk-shell-core-late.js')).toBe(true);
  });

  it('drops what a lost race left behind when the next current build replaces the shell', () => {
    publishShellArtifacts(shellBuild('current'), true);
    publishShellArtifacts(shellBuild('late'), false);

    publishShellArtifacts(shellBuild('next'), true);

    expect([...shellArtifactByPath.keys()].toSorted()).toEqual(
      [...shellBuild('next').keys()].toSorted(),
    );
  });
});
