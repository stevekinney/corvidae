import { dirname, join, relative, sep } from 'node:path';
import { format, getFileInfo, getSupportInfo, resolveConfig } from 'prettier';

/**
 * Format emitted text the way the target's prettier would, or hand it back unchanged.
 *
 * Shared by the two callers below, which differ only in what they start from: a document that
 * has to be stringified first, or bytes already read off disk. Both ask the same question of the
 * same destination path, and the narrowings documented on `serializeJson` — resolution from the
 * destination, `plugins` dropped, `editorconfig` left off, no configuration meaning no change —
 * are implemented here once and apply to both.
 */
async function formatForDestination(text: string, destination: string): Promise<string> {
  const resolved = await resolveConfig(destination);
  if (resolved === null) return text;
  // A parser the target's configuration names but prettier does not ship (`svelte`, from
  // `prettier-plugin-svelte`) cannot run here, because the target's plugins are dropped above.
  // Such a file keeps corvidae's bytes rather than failing the whole plan (COR-1196).
  const shipped = await builtInParsers();
  if (typeof resolved.parser === 'string' && !shipped.has(resolved.parser)) return text;
  return format(text, { ...resolved, plugins: [], filepath: destination });
}

let builtInParserNames: Promise<ReadonlySet<string>> | undefined;

/** The parsers prettier ships without any plugin, read from prettier itself. */
function builtInParsers(): Promise<ReadonlySet<string>> {
  builtInParserNames ??= getSupportInfo().then(
    ({ languages }) => new Set(languages.flatMap((language) => language.parsers)),
  );
  return builtInParserNames;
}

/**
 * Every `.prettierignore` between the clone root and the file, nearest last.
 *
 * Prettier reads an ignore file relative to where it is invoked, and a target can invoke it
 * anywhere: the weft target's `format:check` runs from `packages/weft` and reads the ignore file
 * beside its manifest, not one at its repository root. Collecting the chain asks about every
 * ignore file that could govern the path rather than guessing which directory the target's
 * script runs in, and prettier resolves each file's patterns against its own directory.
 */
async function ignoreFilesFor(targetDirectory: string, destination: string): Promise<string[]> {
  const found: string[] = [];
  let directory = dirname(destination);
  for (;;) {
    const candidate = join(directory, '.prettierignore');
    if (await Bun.file(candidate).exists()) found.unshift(candidate);
    if (directory === targetDirectory) break;
    const parent = dirname(directory);
    if (parent === directory || relative(targetDirectory, parent).startsWith(`..${sep}`)) break;
    directory = parent;
  }
  return found;
}

/**
 * An emitted source file's bytes, formatted when the target's prettier governs the path.
 *
 * The source half copies bytes, which is why one workspace's PNG baseline fixture survives the
 * trip, and that default is unchanged: this only intercepts a path prettier claims. Governed
 * means prettier infers a parser for it and no `.prettierignore` between the clone root and the
 * file excludes it — the weft target ignores `weft.generated.d.ts` precisely because a codegen
 * fixture has to stay byte-stable, and an emitted copy of it must be left alone for the same
 * reason its own copy is.
 *
 * The general rule rather than a markdown-shaped one, because the defect is not about markdown.
 * Corvidae's `*.md` override sets `proseWrap: "never"` and the weft target's does not, so
 * prettier pads the tables in two emitted documents that corvidae prints compact, and the target
 * refuses them — the same divergence that expanded a JSON array, one file class over. The two
 * repositories agree about TypeScript today and nothing holds them there, so the question asked
 * here is whether the target's formatter governs the file, not what kind of file it is.
 *
 * Measured before it shipped: of 1,825 emitted files inside the weft target's `format:check`
 * glob, three were unclean under the target's own configuration, one of those ignored by it, and
 * the rule changes exactly the two documents that remain.
 */
