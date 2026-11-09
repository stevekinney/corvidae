// The process documents name scripts and link each other; a rename or a moved heading must not
// leave them pointing at nothing (documentation/repository/guards.md "Process documentation").
// Every `scripts/...` path and `bun scripts/...` command they name must exist, and every relative
// Markdown link in them must resolve, `#anchor` included.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  workspaceChildDirectoryNames,
  workspaceParentDirectories,
} from './workspace-directories.ts';

const root = join(import.meta.dir, '..');

const documentGlobs = [
  'AGENTS.md',
  '.agents/skills/**/*.md',
  '.claude/agents/*.md',
  'documentation/repository/*.md',
];

/**
 * Spans that look like a `scripts/` path but are not one on purpose. Each entry needs a reason.
 * Keyed by the span as extracted (after stripping flags and trailing punctuation).
 */
const notPaths = new Map<string, string>([]);

/** Every workspace directory, so a `scripts/...` path inside a workspace resolves there too. */
const workspaceRoots = [
  ...workspaceParentDirectories.flatMap((parent) =>
    workspaceChildDirectoryNames(root, parent).map((name) => join(parent, name)),
  ),
  'scripts/browser-fixtures',
];

function documents(): string[] {
  const found = new Set<string>();
  for (const pattern of documentGlobs)
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root, dot: true })) found.add(path);
  return [...found].toSorted();
}

