/**
 * The codemod that moves authored component metadata out of module-script JSDoc and
 * `.constraints.ts` files into JSON (COR-2077). Re-runnable: a branch that still adds `@cinder`
 * tags after merging `main` runs it once and commits the result.
 *
 * ```sh
 * bun internal/component-tooling/scripts/convert-component-metadata.ts           # convert
 * bun internal/component-tooling/scripts/convert-component-metadata.ts --check   # exit 1 if anything is left
 * ```
 *
 * For cinder, chat, editor and terminal it:
 *
 * 1. reads the `@cinder` JSDoc block of every `.svelte` module script, writes its tags into
 *    `<name>.meta.json` beside the file (tags win over the fields an existing file already
 *    holds; fields tags cannot carry, such as `compound`, are kept), and deletes the block, and
 *    the module script with it when nothing else is left in it;
 * 2. copies the playground's compound families into each root's `compound.parts`, while
 *    `applications/playground/src/shell-app/compound-families.ts` still exists;
 * 3. deletes each `<name>.constraints.ts` whose authored `<name>.constraints.json` exists, and
 *    points its `<name>.constraints.test.ts` at the JSON;
 * 4. writes `components/cinder/src/schemas/component-meta.schema.json` from `src/manifest.meta.ts`.
 *
 * `--check` reports any step with work left, which is what `lint:checks` runs.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { prettier } from './lib/node-prettier.ts';

import {
  buildComponentMetaSchema,
  COMPONENT_META_SCHEMA_PATH,
  COMPONENT_PACKAGE_ROOTS,
  componentsRootOf,
  metaSchemaReference,
  parseComponentMeta,
} from './lib/component-meta.ts';

/** The command that converts what `--check` reports. */
export const CONVERT_COMPONENT_METADATA_COMMAND =
  'bun internal/component-tooling/scripts/convert-component-metadata.ts';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const COMPOUND_FAMILIES_PATH = join(
  repositoryRoot,
  'applications',
  'playground',
  'src',
  'shell-app',
  'compound-families.ts',
);
const DISCOVER_PATH = join(repositoryRoot, 'applications', 'playground', 'src', 'discover.ts');

