/**
 * Plans and builds the preview scripts: one self-contained IIFE per component that mounts up to
 * four of its playground examples, featured first.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The most examples one preview mounts. */
export const MAX_EXAMPLES = 4;
/** The largest preview script the design system accepts; larger ones become static renditions. */
export const PREVIEW_SCRIPT_CAP = 512 * 1024;
/** How many preview-building processes run at once. */
export const SHARD_COUNT = 4;

/** One example a preview mounts. */
export type PlannedExample = { id: string; title: string };
/** The examples one component's preview mounts, in order. */
export type PreviewPlan = { id: string; examples: PlannedExample[] };

/** One entry of a component's `<id>.examples.json`. */
export type ExampleMetadata = { id: string; title: string; featured?: boolean };

/**
 * Orders a component's examples: featured ones in metadata order, then the rest in metadata
 * order, then files the metadata does not name, sorted, and keeps the first {@link MAX_EXAMPLES}.
 */
export function orderExamples(files: string[], metadata: ExampleMetadata[]): PlannedExample[] {
  const present = new Set(files);
  const titles = new Map(metadata.map((entry) => [entry.id, entry.title]));
  const ordered = [
    ...metadata.filter((entry) => entry.featured && present.has(entry.id)).map((entry) => entry.id),
    ...metadata
      .filter((entry) => !entry.featured && present.has(entry.id))
      .map((entry) => entry.id),
    ...files.filter((file) => !titles.has(file)).toSorted(),
  ].slice(0, MAX_EXAMPLES);
  return ordered.map((id) => ({ id, title: titles.get(id) ?? id }));
}

/**
 * Plans a component's preview from its playground examples, or returns nothing without any. The
 * examples' titles and order come from `<componentsDirectory>/<id>/<id>.examples.json`, the
 * component's folder in its own workspace.
 */
export function planPreview(
  id: string,
  examplesRoot: string,
  componentsDirectory: string,
): PreviewPlan | undefined {
  const directory = join(examplesRoot, id);
  if (!existsSync(directory)) return undefined;
  const suffix = '.example.svelte';
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(suffix))
    .map((file) => file.slice(0, -suffix.length));
  const metadataPath = join(componentsDirectory, id, `${id}.examples.json`);
  const metadata: ExampleMetadata[] = existsSync(metadataPath)
    ? (JSON.parse(readFileSync(metadataPath, 'utf8')) as { examples: ExampleMetadata[] }).examples
    : [];
  const examples = orderExamples(files, metadata);
  return examples.length > 0 ? { id, examples } : undefined;
}

/** The source of a preview's entry module, which mounts each example under its own heading. */
export function previewEntrySource(plan: PreviewPlan, examplesRoot: string): string {
  const imports = plan.examples
    .map(
      (example, index) =>
        `import E${index} from ${JSON.stringify(join(examplesRoot, plan.id, `${example.id}.example.svelte`))};`,
    )
    .join('\n');
  const list = plan.examples
    .map((example, index) => `{ title: ${JSON.stringify(example.title)}, component: E${index} }`)
    .join(',\n  ');
  return `import { mount } from 'svelte';
${imports}
const examples = [
  ${list}
];
const root = document.getElementById('cinder-preview') ?? document.body;
for (const example of examples) {
  const section = document.createElement('section');
  section.className = 'ds-example';
  const heading = document.createElement('p');
  heading.className = 'ds-example__title';
  heading.textContent = example.title;
  const stage = document.createElement('div');
  stage.className = 'example-preview';
  section.append(heading, stage);
  root.append(section);
  try { mount(example.component, { target: stage }); }
  catch (error) { stage.textContent = 'This example could not render here.'; console.error(error); }
}
`;
}

/** Deals ids round-robin into `count` shards, so each shard gets a similar mix. */
export function partition<T>(items: T[], count: number): T[][] {
  const shards: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => shards[index % count]?.push(item));
  return shards.filter((shard) => shard.length > 0);
}

/**
 * A literal replacement character, U+FFFD, with the backslashes before it. The artifact service
 * refuses a published text file holding one, and bundled libraries (a Markdown parser's decoder,
 * a grammar's character class) carry it in string and regular-expression literals.
 */
const REPLACEMENT_CHARACTER = /(\\*)\uFFFD/g;

/**
 * Writes every literal U+FFFD as the escape `\uFFFD`, which means the same character in a string,
 * template or regular-expression literal. An odd run of backslashes before it already escaped it
 * (`\` then U+FFFD is the character itself), so the last of them becomes the escape's own.
 */
export function escapeReplacementCharacters(code: string): string {
  return code.replace(REPLACEMENT_CHARACTER, (_match, backslashes: string) => {
    const kept = backslashes.length % 2 === 1 ? backslashes.slice(0, -1) : backslashes;
    return `${kept}\\uFFFD`;
  });
}

/**
 * Escapes the sequences that would end or open markup if the script were inlined in HTML, and
 * every literal U+FFFD, then fails if any `</script`, in any case, survives.
 */
export function escapePreviewScript(code: string): string {
  const escaped = escapeReplacementCharacters(
    code.replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--'),
  );
  if (/<\/script/i.test(escaped)) throw new Error('preview script still holds a </script');
  return escaped;
}

/** What one preview shard reports. */
export type ShardReport = {
  /** Each built preview: its size, its file, and how many of the planned examples it mounts. */
  built: Record<
    string,
    { bytes: number; file: 'preview.js' | 'preview.full.js'; examples: number }
  >;
  failures: string[];
};
