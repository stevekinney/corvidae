import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import {
  assertInstallParity,
  extractWorkflowInstalls,
  installFlags,
  InstallParityError,
  readReleaseWorkflowBunVersion,
  readWorkflowInstalls,
  resolveReleaseWorkflowFile,
  type WorkflowInstall,
} from './install-parity.ts';

/** A workflow install, spelled the way the target's CI spells one. */
function workflowInstall(command: string, file = 'ci.yaml'): WorkflowInstall {
  return { file, command, flags: installFlags(command) };
}

const targetInstall = workflowInstall('bun install --frozen-lockfile --linker=isolated');

describe('installFlags', () => {
  it('reads a flag name without its value', () => {
    expect(installFlags('bun install --frozen-lockfile --linker=isolated')).toEqual([
      '--frozen-lockfile',
      '--linker',
    ]);
  });

  it('ignores positional tokens', () => {
    expect(installFlags(['bun', 'install', '--offline'])).toEqual(['--offline']);
  });
});

describe('extractWorkflowInstalls', () => {
  it('finds the install in a run step and trims the YAML around it', () => {
    const installs = extractWorkflowInstalls(
      'ci.yaml',
      ['jobs:', '  test:', '    steps:', '      - run: bun install --frozen-lockfile'].join('\n'),
    );
    expect(installs).toHaveLength(1);
    expect(installs[0]?.command).toBe('bun install --frozen-lockfile');
    expect(installs[0]?.flags).toEqual(['--frozen-lockfile']);
  });

  it('finds every install in a file, not only the first', () => {
    const installs = extractWorkflowInstalls(
      'ci.yaml',
      ['      - run: bun install --frozen-lockfile', '      - run: bun install --offline'].join(
        '\n',
      ),
    );
    expect(installs.map((install) => install.command)).toEqual([
      'bun install --frozen-lockfile',
      'bun install --offline',
    ]);
  });

  it('ignores a commented-out install', () => {
    // Weakening, not noise: a flag harvested from a comment joins the set the mirror's own
    // command is checked against, so a commented `--ignore-scripts` would authorize a real one.
    const installs = extractWorkflowInstalls(
      'ci.yaml',
      ['      # bun install --ignore-scripts', '      - run: bun install --frozen-lockfile'].join(
        '\n',
      ),
    );
    expect(installs.map((install) => install.command)).toEqual(['bun install --frozen-lockfile']);
  });

  it('does not let a commented flag widen the parity check', () => {
    const installs = extractWorkflowInstalls(
      'ci.yaml',
      ['      # bun install --ignore-scripts', '      - run: bun install --frozen-lockfile'].join(
        '\n',
      ),
    );
    expect(() =>
      assertInstallParity({
        command: ['bun', 'install', '--ignore-scripts'],
        workflowInstalls: installs,
      }),
    ).toThrow(InstallParityError);
  });

  it('returns nothing for a workflow that installs nothing', () => {
    expect(
      extractWorkflowInstalls('lint.yaml', 'jobs:\n  lint:\n    steps:\n      - run: echo hi'),
    ).toEqual([]);
  });
});