export async function formatEmittedFile(
  contents: Uint8Array,
  targetDirectory: string | undefined,
  path: string,
): Promise<Uint8Array> {
  if (targetDirectory === undefined) return contents;
  const destination = join(targetDirectory, path);
  // `plugins: []` here for the same reason it is passed to `format` below, and it is easy to
  // miss: `getFileInfo` resolves the target's configuration to infer a parser, and resolving it
  // imports the plugins it names. Without this, the governance question alone throws
  // `ERR_MODULE_NOT_FOUND` on a plugin corvidae lacks, before any formatting is attempted.
  const info = await getFileInfo(destination, {
    ignorePath: await ignoreFilesFor(targetDirectory, destination),
    plugins: [],
  });
  if (info.ignored || info.inferredParser === null) return contents;
  const text = new TextDecoder().decode(contents);
  const formatted = await formatForDestination(text, destination);
  if (formatted === text) return contents;
  return new TextEncoder().encode(formatted);
}

/**
 * Serialize an emitted JSON document the way the *target's* prettier would write it.
 *
 * `JSON.stringify` always breaks an array across lines; prettier collapses one that fits inside
 * the print width. Corvidae's own `src/cli/__fixtures__/codegen/typecheck/tsconfig.json` carries
 * `"include": ["consumer.ts", "weft.generated.d.ts"]` on one line and is prettier-clean here, so
 * re-serializing it emitted a three-line array into the weft target and failed that repository's
 * `format:check`. Nothing about the document changed — only its bytes — which is exactly the kind
 * of difference a formatter exists to settle.
 *
 * All three JSON serializers in the transform share this, and all three had the defect. Only the
 * tsconfig half tripped it, because every array an emitted manifest currently carries happens to
 * be longer than the target's print width; that is a property of today's manifests and not one
 * anything here controls, so the other two were correct by luck rather than by construction.
 *
 * Configuration is resolved from the emitted file's destination inside the clone, never from
 * corvidae. Prettier resolves by walking up from the file's own path and the answer genuinely
 * differs: the weft target keeps its configuration at `packages/weft/`, not at its repository
 * root. Formatting against corvidae's own configuration would agree only by coincidence.
 *
 * Four deliberate narrowings, each of which looks like an omission until it is not:
 *
 * - **A document is left alone when no configuration resolves.** Not a fallback to prettier's
 *   defaults: a default-width format would re-pack arrays in the emitted root `package.json`,
 *   which the manifest inversion worked to make byte-for-byte identical to the target's. Churning
 *   it would undo that for a file the weft target does not even check — its `format:check` is
 *   delegated per workspace through turbo — so with nothing to obey, the document stands as it is.
 * - **`plugins` is dropped from the resolved configuration.** A plugin named in the target's
 *   configuration is imported by *this* process, and at plan time the clone has no `node_modules`
 *   at all, because the lockfile install is the last thing a sync does. Honoring the list makes
 *   any plugin corvidae does not itself install throw `ERR_MODULE_NOT_FOUND` — a transform killed
 *   by a line in the repository it is transforming. The empty array is load-bearing, not lazy. No
 *   plugin either target declares affects a JSON document, so the emitted bytes do not change.
 * - **`editorconfig` is left at prettier's default, which is off.** The goal is to match the CLI
 *   that runs the target's `format:check`, and `resolveConfig`'s defaults are not the CLI's.
 *   Measured on prettier 3.9.6: a `max_line_length = 20` in an `.editorconfig` changes what
 *   `resolveConfig(…, { editorconfig: true })` returns and changes nothing about what
 *   `prettier --check` accepts. Requesting it would format against a width the gate does not use.
 * - **The indented `JSON.stringify` output is what prettier receives, not a compact one.**
 *   Prettier's JSON printer keeps an object expanded when its input already broke after `{`, so
 *   feeding it the indented form preserves the object shape corvidae emits today and changes only
 *   the array packing that prettier alone decides.
 *
 * @param document The value to emit.
 * @param targetDirectory The clone being planned against, or `undefined` on a fresh target.
 * @param path The target-relative path this document is emitted to.
 */
export async function serializeJson(
  document: unknown,
  targetDirectory: string | undefined,
  path: string,
): Promise<string> {
  const text = `${JSON.stringify(document, undefined, 2)}\n`;
  if (targetDirectory === undefined) return text;
  return formatForDestination(text, join(targetDirectory, path));
}
