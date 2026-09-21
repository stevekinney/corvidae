export type ArchitectureLayer = 'main' | 'renderer' | 'shared';

export type ArchitectureBoundary = {
  files: readonly string[];
  forbiddenDirectories: readonly string[];
  /** Matched exactly, or as the root of a subpath import. */
  forbiddenPackages: readonly string[];
  /** Matched only as a complete package specifier. */
  forbiddenExactSpecifiers: readonly string[];
  /** Matched as a specifier prefix, so `node:` covers every builtin. */
  forbiddenModulePrefixes: readonly string[];
  layer: ArchitectureLayer;
  message: string;
};

/**
 * The process boundaries this application is built on, enforced at build time
 * by `check-architecture.ts`.
 *
 * Electrobun 2.x splits the SDK into `electrobun/main` (privileged, runs in the
 * Bun main process) and `electrobun/view` (runs inside a webview). Importing
 * the wrong one does not fail to resolve — it fails at runtime, in the built
 * application, which is the worst place to discover it. These rules turn that
 * into a build error instead.
 */
export const architectureBoundaries = [
  {
    files: ['src/bun/**/*.ts'],
    forbiddenDirectories: ['src/views'],
    forbiddenPackages: ['electrobun/view'],
    forbiddenExactSpecifiers: [],
    forbiddenModulePrefixes: [],
    layer: 'main',
    message: 'The main process cannot import renderer modules.',
  },
  {
    files: ['src/views/**/*.ts', 'src/views/**/*.svelte'],
    forbiddenDirectories: ['src/bun', 'scripts'],
    forbiddenPackages: ['electrobun/main', 'electrobun/bun'],
    forbiddenExactSpecifiers: ['electrobun'],
    forbiddenModulePrefixes: ['bun:', 'node:'],
    layer: 'renderer',
    message: 'Renderer modules cannot import privileged main-process modules or server runtimes.',
  },
  {
    files: ['src/shared/**/*.ts'],
    forbiddenDirectories: ['scripts', 'src/bun', 'src/views'],
    forbiddenPackages: ['electrobun/main', 'electrobun/bun', 'electrobun/view'],
    forbiddenExactSpecifiers: ['electrobun'],
    forbiddenModulePrefixes: ['bun:', 'node:'],
    layer: 'shared',
    message: 'Shared modules must remain portable across the main and renderer processes.',
  },
] as const satisfies readonly ArchitectureBoundary[];

/**
 * Packages that would replace the Electrobun toolchain itself.
 *
 * Vite is deliberately absent: Electrobun 2.x builds the renderer with Vite,
 * so it is part of this toolchain rather than a competitor to it. Only
 * bundlers that would stand in for Electrobun's own packaging are listed.
 */
export const forbiddenToolchainPackagePrefixes = [
  '@electron/',
  '@electron-forge/',
  '@parcel/',
  'electron-forge',
  'electron-',
  'electron',
  'parcel',
  'webpack-',
  'webpack',
] as const;

/** Returns whether a direct package name belongs to a forbidden toolchain. */
export function isForbiddenToolchainPackage(name: string): boolean {
  return forbiddenToolchainPackagePrefixes.some((forbidden) =>
    forbidden.endsWith('/') || forbidden.endsWith('-')
      ? name.startsWith(forbidden)
      : name === forbidden,
  );
}
