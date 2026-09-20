import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';

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
  const destination = join(targetDirectory, path);
  const resolved = await resolveConfig(destination);
  if (resolved === null) return text;
  return format(text, { ...resolved, plugins: [], filepath: destination });
}