describe('assertInstallParity', () => {
  it('accepts an install whose flags the target also passes', () => {
    const parity = assertInstallParity({
      command: ['bun', 'install', '--frozen-lockfile'],
      workflowInstalls: [targetInstall],
    });
    expect(parity.command).toBe('bun install --frozen-lockfile');
    expect(parity.checkedAgainst).toEqual([
      'ci.yaml: bun install --frozen-lockfile --linker=isolated',
    ]);
  });

  it('rejects --ignore-scripts when the target does not pass it', () => {
    // The regression this module exists for. A verification install that skips lifecycle scripts
    // proves a tree with no compiled native bindings, which is not the tree anyone else builds.
    expect(() =>
      assertInstallParity({
        command: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
        workflowInstalls: [targetInstall],
      }),
    ).toThrow(InstallParityError);
  });

  it('names the divergent flag and both commands', () => {
    expect(() =>
      assertInstallParity({
        command: ['bun', 'install', '--ignore-scripts'],
        workflowInstalls: [targetInstall],
      }),
    ).toThrow(/--ignore-scripts[\s\S]*ci\.yaml: bun install --frozen-lockfile --linker=isolated/);
  });

  it('allows a run-scoped flag the harness adds', () => {
    // `--offline` proves no registry was reached. It changes how a package is fetched, not what
    // gets built, so it is not the target diverging from itself.
    expect(() =>
      assertInstallParity({
        command: ['bun', 'install', '--frozen-lockfile', '--offline'],
        workflowInstalls: [targetInstall],
        allowedExtraFlags: ['--offline'],
      }),
    ).not.toThrow();
  });

  it('refuses to let allowedExtraFlags waive a suppressing flag', () => {
    // Otherwise the escape hatch reintroduces the defect: passing `--ignore-scripts` through the
    // run's own arguments would be indistinguishable from passing it here.
    expect(() =>
      assertInstallParity({
        command: ['bun', 'install', '--ignore-scripts'],
        workflowInstalls: [targetInstall],
        allowedExtraFlags: ['--ignore-scripts'],
      }),
    ).toThrow(InstallParityError);
  });

  it('accepts a suppressing flag when the target itself passes it', () => {
    expect(() =>
      assertInstallParity({
        command: ['bun', 'install', '--ignore-scripts'],
        workflowInstalls: [workflowInstall('bun install --ignore-scripts')],
      }),
    ).not.toThrow();
  });

  it('records an unverifiable target rather than passing it', () => {
    // No workflows means no evidence. That is a gap, and the empty `checkedAgainst` is what makes
    // it a visible one instead of a result that reads like a clean comparison.
    const parity = assertInstallParity({
      command: ['bun', 'install', '--ignore-scripts'],
      workflowInstalls: [],
    });
    expect(parity.checkedAgainst).toEqual([]);
  });
});

describe('readWorkflowInstalls', () => {
  it('reads every workflow in the clone and ignores non-workflow files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mirror-install-parity-'));
    try {
      const workflows = join(directory, '.github', 'workflows');
      mkdirSync(workflows, { recursive: true });
      writeFileSync(join(workflows, 'ci.yaml'), '      - run: bun install --frozen-lockfile\n');
      writeFileSync(join(workflows, 'release.yml'), '        run: bun install --linker=isolated\n');
      writeFileSync(join(workflows, 'notes.md'), 'bun install --ignore-scripts\n');

      const installs = await readWorkflowInstalls(directory);
      expect(installs.map((install) => install.file)).toEqual(['ci.yaml', 'release.yml']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns nothing for a target with no workflows directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mirror-install-parity-'));
    try {
      expect(await readWorkflowInstalls(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * COR-1287: which spelling a target uses for its release workflow is the target's business, and
 * until this issue it was a default parameter that happened to be right for the two targets that
 * existed. GitHub Actions accepts both extensions; weft and cinder carry `release.yaml`,
 * stevekinney/agent-bureau carries `release.yml`.
 */
describe('resolveReleaseWorkflowFile', () => {
  /** A clone carrying exactly the named workflow files, each with a real-shaped Bun pin. */
  function cloneWith(names: readonly string[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'mirror-release-workflow-'));
    const workflows = join(directory, '.github', 'workflows');
    mkdirSync(workflows, { recursive: true });
    for (const name of names) {
      writeFileSync(join(workflows, name), '        with:\n          bun-version: 1.4.0\n');
    }
    return directory;
  }

  it('finds either spelling, and reads the pin out of whichever one is there', async () => {
    for (const name of ['release.yaml', 'release.yml']) {
      const directory = cloneWith([name]);
      try {
        expect(await resolveReleaseWorkflowFile(directory)).toBe(name);
        expect(await readReleaseWorkflowBunVersion(directory)).toBe('1.4.0');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('refuses a clone carrying both rather than letting probe order decide', async () => {
    const directory = cloneWith(['release.yaml', 'release.yml']);
    try {
      expect(await throwingRejectionOf(resolveReleaseWorkflowFile(directory))).toThrow(
        InstallParityError,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a clone carrying neither, naming both spellings it looked for', async () => {
    const directory = cloneWith([]);
    try {
      expect(await throwingRejectionOf(resolveReleaseWorkflowFile(directory))).toThrow(
        /neither release\.yaml nor release\.yml/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('still honours a filename a caller names explicitly', async () => {
    const directory = cloneWith(['release.yml']);
    try {
      expect(
        await throwingRejectionOf(readReleaseWorkflowBunVersion(directory, 'release.yaml')),
      ).toThrow(/release\.yaml does not exist/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