const MODULE_SCRIPT =
  /<script\b(?:[^>]*\bmodule\b[^>]*|[^>]*\bcontext\s*=\s*["']module["'][^>]*)>([\s\S]*?)<\/script>/g;
const JSDOC_BLOCK = /\/\*\*([\s\S]*?)\*\//g;
const JSDOC_LINE_PREFIX = /^\s*\*\s?/;
const RETIRED_PROSE = /`@cinder` block/g;

type Tag = { name: string; value: string };

/** One tagged module script: its tags and the source with the block removed. */
export type TaggedSource = { tags: Tag[]; stripped: string };

function splitOnFirstPipe(value: string): { before: string; after: string | undefined } {
  const match = /\s*\|\s*/.exec(value);
  if (match === null) return { before: value.trim(), after: undefined };
  return {
    before: value.slice(0, match.index).trim(),
    after: value.slice(match.index + match[0].length).trim(),
  };
}

/** Tags from the `@cinder` line on; a value that wraps onto later lines is joined with spaces. */
function parseTags(body: string): Tag[] | undefined {
  const lines = body.split('\n').map((line) => line.replace(JSDOC_LINE_PREFIX, '').trimEnd());
  const start = lines.findIndex((line) => /^\s*@cinder\b/.test(line));
  if (start === -1) return undefined;
  const tags: Tag[] = [];
  let current: Tag | undefined;
  for (const line of lines.slice(start)) {
    const tag = /^@(\S+)(?:\s+(.*))?$/.exec(line.trim());
    if (tag) {
      if (current) tags.push(current);
      current = { name: tag[1] ?? '', value: (tag[2] ?? '').trim() };
    } else if (current && line.trim()) {
      current = { name: current.name, value: `${current.value} ${line.trim()}`.trim() };
    }
  }
  if (current) tags.push(current);
  return tags;
}

/**
 * The `@cinder` block of a Svelte file's module script, parsed, and the file without it. A module
 * script left with nothing but whitespace is removed with the blank line after it.
 */
export function extractTaggedSource(source: string): TaggedSource | undefined {
  for (const script of source.matchAll(MODULE_SCRIPT)) {
    const content = script[1] ?? '';
    const contentStart = (script.index ?? 0) + script[0].indexOf(content, script[0].indexOf('>'));
    for (const block of content.matchAll(JSDOC_BLOCK)) {
      const tags = parseTags(block[1] ?? '');
      if (tags === undefined) continue;
      const blockStart = contentStart + (block.index ?? 0);
      const lineStart = source.lastIndexOf('\n', blockStart - 1) + 1;
      const blockEnd = blockStart + block[0].length;
      const lineEnd = source.indexOf('\n', blockEnd);
      let resumeAt = lineEnd === -1 ? source.length : lineEnd + 1;
      // A blank line that separated the block from the script's first statement goes with it.
      const openedScript = /<script\b[^>]*>\n$/.test(source.slice(0, lineStart));
      if (openedScript && source[resumeAt] === '\n') resumeAt += 1;
      const withoutBlock = source.slice(0, lineStart) + source.slice(resumeAt);
      // The module script starts where it did; when only whitespace is left in it, drop it and
      // the blank line that separated it from the instance script.
      const scriptStart = script.index ?? 0;
      const emptyScript = /^<script\b[^>]*>\s*<\/script>\n?\n?/.exec(
        withoutBlock.slice(scriptStart),
      );
      if (emptyScript === null) return { tags, stripped: withoutBlock };
      return {
        tags,
        stripped:
          withoutBlock.slice(0, scriptStart) +
          withoutBlock.slice(scriptStart + emptyScript[0].length),
      };
    }
  }
  return undefined;
}

/** The `<name>.meta.json` fields the tags carry, as authored, before validation. */
export function metaFromTags(tags: Tag[]): Record<string, unknown> {
  const values = (name: string) => tags.filter((tag) => tag.name === name).map((tag) => tag.value);
  const single = (name: string) => values(name)[0];
  const meta: Record<string, unknown> = {
    category: single('category'),
    status: single('status'),
    purpose: single('purpose'),
    tags: values('tag'),
    useWhen: values('useWhen'),
    avoidWhen: values('avoidWhen').map((value) => {
      const { before, after } = splitOnFirstPipe(value);
      return after === undefined ? { reason: before } : { reason: before, alternative: after };
    }),
    related: values('related').flatMap((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  };
  const rationale = single('rationale');
  if (rationale !== undefined) meta['rationale'] = rationale;
  const pattern = single('a11yPattern');
  const keyboard = values('keyboardShortcut').map((value) => {
    const { before, after } = splitOnFirstPipe(value);
    return { keys: before, action: after ?? '' };
  });
  const notes = values('a11yNote').map((value) => value.trim());
  if (pattern !== undefined || keyboard.length > 0 || notes.length > 0) {
    meta['a11y'] = {
      ...(pattern === undefined ? {} : { pattern: pattern.trim() }),
      ...(keyboard.length > 0 ? { keyboard } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }
  for (const name of ['category', 'status', 'purpose', 'a11yPattern']) {
    if (values(name).length > 1) throw new Error(`duplicate @${name} tag`);
  }
  return meta;
}

const FIELD_ORDER = [
  '$schema',
  'category',
  'status',
  'purpose',
  'tags',
  'useWhen',
  'avoidWhen',
  'related',
  'rationale',
  'a11y',
  'compound',
  'composeOnly',
] as const;

const TAG_FIELDS = new Set([
  'category',
  'status',
  'purpose',
  'tags',
  'useWhen',
  'avoidWhen',
  'related',
  'rationale',
  'a11y',
]);

async function format(text: string, file: string): Promise<string> {
  const options = await prettier.resolveConfig(file);
  return prettier.format(text, { ...options, filepath: file });
}

async function formatJson(value: unknown, file: string): Promise<string> {
  return format(JSON.stringify(value), file);
}

/** Serialize a meta object in the canonical field order, formatted as the repository formats JSON. */
export async function serializeMeta(meta: Record<string, unknown>, file: string): Promise<string> {
  const ordered: Record<string, unknown> = {};
  for (const field of FIELD_ORDER) if (meta[field] !== undefined) ordered[field] = meta[field];
  return formatJson(ordered, file);
}

/** The compound data the playground still authors by hand, while it does. */
type PlaygroundCompounds = {
  families: Record<string, readonly string[]>;
  composeOnly: ReadonlySet<string>;
};

async function playgroundCompounds(): Promise<PlaygroundCompounds> {
  const families = existsSync(COMPOUND_FAMILIES_PATH)
    ? (
        (await import(COMPOUND_FAMILIES_PATH)) as {
          COMPOUND_COMPONENT_FAMILIES: Record<string, readonly string[]>;
        }
      ).COMPOUND_COMPONENT_FAMILIES
    : {};
  // `discover.ts` listed the compose-only parts as a literal set; once the set is derived from
  // `composeOnly` there is no literal left to read.
  const discover = existsSync(DISCOVER_PATH) ? readFileSync(DISCOVER_PATH, 'utf8') : '';
  const literal = /COMPOSE_ONLY_COMPONENTS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(
    discover,
  )?.[1];
  const composeOnly = new Set(
    [...(literal ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] ?? ''),
  );
  return { families, composeOnly };
}

function svelteFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.svelte'))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
}

/**
 * Chat, editor and terminal write their `components.json` by hand, so a field it holds that the
 * tags never carried (terminal's `a11y`) was authored there. It moves into `<name>.meta.json` with
 * the rest; tags and an existing file win over it. Cinder generates its manifest from the
 * metadata, so it has nothing to contribute.
 */
function handAuthoredManifestFields(packageRoot: string, id: string): Record<string, unknown> {
  const manifestPath = join(packageRoot, 'components.json');
  if (packageRoot === COMPONENT_PACKAGE_ROOTS[0] || !existsSync(manifestPath)) return {};
  const manifest: { components?: Array<Record<string, unknown>> } = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  );
  const entry = manifest.components?.find((component) => component['id'] === id);
  if (entry === undefined) return {};
  return Object.fromEntries(Object.entries(entry).filter(([key]) => TAG_FIELDS.has(key)));
}

/** One unit of work the codemod would do; `--check` lists them. */
export type Pending = { file: string; reason: string };

type Plan = { writes: Map<string, string>; deletes: string[]; pending: Pending[] };

async function planMetadata(plan: Plan, compounds: PlaygroundCompounds): Promise<void> {
  const { families } = compounds;
  const problems: string[] = [];
  for (const packageRoot of COMPONENT_PACKAGE_ROOTS) {
    for (const file of svelteFiles(componentsRootOf(packageRoot))) {
      const source = readFileSync(file, 'utf8');
      const tagged = extractTaggedSource(source);
      const id = basename(file, '.svelte');
      const directory = dirname(file);
      const target = join(directory, `${id}.meta.json`);
      const parts = families[id];
      if (tagged === undefined && RETIRED_PROSE.test(source)) {
        // Prose that names the retired tag block now names the file that replaced it.
        plan.writes.set(file, source.replaceAll(RETIRED_PROSE, '`<name>.meta.json`'));
        plan.pending.push({ file, reason: 'prose naming the retired @cinder block' });
      }
      const composeOnly = compounds.composeOnly.has(id);
      if (tagged === undefined && ((parts === undefined && !composeOnly) || !existsSync(target))) {
        continue;
      }
      const existing: Record<string, unknown> = existsSync(target)
        ? JSON.parse(readFileSync(target, 'utf8'))
        : {};
      let fromTags: Record<string, unknown> = {};
      if (tagged !== undefined) {
        try {
          fromTags = metaFromTags(tagged.tags);
        } catch (error) {
          problems.push(`${relative(repositoryRoot, file)}: ${(error as Error).message}`);
          continue;
        }
      }
      const kept = Object.fromEntries(
        Object.entries(existing).filter(([key]) => tagged === undefined || !TAG_FIELDS.has(key)),
      );
      const meta: Record<string, unknown> = {
        ...handAuthoredManifestFields(packageRoot, id),
        ...kept,
        ...fromTags,
        $schema: metaSchemaReference(directory),
        ...(parts === undefined ? {} : { compound: { parts: [...parts] } }),
        ...(composeOnly ? { composeOnly: true } : {}),
      };
      // A part file outside the component directories (`toolbar/toolbar-group.svelte`,
      // `_radio/radio.svelte`) keeps its tags as authored: nothing reads them, and they were
      // never validated, so converting them must not fail on them.
      const isComponent =
        basename(directory) === id && !id.startsWith('_') && !directory.includes('/_');
      const result = parseComponentMeta(meta, id, target);
      if (!result.ok && isComponent) {
        problems.push(`${relative(repositoryRoot, file)}: ${result.error.reason}`);
        continue;
      }
      const text = await serializeMeta(meta, target);
      if (!existsSync(target) || readFileSync(target, 'utf8') !== text) {
        plan.writes.set(target, text);
        plan.pending.push({ file: target, reason: 'metadata to write' });
      }
      if (tagged !== undefined) {
        plan.writes.set(file, tagged.stripped);
        plan.pending.push({ file, reason: 'module-script @cinder tags to move into JSON' });
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`metadata that does not convert cleanly:\n  ${problems.join('\n  ')}`);
  }
}

async function planConstraints(plan: Plan): Promise<void> {
  for (const packageRoot of COMPONENT_PACKAGE_ROOTS) {
    const root = componentsRootOf(packageRoot);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const source = join(root, name, `${name}.constraints.ts`);
      if (!existsSync(source)) continue;
      if (!existsSync(join(root, name, `${name}.constraints.json`))) {
        throw new Error(
          `${relative(repositoryRoot, source)} has no ${name}.constraints.json to keep`,
        );
      }
      plan.deletes.push(source);
      plan.pending.push({ file: source, reason: 'constraints authored in TypeScript' });
      const test = join(root, name, `${name}.constraints.test.ts`);
      if (!existsSync(test)) continue;
      const text = readFileSync(test, 'utf8');
      const imported = new RegExp(
        `^import (\\w+) from '\\./${name}\\.constraints\\.ts';\\n`,
        'm',
      ).exec(text);
      if (imported === null) continue;
      const binding = imported[1] ?? '';
      const withImport = text.replace(
        imported[0],
        `import ${binding}Json from './${name}.constraints.json' with { type: 'json' };\n`,
      );
      // Name the document type in the file's existing type import from the evaluator module, or
      // in its value import when it has no type import, so the module is imported once of each.
      const typeImport =
        /^import type \{ ([^}]*) \} from '\.\.\/\.\.\/_internal\/constraints\.ts';$/m;
      const withJson = typeImport.test(withImport)
        ? withImport.replace(
            typeImport,
            (_, names: string) =>
              `import type { ${names}, ConstraintsDocument } from '../../_internal/constraints.ts';`,
          )
        : withImport.replace(
            "import { evaluateConstraints } from '../../_internal/constraints.ts';",
            "import { evaluateConstraints, type ConstraintsDocument } from '../../_internal/constraints.ts';",
          );
      const lastImport = [...withJson.matchAll(/^import [\s\S]*?;\n/gm)].at(-1);
      const insertAt = (lastImport?.index ?? 0) + (lastImport?.[0].length ?? 0);
      const rewritten =
        withJson.slice(0, insertAt) +
        `\n// The authored JSON, typed: its string literals widen to \`string\` on import.\nconst ${binding} = ${binding}Json as ConstraintsDocument;\n` +
        withJson.slice(insertAt);
      plan.writes.set(test, await format(rewritten, test));
    }
  }
}

async function planSchema(plan: Plan): Promise<void> {
  const text = await formatJson(buildComponentMetaSchema(), COMPONENT_META_SCHEMA_PATH);
  if (
    existsSync(COMPONENT_META_SCHEMA_PATH) &&
    readFileSync(COMPONENT_META_SCHEMA_PATH, 'utf8') === text
  ) {
    return;
  }
  plan.writes.set(COMPONENT_META_SCHEMA_PATH, text);
  plan.pending.push({ file: COMPONENT_META_SCHEMA_PATH, reason: 'schema to regenerate' });
}

const RETIRED_PARSER = /(['"])((?:\.\.?\/)+(?:[\w-]+\/)*)generate-component-metadata\.ts\1/g;
const META_MODULE = join(
  import.meta.dir,
  '../../../components/cinder/scripts/lib/component-meta.ts',
);

/** Point imports of the retired JSDoc parser at `scripts/lib/component-meta.ts`, which replaced it. */
function planRetiredImports(plan: Plan): void {
  for (const packageRoot of COMPONENT_PACKAGE_ROOTS) {
    const sourceRoot = join(packageRoot, 'src');
    if (!existsSync(sourceRoot)) continue;
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(?:ts|svelte)$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      const text = plan.writes.get(file) ?? readFileSync(file, 'utf8');
      if (!RETIRED_PARSER.test(text)) continue;
      RETIRED_PARSER.lastIndex = 0;
      let specifier = relative(dirname(file), META_MODULE);
      if (!specifier.startsWith('.')) specifier = `./${specifier}`;
      plan.writes.set(
        file,
        text.replaceAll(RETIRED_PARSER, (_, quote: string) => `${quote}${specifier}${quote}`),
      );
      plan.pending.push({ file, reason: 'import of the retired JSDoc metadata parser' });
    }
  }
}

/** Everything the codemod would change, without changing it. */
export async function planConversion(): Promise<Plan> {
  const plan: Plan = { writes: new Map(), deletes: [], pending: [] };
  await planSchema(plan);
  await planMetadata(plan, await playgroundCompounds());
  await planConstraints(plan);
  planRetiredImports(plan);
  return plan;
}

/** Apply the conversion; returns the files it wrote or deleted. */
export async function convertComponentMetadata(): Promise<string[]> {
  const plan = await planConversion();
  for (const [file, text] of plan.writes) writeFileSync(file, text);
  for (const file of plan.deletes) rmSync(file);
  return [...plan.writes.keys(), ...plan.deletes];
}

/** What `--check` prints for the work left: one line per file, then the command that does it. */
export function pendingReport(pending: readonly Pending[]): string {
  const lines = pending.map((item) => `${relative(repositoryRoot, item.file)}: ${item.reason}`);
  lines.push(
    `Component metadata lives in <name>.meta.json and <name>.constraints.json. Run \`${CONVERT_COMPONENT_METADATA_COMMAND}\` from the repository root and commit the result.`,
  );
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const { pending } = await planConversion();
    if (pending.length > 0) {
      process.stderr.write(pendingReport(pending));
      process.exitCode = 1;
    } else {
      process.stdout.write('component metadata: OK, all authored in JSON\n');
    }
  } else {
    const changed = await convertComponentMetadata();
    for (const file of changed) process.stdout.write(`${relative(repositoryRoot, file)}\n`);
    process.stdout.write(`converted ${changed.length} file(s)\n`);
  }
}
