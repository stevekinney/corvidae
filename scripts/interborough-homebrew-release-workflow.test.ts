import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const workflow = readFileSync(
  resolve(root, '.github/workflows/interborough-homebrew-release.yml'),
  'utf8',
);

describe('Interborough Homebrew release workflow', () => {
  test('is manually dispatched with explicit immutable release inputs', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('source_sha:');
    expect(workflow).toContain('version:');
    expect(workflow).toContain('publish:');
    expect(workflow).toContain('test "${#SOURCE_SHA}" = 40');
    expect(workflow).toContain("grep -Eq '^[0-9a-fA-F]{40}$'");
    expect(workflow).toContain("grep -Eq '^([0-9]+)\\.([0-9]+)\\.([0-9]+)");
  });

  test('rehearses only a main push that changes this workflow', () => {
    expect(workflow).toContain('  push:\n    branches: [main]\n    paths: [.github/workflows/interborough-homebrew-release.yml]');
    expect(workflow).toContain("SOURCE_SHA: ${{ inputs.source_sha || github.sha }}");
    expect(workflow).toContain("VERSION: ${{ inputs.version || '0.0.0-candidate.0' }}");
    expect(workflow).toContain("PUBLISH: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}");
    expect(workflow).toContain('version: ${{ steps.release-inputs.outputs.version }}');
  });

  test('builds and tests a clean pinned macOS arm64 checkout before it packages bytes', () => {
    expect(workflow).toContain('runs-on: macos-15');
    expect(workflow).toContain('ref: ${{ steps.release-inputs.outputs.source_sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(workflow).toContain('bun install --frozen-lockfile');
    expect(workflow).toContain('bun scripts/build-release.ts --version "$VERSION"');
    const chromium = workflow.indexOf('bunx playwright install chromium');
    expect(chromium).toBeGreaterThan(workflow.indexOf('bun install --frozen-lockfile'));
    expect(chromium).toBeLessThan(workflow.indexOf('bun scripts/test-installed-release.ts'));
    expect(workflow).toContain('bun scripts/test-installed-release.ts');
    expect(workflow).toContain(
      'CORVIDAE_EXPECTED_RELEASE_SHA: ${{ steps.release-inputs.outputs.source_sha }}',
    );
    expect(workflow).toContain('shasum -a 256 "interborough-$VERSION-darwin-arm64.tar.gz"');
  });

  test('grants write permission only to protected-main publication and only after tested bytes pass', () => {
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('permissions:\n      contents: write');
    expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(workflow).toContain('test "$GITHUB_REF_PROTECTED" = true');
    expect(workflow).toContain('test "$source_sha" = "$GITHUB_SHA"');
    expect(workflow).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.publish && github.ref == 'refs/heads/main' && github.ref_protected }}",
    );
    expect(workflow).toContain('needs: package');
    expect(workflow).toContain(
      'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
    );
    expect(workflow).toContain(
      'shasum -a 256 -c "interborough-$VERSION-darwin-arm64.tar.gz.sha256"',
    );
    expect(workflow).toContain('gh release create "$TAG"');
    expect(workflow).toContain('SOURCE_SHA: ${{ needs.package.outputs.source_sha }}');
    expect(workflow).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(workflow).toContain('--verify-tag');
  });

  test('pins a tag before publishing and rejects a tag pointing to other source', () => {
    expect(workflow).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs"');
    expect(workflow).toContain('-f "ref=refs/tags/$TAG" -f "sha=$SOURCE_SHA"');
    expect(workflow).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG"');
    expect(workflow).toContain('if [ "$tag_source" != "$SOURCE_SHA" ]; then');
    expect(workflow.indexOf('Verify downloaded archive digest')).toBeLessThan(
      workflow.indexOf('Pin the release tag to the tested source'),
    );
    expect(workflow).toContain('"interborough-$VERSION-darwin-arm64.tar.gz"');
    expect(workflow).toContain('"interborough-$VERSION-darwin-arm64.tar.gz.sha256"');
  });
});
