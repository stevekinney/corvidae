import { beforeEach, describe, expect, it } from 'bun:test';

import {
  findArtifactForFamily,
  publishShellArtifacts,
  resetShellArtifacts,
  shellArtifactByPath,
} from './build-artifacts-shared.ts';

/** What one shell build publishes: its entry and the content-hashed chunks it imports. */
function shellBuild(hash: string): Map<string, string> {
  return new Map([
    [`shell-shell-${hash}.js`, `entry ${hash}`],
    [`chunk-shell-core-${hash}.js`, `core ${hash}`],
    [`chunk-shell-panels-${hash}.js`, `panels ${hash}`],
  ]);
}

describe('publishShellArtifacts', () => {
  beforeEach(() => resetShellArtifacts());

  // With the landing page open, every watched edit marks the shell stale and the reload rebuilds
  // it. The previous set is the last-good fallback only until a new build succeeds, so keeping it
  // for good grew the server's memory with every edit and left each old set servable. One earlier
  // generation is kept, for the entries already handed out (see the overlapping-builds tests), so
  // the shell is bounded at two builds, however many edits arrive.
  it('holds at most two builds of the shell after repeated rebuilds, not one per edit', () => {
    for (const hash of ['a1', 'a2', 'a3', 'a4']) publishShellArtifacts(shellBuild(hash), true);

    expect([...shellArtifactByPath.keys()].toSorted()).toEqual(
      [...shellBuild('a3').keys(), ...shellBuild('a4').keys()].toSorted(),
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

  it('drops what a lost race left behind once two current builds have replaced it', () => {
    publishShellArtifacts(shellBuild('current'), true);
    publishShellArtifacts(shellBuild('late'), false);

    publishShellArtifacts(shellBuild('next'), true);
    publishShellArtifacts(shellBuild('after'), true);

    expect([...shellArtifactByPath.keys()].toSorted()).toEqual(
      [...shellBuild('next').keys(), ...shellBuild('after').keys()].toSorted(),
    );
  });

  // Two shell builds overlap when a watched edit lands while one is running: the invalidation resets
  // the in-flight slot, so a request that arrives afterwards starts the current build while the
  // stale one keeps running. If the stale build finishes first, the browser that asked for it gets
  // its entry, and that entry's dynamic imports are content-hashed chunks it requests next. The
  // current build then lands and replaces the shell, which must not 404 those requests.
  describe('when a stale build finishes before the current one lands', () => {
    it("still serves the entry and chunks the stale build handed out after the current build replaces the shell", () => {
      // The shell as the last edit left it.
      publishShellArtifacts(shellBuild('before'), true);
      // The stale build finishes first, so it is added alongside and its entry is handed out.
      publishShellArtifacts(shellBuild('stale'), false);
      // The current build lands and replaces the shell.
      publishShellArtifacts(shellBuild('current'), true);

      for (const path of shellBuild('stale').keys()) {
        expect(findArtifactForFamily('shell', path)).toBeDefined();
      }
      for (const path of shellBuild('current').keys()) {
        expect(findArtifactForFamily('shell', path)).toBeDefined();
      }
    });

    it('serves what the previous current build handed out while the next one replaces it', () => {
      publishShellArtifacts(shellBuild('previous'), true);
      publishShellArtifacts(shellBuild('current'), true);

      for (const path of shellBuild('previous').keys()) {
        expect(findArtifactForFamily('shell', path)).toBeDefined();
      }
    });

    it('stops serving the stale build once a second current build has replaced the shell', () => {
      publishShellArtifacts(shellBuild('before'), true);
      publishShellArtifacts(shellBuild('stale'), false);
      publishShellArtifacts(shellBuild('current'), true);
      publishShellArtifacts(shellBuild('next'), true);

      for (const path of shellBuild('stale').keys()) {
        expect(findArtifactForFamily('shell', path)).toBeUndefined();
      }
      for (const path of shellBuild('before').keys()) {
        expect(findArtifactForFamily('shell', path)).toBeUndefined();
      }
    });

    it('keeps a chunk the previous and the current build share for as long as either still needs it', () => {
      const shared = 'chunk-shell-shared-core.js';
      publishShellArtifacts(new Map([['shell-shell-a.js', 'a'], [shared, 'shared']]), true);
      publishShellArtifacts(new Map([['shell-shell-b.js', 'b'], [shared, 'shared']]), true);
      // `a` is now the previous build, and a chunk it shares with the current build must survive
      // the next replacement because the next build still imports it.
      publishShellArtifacts(new Map([['shell-shell-c.js', 'c'], [shared, 'shared']]), true);

      expect(findArtifactForFamily('shell', shared)).toBeDefined();
      expect(findArtifactForFamily('shell', 'shell-shell-a.js')).toBeUndefined();
      expect(findArtifactForFamily('shell', 'shell-shell-b.js')).toBeDefined();
    });

    it('keeps a chunk the previous build shares with an older one when the current build no longer imports it', () => {
      const oldShared = 'chunk-shell-old-shared.js';
      publishShellArtifacts(new Map([['shell-shell-a.js', 'a'], [oldShared, 'shared']]), true);
      publishShellArtifacts(new Map([['shell-shell-b.js', 'b'], [oldShared, 'shared']]), true);
      publishShellArtifacts(new Map([['shell-shell-c.js', 'c']]), true);

      // `b` is the previous build and still imports the chunk, so it must resolve even though
      // `a`, the build that first published it, has been dropped.
      expect(findArtifactForFamily('shell', oldShared)).toBeDefined();
    });
  });
});
