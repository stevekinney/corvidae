/**
 * Keep every destructive action looking dangerous.
 *
 * Owner complaint (2026-11-25, live review): a destructive action that does not look dangerous.
 * The owner found it twice in one week: once as an accent-coloured "Apply plan: Delete namespace",
 * and again when the fix made it a pale `soft-danger` face that read lighter than the secondary
 * button beside it.
 *
 * The scan is textual, in each non-test Svelte file under `applications/interborough/src`,
 * `components/chat/src` and `applications/playground/src`. It resolves a label when it is
 *
 * - a string literal,
 * - a member path rooted at an identifier imported from `applications/interborough/src/app/copy/`
 *   (resolved by importing the module and walking the path), or
 * - a member path rooted at a script-level `const` alias of such a path, one alias deep
 *   (`const copy = AGENT_PAGE_COPY.settings;`).
 *
 * A `Button`'s labels are its `label` and `aria-label` attributes and its plain text content; an
 * `InlineConfirm`'s and a `ConfirmDialog`'s is `confirmLabel`. A label whose first word is Delete,
 * Remove, Terminate, Destroy, Purge, Revoke, Drop or Wipe is destructive. It is reported when a
 * `Button` has a variant other than `danger` or `ghost-danger` (`ghost-danger` is for a row or a
 * menu, where the action is secondary; `soft-danger` read lighter than its secondary and does not
 * count), or when an `InlineConfirm` or `ConfirmDialog` lacks `destructive` or sets it to false.
 * Reset, Discard and Cancel are left out: they are too often not destructive.
 *
 * A label or a variant the guard cannot resolve is not reported; the guard prints how many it
 * skipped. Offenders from before the guard are listed in
 * `scripts/destructive-danger-variant-allowlist.json`, which only shrinks
 * (`owner-rule-guard-support.ts`).
 *
 * Runs from the root `lint:guards` script.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readTag } from '../applications/interborough/scripts/check-empty-state-layout';
import { lineOf, repositoryRoot, runCountGuard } from './owner-rule-guard-support';

export const SCANNED_DIRECTORIES = [
  'applications/interborough/src',
  'components/chat/src',
  'applications/playground/src',
];
export const ALLOWLIST_PATH = 'scripts/destructive-danger-variant-allowlist.json';
export const COPY_DIRECTORY = 'applications/interborough/src/app/copy';

const DESTRUCTIVE_WORD = /^\s*(?:delete|remove|terminate|destroy|purge|revoke|drop|wipe)\b/i;
const DANGER_VARIANTS = new Set(['danger', 'ghost-danger']);

/** Copy modules by repository-relative path without the extension, as `loadCopyModules` returns. */
export type CopyModules = ReadonlyMap<string, Record<string, unknown>>;

/** How many labels or variants the last scans could not resolve. */
export const skipped = { count: 0 };

/** Imports every copy module, keyed by its repository-relative path without the extension. */
export async function loadCopyModules(): Promise<Map<string, Record<string, unknown>>> {
  const modules = new Map<string, Record<string, unknown>>();
  for (const entry of readdirSync(join(repositoryRoot, COPY_DIRECTORY))) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    modules.set(
      `${COPY_DIRECTORY}/${entry.slice(0, -3)}`,
      (await import(join(repositoryRoot, COPY_DIRECTORY, entry))) as Record<string, unknown>,
    );
  }
  return modules;
}

type Binding = { module: string; exported: string };

/** The copy imports of a script, by local name, resolved to repository-relative module paths. */
function readImports(script: string, relativePath: string): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const match of script.matchAll(/import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[2]!;
    if (!specifier.startsWith('.')) continue;
    const target = resolve(repositoryRoot, dirname(relativePath), specifier)
      .slice(repositoryRoot.length + 1)
      .replace(/\.ts$/, '');
    if (!target.startsWith(`${COPY_DIRECTORY}/`)) continue;
    const clause = match[1]!;
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of named?.[1]?.split(',') ?? []) {
      const pieces = part.trim().split(/\s+as\s+/);
      const exported = pieces[0]!.replace(/^type\s+/, '');
      if (exported !== '') bindings.set(pieces[1] ?? exported, { module: target, exported });
    }
  }
  return bindings;
}

const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** The script-level `const alias = Root.path;` declarations, one level. */
function readAliases(script: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of script.matchAll(
    /^ {0,2}const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?\s*$/gm,
  )) {
    aliases.set(match[1]!, match[2]!);
  }
  return aliases;
}

