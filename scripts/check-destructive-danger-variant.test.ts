import { beforeEach, describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';

import {
  ALLOWLIST_PATH,
  type CopyModules,
  SCANNED_DIRECTORIES,
  findDestructiveActions,
  loadCopyModules,
  skipped,
} from './check-destructive-danger-variant';
import {
  type CountAllowlist,
  collectFiles,
  judgeCounts,
  repositoryRoot,
} from './owner-rule-guard-support';

const FILE = 'applications/interborough/src/routes/agents/example.svelte';
const modules: CopyModules = new Map([
  [
    'applications/interborough/src/app/copy/agents',
    {
      AGENT_PAGE_COPY: {
        settings: { deleteDialog: { confirm: 'Delete agent' }, reset: 'Reset filters' },
        discard: 'Discard draft',
        cancel: 'Cancel',
        remove: 'Remove file',
      },
    },
  ],
]);

const find = (markup: string, script = '') =>
  findDestructiveActions(`<script lang="ts">\n${script}\n</script>\n${markup}`, FILE, modules);

const IMPORT = "import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';";
const ALIAS = `${IMPORT}\nconst copy = AGENT_PAGE_COPY.settings;`;

beforeEach(() => {
  skipped.count = 0;
});

describe('destructive actions look dangerous', () => {
  test('reports a Button with a literal destructive label and a non-danger variant', () => {
    expect(find('<Button variant="secondary" label="Delete agent" />')).toHaveLength(1);
    expect(find('<Button variant="soft-danger">Remove it</Button>')).toHaveLength(1);
    expect(find('<Button aria-label="Revoke access" />')).toHaveLength(1);
  });

  test('accepts a Button that is danger or ghost-danger', () => {
    expect(find('<Button variant="danger" label="Delete agent" />')).toEqual([]);
    expect(find('<Button variant="ghost-danger">Delete</Button>')).toEqual([]);
  });

  test('reports an InlineConfirm and a ConfirmDialog without destructive', () => {
    expect(find('<InlineConfirm confirmLabel="Delete it" />')).toHaveLength(1);
    expect(find('<ConfirmDialog confirmLabel="Purge" destructive={false} />')).toHaveLength(1);
    expect(find('<InlineConfirm confirmLabel="Delete it" destructive />')).toEqual([]);
    expect(find('<ConfirmDialog confirmLabel="Wipe" destructive={true} />')).toEqual([]);
  });

  test('resolves a direct copy path', () => {
    expect(find('<ConfirmDialog confirmLabel={AGENT_PAGE_COPY.discard} />', IMPORT)).toEqual([]);
    expect(
      find('<Button variant="secondary" label={AGENT_PAGE_COPY.remove} />', IMPORT),
    ).toHaveLength(1);
  });

  test('resolves a script-level alias, as agent-delete-dialog.svelte does', () => {
    expect(find('<ConfirmDialog confirmLabel={copy.deleteDialog.confirm} />', ALIAS)).toHaveLength(
      1,
    );
    expect(
      find('<ConfirmDialog confirmLabel={copy.deleteDialog.confirm} destructive />', ALIAS),
    ).toEqual([]);
  });

  test.each(['Reset filters', 'Discard draft', 'Cancel', 'Dropdown menu'])(
    'does not treat "%s" as destructive',
    (label) => {
      expect(find(`<Button variant="secondary" label="${label}" />`)).toEqual([]);
      expect(find(`<ConfirmDialog confirmLabel="${label}" />`)).toEqual([]);
    },
  );

  test('skips and counts labels it cannot resolve', () => {
    expect(
      find(
        [
          '<Button variant="secondary" label={copy.remove(row)} />',
          '<Button variant="secondary" label={labelFromScript} />',
          '<ConfirmDialog confirmLabel={copy.missing.path} />',
          '<Button variant="secondary">{pending ? "a" : "b"}</Button>',
        ].join('\n'),
        ALIAS,
      ),
    ).toEqual([]);
    expect(skipped.count).toBe(4);
  });
});

describe('the allowlist', () => {
  test('holds exactly today offenders: no new site and no stale entry', async () => {
    const loaded = await loadCopyModules();
    const paths: string[] = [];
    for (const directory of SCANNED_DIRECTORIES) {
      collectFiles(
        join(repositoryRoot, directory),
        new Set(['.svelte']),
        paths,
        /\.test-harness\.svelte$|\.test\.svelte$/,
      );
    }
    const found = new Map<string, string[]>();
    for (const path of paths) {
      const file = relative(repositoryRoot, path);
      const sites = findDestructiveActions(await Bun.file(path).text(), file, loaded);
      if (sites.length > 0) found.set(file, sites);
    }
    const allowlist = (await Bun.file(
      join(repositoryRoot, ALLOWLIST_PATH),
    ).json()) as CountAllowlist;
    expect(judgeCounts(found, allowlist)).toEqual({ problems: [], stale: [] });
  });
});

describe('the repository copy modules', () => {
  test('load, and resolve the agent delete dialog label through its alias', async () => {
    const path = 'applications/interborough/src/routes/agents/agent-delete-dialog.svelte';
    const source = await Bun.file(join(repositoryRoot, path)).text();
    const loaded = await loadCopyModules();
    expect(findDestructiveActions(source, path, loaded)).toEqual([]);
    expect(
      findDestructiveActions(source.replace(/^ {2}destructive\n/m, ''), path, loaded),
    ).toHaveLength(1);
  });
});