/** The text with fenced code blocks blanked out, line count preserved. */
export function withoutFences(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/u.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** The text with inline code spans blanked out. */
function withoutCodeSpans(text: string): string {
  return text.replace(/`[^`\n]*`/gu, (span) => ' '.repeat(span.length));
}

/**
 * The `scripts/...` paths a text names, as written: a path that starts at `scripts/` (not one
 * nested in another directory such as `packages/weft/scripts/`), cut at the first character that
 * cannot be part of a path, so a command's flags and arguments are dropped.
 */
export function scriptPathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\w./@-])scripts\/[\w./*<>{},@-]*/gu)) {
    const path = match[0].replace(/[.,:]+$/u, '');
    found.add(path);
  }
  return [...found];
}

/** Whether `path` names something that exists, at the root or inside any workspace. */
function scriptPathExists(path: string): boolean {
  // A placeholder such as `<area>` or a brace alternative stands for any name: match it as a glob.
  const pattern = path.replace(/<[^>]*>/gu, '*');
  const bases = ['', ...workspaceRoots];
  if (!/[*{]/u.test(pattern)) return bases.some((base) => existsSync(join(root, base, pattern)));
  const glob = new Bun.Glob(pattern.replace(/\/$/u, ''));
  return bases.some((base) => {
    const cwd = join(root, base);
    if (!existsSync(cwd)) return false;
    for (const _ of glob.scanSync({ cwd, onlyFiles: false, dot: true })) return true;
    return false;
  });
}

/** GitHub's heading anchors for a Markdown document, duplicates numbered `-1`, `-2`. */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of withoutFences(markdown).split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading === null) continue;
    const base = (heading[1] ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/gu, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** The relative link targets in a Markdown text, outside code. */
export function relativeLinksIn(markdown: string): string[] {
  const text = withoutCodeSpans(withoutFences(markdown));
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const target = match[1] ?? '';
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

/** Why a link from `document` to `target` does not resolve, or `undefined` when it does. */
function linkProblem(document: string, target: string): string | undefined {
  const [file = '', anchor] = target.split('#', 2);
  const resolved = file === '' ? join(root, document) : join(root, dirname(document), file);
  if (!existsSync(resolved)) return `${target}: ${relative(root, resolved)} does not exist`;
  if (anchor === undefined || anchor === '') return undefined;
  if (statSync(resolved).isDirectory() || !resolved.endsWith('.md'))
    return `${target}: an anchor into a file that is not Markdown`;
  if (!headingAnchors(readFileSync(resolved, 'utf8')).has(decodeURIComponent(anchor)))
    return `${target}: no heading #${anchor} in ${relative(root, resolved)}`;
  return undefined;
}

describe('the helpers', () => {
  test('take a path from a command and drop its flags and trailing punctuation', () => {
    expect(
      scriptPathsIn('Run `bun scripts/chef/brief.ts <ID> --json`, then `scripts/x.ts`.'),
    ).toEqual(['scripts/chef/brief.ts', 'scripts/x.ts']);
    expect(scriptPathsIn('packages/weft/scripts/check.ts and ../../scripts/a.ts')).toEqual([]);
    expect(scriptPathsIn('`tmp/chef/packets/<area>.md` and `scripts/chef/<name>.ts`')).toEqual([
      'scripts/chef/<name>.ts',
    ]);
  });

  test('anchor headings the way GitHub does', () => {
    const anchors = headingAnchors(
      '# Title\n## A crashed `--parallel` worker\n## Gate tiers and main health\n## Title\n',
    );
    expect([...anchors]).toEqual([
      'title',
      'a-crashed---parallel-worker',
      'gate-tiers-and-main-health',
      'title-1',
    ]);
  });

  test('read relative links outside code only', () => {
    expect(
      relativeLinksIn(
        '[a](a.md) [b](https://x.test) `[c](c.md)`\n```\n[d](d.md)\n```\n[e](#here "t")',
      ),
    ).toEqual(['a.md', '#here']);
  });
});

describe('the process documents', () => {
  const paths = documents();

  test('are found', () => {
    expect(paths).toContain('AGENTS.md');
    expect(paths.some((path) => path.startsWith('.claude/agents/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('documentation/repository/'))).toBe(true);
  });

  test('name only scripts that exist', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const document of paths) {
      const text = readFileSync(join(root, document), 'utf8');
      for (const path of scriptPathsIn(text)) {
        checked += 1;
        if (notPaths.has(path) || scriptPathExists(path)) continue;
        missing.push(`${document}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
    // The extractor must keep finding the paths the documents name, or the check proves nothing.
    expect(checked).toBeGreaterThan(100);
  });

  test('link only to files and headings that exist', () => {
    const broken: string[] = [];
    let anchored = 0;
    for (const document of paths) {
      const text = readFileSync(join(root, document), 'utf8');
      for (const target of relativeLinksIn(text)) {
        if (target.includes('#')) anchored += 1;
        const problem = linkProblem(document, target);
        if (problem !== undefined) broken.push(`${document}: ${problem}`);
      }
    }
    expect(broken).toEqual([]);
    expect(anchored).toBeGreaterThan(5);
  });

  test('quote only AGENTS.md sections that exist', () => {
    // Documents and scripts cite a rule by its AGENTS.md section name in quotes: a heading, a bold lead such as
    // **Gate on local checks**, or a paragraph lead such as "Test tiers.".
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const headings = new Set(
      [...withoutFences(agents).matchAll(/^#{1,6}\s+(.*?)\s*$/gmu)].map((match) => match[1]),
    );
    const exists = (name: string) =>
      headings.has(name) ||
      agents.includes(`**${name}**`) ||
      new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.`, 'mu').test(agents);
    const sources = [
      ...paths,
      ...new Bun.Glob('scripts/*.ts').scanSync({ cwd: root }),
      ...new Bun.Glob('scripts/chef/*.ts').scanSync({ cwd: root }),
      ...new Bun.Glob('.codex/agents/*.toml').scanSync({ cwd: root, dot: true }),
      ...new Bun.Glob('{applications,components,packages}/*/scripts/**/*.ts').scanSync({
        cwd: root,
      }),
      '.github/copilot-instructions.md',
    ];
    const unknown: string[] = [];
    let cited = 0;
    for (const source of sources) {
      const text = readFileSync(join(root, source), 'utf8');
      for (const match of text.matchAll(/AGENTS\.md`? "([^"\n]+)"/gu)) {
        cited += 1;
        if (!exists(match[1] ?? '')) unknown.push(`${source}: "${match[1]}"`);
      }
    }
    expect(unknown).toEqual([]);
    expect(cited).toBeGreaterThan(10);
  });

  test('keep every allowlist entry in use', () => {
    const all = paths.flatMap((document) =>
      scriptPathsIn(readFileSync(join(root, document), 'utf8')),
    );
    for (const entry of notPaths.keys()) expect(all, entry).toContain(entry);
  });
});