/** Resolves an attribute value or text to a string, or `undefined` when the guard cannot. */
function resolveLabel(
  value: string,
  imports: ReadonlyMap<string, Binding>,
  aliases: ReadonlyMap<string, string>,
  modules: CopyModules,
): string | undefined {
  const literal = /^(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)$/.exec(value);
  if (literal !== null) return literal[1] ?? literal[2] ?? literal[3];
  if (!MEMBER_PATH.test(value)) return undefined;
  let path = value.split('.');
  const alias = aliases.get(path[0]!);
  if (alias !== undefined) path = [...alias.split('.'), ...path.slice(1)];
  const binding = imports.get(path[0]!);
  const module = binding === undefined ? undefined : modules.get(binding.module);
  if (binding === undefined || module === undefined || !Object.hasOwn(module, binding.exported)) {
    return undefined;
  }
  let current: unknown = module[binding.exported];
  for (const key of path.slice(1)) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

type Attribute = { name: string; value: string | null; braced: boolean };

/** The attributes of an opening tag; a spread is `{ name: '...' }`. */
function readAttributes(tag: string, nameLength: number): Attribute[] {
  const attributes: Attribute[] = [];
  const source = tag.replace(/\/?>$/, '');
  let index = nameLength;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === '{') {
      let depth = 0;
      let end = index;
      for (; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}' && --depth === 0) break;
      }
      const inner = source.slice(index + 1, end).trim();
      attributes.push(
        inner.startsWith('...')
          ? { name: '...', value: null, braced: true }
          : { name: inner, value: inner, braced: true },
      );
      index = end + 1;
    } else {
      const name = /^[^\s=/>{]+/.exec(source.slice(index))?.[0] ?? source[index]!;
      index += name.length;
      if (source[index] !== '=') {
        attributes.push({ name, value: null, braced: false });
        continue;
      }
      index += 1;
      const opener = source[index];
      if (opener === '"' || opener === "'") {
        const end = source.indexOf(opener, index + 1);
        const stop = end === -1 ? source.length : end;
        attributes.push({ name, value: source.slice(index, stop + 1), braced: false });
        index = stop + 1;
      } else if (opener === '{') {
        let depth = 0;
        let end = index;
        for (; end < source.length; end += 1) {
          if (source[end] === '{') depth += 1;
          else if (source[end] === '}' && --depth === 0) break;
        }
        attributes.push({ name, value: source.slice(index + 1, end).trim(), braced: true });
        index = end + 1;
      } else {
        const bare = /^[^\s>]+/.exec(source.slice(index))?.[0] ?? '';
        attributes.push({ name, value: `"${bare}"`, braced: false });
        index += bare.length;
      }
    }
  }
  return attributes;
}

/** Every destructive action that does not look dangerous in `original`, as `<line> - <text>`. */
export function findDestructiveActions(
  original: string,
  relativePath: string,
  modules: CopyModules,
): string[] {
  const script = [...original.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]!)
    .join('\n');
  const imports = readImports(script, relativePath);
  const aliases = readAliases(script);
  const source = original.replace(
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
    (matched) => matched.replace(/[^\n]/g, ' '),
  );
  const resolveValue = (value: string) => resolveLabel(value, imports, aliases, modules);
  const sites: string[] = [];

  for (const match of source.matchAll(/<(Button|InlineConfirm|ConfirmDialog)(?=[\s/>])/g)) {
    const name = match[1]!;
    const tag = readTag(source, match.index);
    const attributes = readAttributes(tag, match[0].length);
    const line = lineOf(source, match.index);
    const attribute = (wanted: string) => attributes.find((candidate) => candidate.name === wanted);

    const candidates: (string | undefined)[] = [];
    if (name === 'Button') {
      for (const wanted of ['label', 'aria-label']) {
        const found = attribute(wanted);
        if (found?.value != null) candidates.push(resolveValue(found.value));
      }
      if (candidates.length === 0 && !tag.endsWith('/>')) {
        const rest = source.slice(match.index + tag.length);
        const body = rest.slice(0, Math.max(rest.indexOf('</Button>'), 0)).trim();
        candidates.push(/^[^<>{}]+$/.test(body) ? body.replace(/\s+/g, ' ') : undefined);
      }
    } else {
      const found = attribute('confirmLabel');
      if (found?.value != null) candidates.push(resolveValue(found.value));
    }
    const labels = candidates.filter((label) => label !== undefined);
    if (labels.length < candidates.length || candidates.length === 0) skipped.count += 1;
    const destructive = labels.find((label) => DESTRUCTIVE_WORD.test(label));
    if (destructive === undefined) continue;

    if (name === 'Button') {
      const variant = attribute('variant');
      const literal = /^["']([^"']*)["']$/.exec(variant?.value ?? '')?.[1];
      const known = variant === undefined || literal !== undefined;
      if (!known) skipped.count += 1;
      else if (!DANGER_VARIANTS.has(literal ?? 'primary')) {
        sites.push(
          `${line} - Button "${destructive}" has variant ${literal ?? '(default)'}, not danger or ghost-danger`,
        );
      }
    } else {
      const flag = attribute('destructive');
      const spread = attributes.some((candidate) => candidate.name === '...');
      if (flag === undefined) {
        if (spread) skipped.count += 1;
        else sites.push(`${line} - ${name} "${destructive}" lacks destructive`);
      } else if (flag.value === 'false') {
        sites.push(`${line} - ${name} "${destructive}" sets destructive to false`);
      }
    }
  }
  return sites;
}

if (import.meta.main) {
  const modules = await loadCopyModules();
  try {
    await runCountGuard({
      name: 'check-destructive-danger-variant',
      advice:
        'a destructive action does not look dangerous.\n' +
        'A Button labelled Delete, Remove, Terminate, Destroy, Purge, Revoke, Drop or Wipe takes variant="danger" (or "ghost-danger" in a row or menu); an InlineConfirm or ConfirmDialog with such a confirmLabel takes `destructive`.',
      passed: 'every resolvable destructive action is danger beyond the allowlist',
      directories: SCANNED_DIRECTORIES,
      extensions: new Set(['.svelte']),
      exclude: /\.test-harness\.svelte$|\.test\.svelte$/,
      allowlistPath: ALLOWLIST_PATH,
      find: (source, relativePath) => findDestructiveActions(source, relativePath, modules),
    });
    process.stdout.write(
      `check-destructive-danger-variant - skipped ${skipped.count} label or variant the guard could not resolve.\n`,
    );
  } catch (error: unknown) {
    console.error('check-destructive-danger-variant failed:', error);
    process.exitCode = 1;
  }
}
