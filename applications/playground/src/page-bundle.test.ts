import { describe, expect, it } from 'bun:test';

import { bareComponentShimSource, compilePageBundleArtifacts } from './page-bundle.ts';

const MEBIBYTE = 1024 * 1024;

describe('bareComponentShimSource', () => {
  it('re-exports only the documented component from the package root', () => {
    expect(bareComponentShimSource('@lostgradient/cinder', 'Button')).toBe(
      'export { Button } from "@lostgradient/cinder";\n',
    );
  });

  it('quotes the import path as a JSON string so no specifier can break out of it', () => {
    expect(bareComponentShimSource('@lostgradient/chat"; throw 1; "', 'Chat')).toBe(
      'export { Chat } from "@lostgradient/chat\\"; throw 1; \\"";\n',
    );
  });
});

describe('compilePageBundleArtifacts', () => {
  // A bundle builds from the real package root, so a cold Bun.build over the
  // Cinder barrel is the cost being measured. The budget is for that build, not
  // for a slow assertion.
  it('keeps every artifact small by loading only the documented component', async () => {
    const entry = await compilePageBundleArtifacts('button');

    expect(entry).not.toBeNull();
    const artifactSizes = [...entry!.artifacts].map(([path, code]) => ({
      path,
      bytes: Buffer.byteLength(code),
    }));
    // A dynamic `import('@lostgradient/cinder')` keeps every export of the
    // package root, which emitted a 5.7 MiB chunk for Button. Importing only the
    // documented component through a per-page module keeps each artifact well
    // under this bound.
    const oversized = artifactSizes.filter(({ bytes }) => bytes > 2 * MEBIBYTE);
    expect(oversized).toEqual([]);
  }, 60_000);
});
