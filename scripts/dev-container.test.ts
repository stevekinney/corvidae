import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { CONTAINER_GIT_COMMON_DIRECTORY, worktreeCommonDirectory } from './dev-container.ts';

const root = join(import.meta.dir, '..');
const dockerfile = await Bun.file(join(root, '.devcontainer/Dockerfile')).text();
const configuration = (await Bun.file(join(root, '.devcontainer/devcontainer.json')).json()) as {
  initializeCommand: string;
  onCreateCommand: string;
  postCreateCommand: string;
  remoteUser: string;
  containerUser: string;
  workspaceMount: string;
  workspaceFolder: string;
  mounts: string[];
};
const manifest = (await Bun.file(join(root, 'package.json')).json()) as { packageManager: string };

// COR-1379: validation passed or failed depending on what the host had installed. The
// container is the fix, and these assertions keep it from drifting off the workspace.
describe('the Dev Container', () => {
  test('pins the Bun version the workspace declares', () => {
    const version = manifest.packageManager.replace(/^bun@/u, '');
    expect(dockerfile).toMatch(
      new RegExp(`^FROM oven/bun:${version.replaceAll('.', '\\.')}$`, 'mu'),
    );
  });

  test('installs from the lockfile after creation, as a fresh worktree does', () => {
    expect(configuration.postCreateCommand).toBe('bun install --frozen-lockfile');
  });

  test('puts initdb and pg_ctl on PATH for the live PostgreSQL suites', () => {
    const major = /postgresql-(\d+)/u.exec(dockerfile)?.[1];
    expect(major).toBeDefined();
    expect(dockerfile).toContain(`ENV PATH=/usr/lib/postgresql/${major}/bin:$PATH`);
  });

  test('works as a non-root user, because initdb refuses to run as root', () => {
    expect(dockerfile).toMatch(/^USER bun$/mu);
    expect(configuration.remoteUser).toBe('bun');
    expect(configuration.containerUser).toBe('bun');
  });

  test('keeps host node_modules and Turborepo cache out of the container', () => {
    expect(configuration.mounts).toContain(
      'source=corvidae-node-modules-${devcontainerId},target=${localWorkspaceFolder}/node_modules,type=volume',
    );
    expect(dockerfile).toContain('ENV TURBO_CACHE_DIR=/home/bun/.cache/turbo');
    // The image copies nothing from the checkout, so `.env` and credentials never enter it.
    expect(dockerfile).not.toMatch(/^(COPY|ADD) /mu);
  });

  test('mounts the checkout and its Git common directory where worktree pointers expect them', () => {
    expect(configuration.workspaceMount).toBe(
      'source=${localWorkspaceFolder},target=${localWorkspaceFolder},type=bind',
    );
    expect(configuration.workspaceFolder).toBe('${localWorkspaceFolder}');
    expect(configuration.initializeCommand).toContain('.devcontainer/.git-common-dir');
    expect(configuration.mounts).toContain(
      `source=\${localWorkspaceFolder}/.devcontainer/.git-common-dir,target=${CONTAINER_GIT_COMMON_DIRECTORY},type=bind`,
    );
    expect(configuration.onCreateCommand).toContain('bun scripts/dev-container.ts');
  });
});

describe('worktreeCommonDirectory', () => {
  test('finds the common directory of a Claude Code worktree', () => {
    expect(
      worktreeCommonDirectory(
        'gitdir: /Users/someone/corvidae/.git/worktrees/feature\n',
        '/Users/someone/corvidae/.claude/worktrees/feature',
      ),
    ).toBe('/Users/someone/corvidae/.git');
  });

  test('resolves a relative pointer against the worktree', () => {
    expect(
      worktreeCommonDirectory(
        'gitdir: ../../../.git/worktrees/feature',
        '/r/.claude/worktrees/feature',
      ),
    ).toBe('/r/.git');
  });

  test('rejects contents that are not a standard worktree pointer', () => {
    expect(worktreeCommonDirectory('not a pointer', '/r')).toBeNull();
    expect(worktreeCommonDirectory('gitdir: /r/.git/modules/child', '/r/child')).toBeNull();
  });
});
