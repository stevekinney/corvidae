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
  init: boolean;
};
const lockfile = await Bun.file(join(root, 'bun.lock')).text();
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

  test("installs lsof, which chef's leftover check needs to find processes in a worktree", () => {
    const install = /apt-get install[^\n]*/u.exec(dockerfile)?.[0] ?? '';
    expect(install).toMatch(/\blsof\b/u);
  });

  test('provides a real Node.js for the native SQLite suite', () => {
    expect(dockerfile).toMatch(/^FROM node:\d+\.\d+\.\d+-trixie-slim AS node$/mu);
    expect(dockerfile).toContain('COPY --from=node /usr/local/bin/node /usr/local/bin/node');
  });

  test("provides npm for the mirror tooling's packing tests", () => {
    expect(dockerfile).toContain(
      'COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm',
    );
    expect(dockerfile).toContain('/usr/local/bin/npm');
  });

  test("runs few enough Turborepo tasks at once to fit Docker Desktop's default memory", () => {
    // COR-1379: at Turborepo's default of ten, and again at two, parallel type-checks were
    // killed for memory.
    expect(dockerfile).toMatch(/^ENV TURBO_CONCURRENCY=1$/mu);
  });

  test('installs Chromium for the Playwright version the lockfile resolves', () => {
    // COR-1379: the browser-fixture suite in `bun run test` failed with no browser installed.
    const locked = /"playwright-core": \["playwright-core@([^"]+)"/u.exec(lockfile)?.[1];
    expect(locked).toBeDefined();
    expect(dockerfile).toContain(`npx --yes playwright@${locked} install-deps chromium`);
    expect(dockerfile).toContain(`npx --yes playwright@${locked} install chromium`);
  });

  test("keeps browsers in Playwright's default cache, which Turborepo tasks can find", () => {
    // COR-1379: Turborepo's strict environment mode dropped `PLAYWRIGHT_BROWSERS_PATH`, so the
    // browser-fixture task looked in the default cache and found nothing.
    expect(dockerfile).not.toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH/mu);
    const install = dockerfile.indexOf('install chromium');
    expect(install).toBeGreaterThan(dockerfile.search(/^USER bun$/mu));
  });

  test('runs an init process, so killed process groups are reaped', () => {
    // COR-1379: with the entrypoint as PID 1, nothing reaped the children
    // `scripts/run-exclusively.test.ts` kills, and their zombies kept each group alive.
    expect(configuration.init).toBe(true);
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
    // The image copies nothing from the checkout, so `.env` and credentials never enter it;
    // its only copy is from another image's build stage.
    expect(dockerfile).not.toMatch(/^(COPY|ADD) (?!--from=)/mu);
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

// COR-1883: the plugin identity guard compares with `origin/main`, which a clone of a bundle does
// not have, so the documented clone command names a baseline that exists there.
describe('the bundle-clone validation command', () => {
  test('sets the plugin identity baseline to HEAD', async () => {
    const guidance = await Bun.file(join(root, 'AGENTS.md')).text();
    const command = guidance.match(/docker run --rm --init [^\n]*bun run validate'/u)?.[0];
    expect(command).toContain('export CORVIDAE_PLUGIN_IDENTITY_BASE=HEAD &&');
  });
});
