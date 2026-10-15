import { loadPackageSurface, type PackageSurfaceEntry } from './package-surface.ts';
import { loadRegistryBaseline } from './registry-baseline.ts';
import type { PolicyDocumentOverrides } from './surface.ts';

/**
 * A published surface a fixture can build: one root entry, dual-format, built by `tsdown` from a
 * `tsdown.config.ts` the fixture target carries as its one required input.
 *
 * This is the surface `@lostgradient/cryptography` and `@lostgradient/lifecycle` carried in
 * `package-surface.json`, which is why the end-to-end harnesses could stand them up against the
 * committed documents unchanged. The owner retired both from publication on 2026-10-14, and every
 * package still published ships many subpaths through its own build or pack script, so the
 * harnesses now lend this surface to the cinder packages they stand up instead. The committed
 * surfaces of those packages are still exercised, by the committed plans and the dry run.
 */
export function singleEntrySurface(publicName: string): PackageSurfaceEntry {
  return {
    publicName,
    provenance: {
      repository: null,
      path: null,
      commit: null,
      version: null,
      note: 'Fixture surface lent to an end-to-end harness; see policy-documents.test-support.ts.',
    },
    exports: {
      '.': {
        bun: './dist/index.js',
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
        default: './dist/index.js',
      },
    },
    files: ['dist', 'LICENSE', 'README.md'],
    build: {
      scripts: { build: 'tsdown', clean: 'rm -rf dist coverage' },
      toolchain: { tsdown: '^0.22.14' },
      requiredInputs: ['tsdown.config.ts'],
      sourceRoot: 'src',
      packedBy: 'files',
    },
    sideEffects: false,
    manifestFields: {
      main: './dist/index.js',
      module: './dist/index.js',
      types: './dist/index.d.ts',
      publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
      engines: { bun: '>=1.4.0', node: '>=22' },
    },
  };
}

/**
 * The committed surface and registry baseline, with `workspaces` given the single-entry surface
 * and a registry history of that one subpath, so the surface-parity gate compares like with like.
 * Every other entry is the committed one.
 */
export async function singleEntryPolicyDocuments(
  workspaces: readonly string[],
): Promise<PolicyDocumentOverrides> {
  const surface = await loadPackageSurface();
  const baseline = await loadRegistryBaseline();
  const packages = { ...surface.packages };
  const published = { ...baseline.packages };
  for (const workspace of workspaces) {
    const entry = packages[workspace];
    if (entry === undefined) {
      throw new Error(`${workspace} has no committed surface to replace`);
    }
    packages[workspace] = singleEntrySurface(entry.publicName);
    const history = published[entry.publicName];
    if (history !== undefined) published[entry.publicName] = { ...history, subpaths: ['.'] };
  }
  return {
    packageSurface: { ...surface, packages },
    registryBaseline: { ...baseline, packages: published },
  };
}
