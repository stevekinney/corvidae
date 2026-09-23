import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { formatEmittedFile } from './json-formatting.ts';
import type { PackageSurfaceEntry } from './package-surface.ts';
import { isTypeScriptConfiguration } from './target-resolvability.ts';

/**
 * The source half of the mirror transform: corvidae's workspace source in, the same tree at the
 * target's own path out.
 *
 * Until COR-1221 the transform wrote manifests, exports maps and TypeScript configuration over a
 * target that still supplied every line of source itself, which is backwards from the premise
 * that corvidae is where the code lives. This emits the source, prunes what corvidae no longer
 * has, and answers three questions the write path could not previously ask.
 *
 * **What counts as source.** A workspace's `src/` tree, and nothing else. The build inputs
 * `package-surface.json` records — `scripts/build.ts`, `tsdown.config.ts`, `vite.config.ts` — are
 * emitted too when corvidae carries one, which it carries none of today; they stay target-owned
 * and `assertBuildInputsPresent` fails a sync whose clone is missing one. A workspace that turns
 * out to need anything else fails there, by name, rather than being patched in here.
 *
 * **Why files are read as bytes.** `packages/testing/src/helpers/__fixtures__` carries a PNG
 * baseline inside a source tree, so a plan typed as string-to-string could not carry it. Reading
 * every file as bytes removes the text-or-binary guess entirely; git compares bytes either way.
 *
 * **Why the non-source filter is here and not in the guard.** Corvidae's workspaces carry files
 * that match the target-owned globs — `coverage-ratchet.json`, `AGENTS.md`, `.gitignore`,
 * `CHANGELOG*` — and a plan containing one is a refusal, not a warning. Those must therefore
 * never enter the plan. The tempting shortcut is to filter the plan through the guard's own
 * matcher, which would quietly turn a refusal into a filter: the guard would stop being able to
 * fail. So the rule lives here, as a short enumerated list with its own reasons, and the guard
 * keeps its only job, which is to refuse.
 */

export class SourceEmissionError extends Error {}

/** One workspace the transform emits, in corvidae and in the target. */
export interface EmittedWorkspace {
  /** The `@lostgradient/*` name. */
  workspace: string;
  /** Corvidae-relative directory, read from disk. */
  corvidaeDirectory: string;
  /** Target-relative directory, from `layout-map.json`. */
  targetDirectory: string;
  /** The published surface, when the workspace publishes; absent for a private workspace. */
  entry?: PackageSurfaceEntry | undefined;
}

/**
 * The directory holding a workspace's source, relative to the workspace.
 *
 * One tree, not a per-package `sourceRoot`: `package-surface.json` records `src/lib` for the two
 * SvelteKit packages, which is where their *published* entry points live, not the whole of what
 * they compile. Emitting `src/` covers both and keeps the prune scope the same shape as the
 * emission scope.
 */
export const sourceTree = 'src';

/**
 * Names that are repository-operating files rather than source, wherever they appear.
 *
 * Every one of these also matches a `**`-rooted glob in `target-owned.json`, which is the point:
 * the target owns its coverage floors, its agent instructions, its ignore rules and its release
 * history, and corvidae carries its own copies of the first three. The list is short because it is
 * exactly the target-owned globs that can match inside a source tree; the rest are rooted at the
 * repository or package root, where no source lives.
 */
export const nonSourceNames = [
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
  'coverage-ratchet.json',
] as const;

/** Release history, which the target generates from versions corvidae has no knowledge of. */
export const nonSourcePrefixes = ['CHANGELOG'] as const;

/** One cluster of declared files, with the single reason that puts all of them in the emission. */
export interface DeclaredSourceFiles {
  /** Workspace-relative paths, each naming one file. */
  paths: readonly string[];
  reason: string;
}

/**
 * Source a workspace declares beyond its `src/` tree, keyed by `@lostgradient/*` name.
 *
 * COR-1221 ruled that source is `src/**` plus declared inputs, and that a workspace needing more
 * declares it rather than widening the rule. This is that declaration. It exists because a second,
 * unrelated ruling — COR-1189's restore of nineteen published entry points — put shims *inside*
 * `src/` that re-export from *outside* it, so the emitted tree imports modules the emission rule
 * does not reach. `assertNoSourceEscapes` in `target-resolvability.ts` is what makes that loud;
 * this is what answers it.
 *
 * **What counts as a declarable path.** One an emitted file depends on, by either of two routes:
 * a module specifier it imports, or a literal path it reads at run time. Every entry was the first
 * kind until weft's protocol suite, which reads four documentation files with `Bun.file()` and
 * asserts on their text. Both are real edges out of `src/` — an emitted file that cannot reach
 * what it names is broken either way — but only one of them is detectable, which the last
 * paragraph is about. A path nothing emitted imports or reads is not an entry here, whatever else
 * might recommend shipping it.
 *
 * **Why files and not directories.** Every path here names one file, and the set is the transitive
 * closure of what the emitted source imports and reads, plus one type-declaration sibling that
 * TypeScript finds by name rather than by specifier and that says so in its own reason. The
 * alternatives were both worse. `components/cinder/scripts` is 236 files, which is the "emit the
 * whole workspace" fork COR-1221 ruled against wearing a different name. Declaring the containing
 * directories instead — `scripts/tokens` alone is 81 files, `packages/armorer/test` is 91 for the
 * one helper five tests import — lands at over a hundred files of fixtures, token schemas and
 * unrelated suites, chosen by where something happens to sit rather than by whether anything
 * emitted needs it.
 *
 * **Why a file root adds no prune scope.** `ownedPrefixes` is deletion authority, and a directory
 * prefix here would hand the transform the right to delete target files under directories nobody
 * has ruled on — `packages/components/scripts/` in the cinder target is the target's own. A
 * declared file is written and never pruned, which is exactly how `readDeclaredBuildInputs`
 * already treats `package-surface.json`'s build inputs.
 *
 * **Why the list is long rather than lenient.** Each entry is a real edge out of `src/`, and the
 * gate fails on any import edge that is not here. A new shim, or a new import in an existing one,
 * adds a line with a reason; it cannot pass silently, which is the whole point of the pairing.
 *
 * **What the gate cannot see.** That pairing holds for import edges only. `assertNoSourceEscapes`
 * reads module specifiers out of a TypeScript AST and a Svelte parse, so it finds every edge an
 * emitted file *imports* and no edge an emitted file *reads*: a `Bun.file('documentation/…')` is
 * a string argument to a runtime call and is invisible to it. That is why the weft documentation
 * entry below was found by the target's own test suite failing after a sync rather than by the
 * gate refusing the plan. Nothing here is broken — the gate's subject is narrower than its name —
 * but a read-by-path edge arrives only by someone noticing it, so it is worth suspecting whenever
 * an emitted test reads a fixture, a schema or a document by literal path.
 *
 * There are four kinds of edge out of the emitted set and the gate sees one. A module specifier
 * it reads; a `Bun.file()` read it cannot; a markdown link it cannot; and a validator declared in
 * `validationInputs`, which is not an edge the emitted source has at all. Each of the last three
 * was found downstream of where it was introduced — the reads by the target's test suite, the
 * links by the target's `verify-documentation.ts` one sync later — which is the system working,
 * several steps further out than anyone wants. A document declared here is declared with
 * whatever it links to.
 */
export const additionalSourceRoots: Readonly<Record<string, readonly DeclaredSourceFiles[]>> = {
  '@lostgradient/cinder': [
    {
      paths: ['components.json'],
      reason:
        '`src/index.ts` re-exports `src/exports/metadata-manifest.ts`, which imports this manifest with `with { type: "json" }`. It is reached from the package’s main entry, so without it `@lostgradient/cinder` does not compile at all.',
    },
    {
      paths: [
        'scripts/knowledge/best-practices.ts',
        'scripts/knowledge/index.ts',
        'scripts/knowledge/knowledge-artifacts.ts',
        'scripts/knowledge/knowledge-search.ts',
        'scripts/knowledge/knowledge.ts',
        'scripts/knowledge/manifest-validation.ts',
        'scripts/knowledge/output.ts',
        'scripts/knowledge/types.ts',
      ],
      reason:
        'The published surface. `src/cli/index.ts` is the `cinder` binary and `src/cli/knowledge.ts` is the `@lostgradient/cinder/knowledge` subpath `@lostgradient/cinder-mcp` consumes; both are COR-1189 restore shims re-exporting from here, and the build bundles `dist/cli/*.js` from them. The four `*.test.ts` files beside these are not declared: nothing emitted imports them.',
    },
    {
      paths: [
        'scripts/lib/discover-components.ts',
        'scripts/lib/prettier-resolution.ts',
        'scripts/lib/read-json-file.ts',
      ],
      reason:
        'Component discovery and its two helpers, imported by `src/styles/source-style-imports.test.ts` and by the declared convention and metadata scripts below.',
    },
    {
      paths: [
        'scripts/check-component-css.ts',
        'scripts/check-virtual-list-dependency-free-graph.ts',
        'scripts/check-virtual-list-dependency-free-parser.ts',
        'scripts/check-virtual-list-dependency-free-policy.ts',
        'scripts/check-virtual-list-dependency-free-test-utilities.ts',
        'scripts/component-conventions-tests.ts',
        'scripts/environment-configuration.ts',
        'scripts/generate-component-metadata.ts',
        'scripts/validation-utilities.ts',
      ],
      reason:
        'The convention and policy checks that `src/` asserts against. `src/test/css.ts` is a test helper rather than a test and imports `check-component-css.ts` for its layer name; the rest are imported by suites under `src/styles/`, `src/components/` and `src/utilities/`. Those suites ship to the mirror repository and are type-checked there even though the `files` allowlist keeps them out of the tarball.',
    },
    {
      paths: [
        'scripts/stylelint/focus-ring-helpers.mjs',
        'scripts/stylelint/focus-ring-helpers.d.mts',
      ],
      reason:
        '`src/test/focus-ring-recipe.test.ts` imports the helper. The `.d.mts` beside it is declared with it because TypeScript finds a JavaScript module’s types by that name rather than by a specifier, so emitting the module alone would resolve but not type. The rest of `scripts/stylelint/` is the stylelint plugin set, which nothing emitted imports.',
    },
    {
      paths: [
        'scripts/tokens/corpus.ts',
        'scripts/tokens/css-configuration.ts',
        'scripts/tokens/css-generator.ts',
        'scripts/tokens/css-preparation.ts',
        'scripts/tokens/css-stylelint.ts',
        'scripts/tokens/css-support.ts',
        'scripts/tokens/css-validation.ts',
        'scripts/tokens/generate.ts',
        'scripts/tokens/generator-configuration.ts',
        'scripts/tokens/load.ts',
        'scripts/tokens/registry.ts',
        'scripts/tokens/resolve.ts',
        'scripts/tokens/resolved-contexts.ts',
        'scripts/tokens/types.ts',
        'scripts/tokens/validate-corpus.ts',
        'scripts/tokens/validate-schema.ts',
        'scripts/tokens/validate.ts',
        'scripts/tokens/value-color.ts',
        'scripts/tokens/value-entry.ts',
        'scripts/tokens/value-formatters.ts',
      ],
      reason:
        '`src/styles/tokens-doc-drift.test.ts` imports `generate.ts`, and this is its module closure. The directory holds 81 files; the 61 not declared are the generator’s own fixtures, docs sections and test, which nothing emitted imports.',
    },
  ],
  '@lostgradient/weft-ui': [
    {
      paths: ['tests/dom-test-support.ts'],
      reason:
        'The DOM harness twenty-six route suites under `src/routes/` import. It is the single largest escape in the workspace and the reason weft-ui belongs in this table at all.',
    },
    {
      paths: [
        'fixtures/async-activity.ts',
        'fixtures/children.ts',
        'fixtures/coordination.ts',
        'fixtures/failures.ts',
        'fixtures/finalizer.ts',
        'fixtures/history.ts',
        'fixtures/restart-lineage.ts',
        'fixtures/reviews.ts',
        'fixtures/saga.ts',
        'fixtures/schedules.ts',
        'fixtures/tagged.ts',
        'fixtures/workflows.ts',
      ],
      reason:
        'Workflow fixtures reached from `src/routes/` through `fixtures/workflows.ts`, which re-exports the rest. `fixtures/dynamic-sources.ts`, its test and `fixtures/dynamic-workflows/` are not declared: nothing emitted imports them.',
    },
  ],
  '@lostgradient/weft': [
    {
      paths: ['README.md'],
      reason:
        "The package's published front page, shipped through its `files` array (COR-1192). `target-owned.json` has always said per-package READMEs are the transform's, but nothing emitted one, so weft's public README lived only on the target and drifted (it carried a release literal). Corvidae's copy is now that front page — no version literal in it; the manifest and `VERSION` carry the version — and it is emitted with the source it describes.",
    },
    {
      paths: ['scripts/lib/workflow-visibility-backfill.ts'],
      reason:
        'Imported by `src/core/engine/list-candidate-resolution.test.ts` and `src/storage/bun-sql-workflow-visibility-backfill.test.ts`.',
    },
    {
      paths: [
        'scripts/benchmarks/benchmark-environment.ts',
        'scripts/benchmarks/environment-configuration.ts',
      ],
      reason:
        '`src/storage/bun-sql-benchmark.test.ts` imports the first, which imports the second. The other 21 files under `scripts/benchmarks/` are the benchmark suites themselves, which nothing emitted imports. Neither path is under `packages/weft/scripts/husky/`, which `target-owned.json` reserves to the target.',
    },
    {
      paths: [
        'examples/environment-configuration.ts',
        'examples/checkout/src/index.ts',
        'examples/checkout/tests/checkout.test.ts',
        'examples/order-processing/src/activities/inventory.ts',
        'examples/order-processing/src/activities/payment.ts',
        'examples/order-processing/src/activities/shipping.ts',
        'examples/order-processing/src/client.ts',
        'examples/order-processing/src/messages.ts',
        'examples/order-processing/src/model.ts',
        'examples/order-processing/src/registry.ts',
        'examples/order-processing/src/sample-data.ts',
        'examples/order-processing/src/server.ts',
        'examples/order-processing/src/workflows/order.ts',
        'examples/order-processing/src/workflows/shipment.ts',
        'examples/order-processing/src/workflows/sweep-stale.ts',
        'examples/order-processing/tests/order-processing.test.ts',
        'examples/order-processing/tests/smoke-server.test.ts',
      ],
      reason:
        'Nothing emitted imports these (COR coverage-gate adoption’s `cmp` check against `seed-bare.git`: every file under `examples/checkout/` and `examples/order-processing/` differs from upstream’s copy except `examples/order-processing/src/sample-data.ts`, and `examples/environment-configuration.ts` — which `examples/checkout/src/index.ts` and `examples/order-processing/src/{client,server}.ts` import — does not exist upstream at all), but both example directories exist in the target too, unemitted, so a sync leaves the target holding its own stale copy beside corvidae’s. Declared here rather than left to the target so the two trees converge on corvidae’s source the way every other declared file does, and so `scripts/check-coverage.ts`’s allowance registry — which upstream keys against `examples/order-processing/**` — can be realigned against the copy that actually ships. `examples/checkout/**` is excluded from every `bun test` invocation by `[test].pathIgnorePatterns` in `bunfig.toml` (upstream carries the same exclusion), so it never appears in a coverage report and the registry has no entries for it; it is still declared so the target’s copy does not drift from corvidae’s.',
    },
    {
      paths: [
        'documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md',
        'documentation/guides/remote-task-recovery.md',
        'documentation/guides/remote-workers.md',
        'documentation/reference/api-workers.md',
        'documentation/reference/remote-worker-protocol.md',
      ],
      reason:
        '`src/worker/protocol.test.ts` reads all four by literal path with `Bun.file()` and asserts on their prose: the protocol reference’s `### `name`` headings must equal `Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS)`, and the other three must describe the protocol version `src/worker/protocol-version.ts` exports. Emitted without them, that suite reads the target’s copies while reading corvidae’s constant — and the target is three versions behind, documenting v3 under `#### ` headings, so the heading match yields an empty list and all five version assertions miss. These four are every documentation file anything emitted reads; corvidae’s weft carries eight and the target carries 156, so the other four here are declared by nothing and a `documentation/` root would claim 152 files of the target’s own. Corvidae’s copy overwrites the target’s, and for `api-workers.md` the target’s is the larger file — 37,778 bytes against 31,616 — so this is not only formatting drift a sync exists to flatten but upstream prose that the sync removes. `remote-task-recovery.md` is the fifth because the set has to be closed under links, not just under reads: nothing emitted opens it, but two of the four above link to it and the target runs `scripts/verify-documentation.ts` over local links. The target has no copy of its own — `gh api` answers 404 — so emitting four of five turned two working links into broken ones and failed that gate. Its own links reach only the three references already here plus three files under `src/`, so five closes the graph; the other three documentation files corvidae carries are linked from nothing declared.',
    },
  ],
};

/**
 * Files that check a workspace's emitted source, keyed by `@lostgradient/*` name.
 *
 * A sibling of `additionalSourceRoots`, deliberately not part of it. That table's promise is that
 * every path in it is an edge an emitted file imports or reads, and `assertNoSourceEscapes` is
 * only meaningful while that stays true; a gate script nothing imports would quietly turn the
 * promise into a description of most entries. So the two mechanisms share their behaviour —
 * written with the source, never pruned, one reason per cluster, a missing path refused rather
 * than skipped — and differ in what they claim. An entry here is not something the emitted source
 * needs in order to run. It is something that decides whether the emitted source is acceptable.
 *
 * **Why the target cannot just keep its own.** Corvidae adopted weft's gates (COR-1272), so the
 * two repositories now hold the same nine checks. `insideFiles.manifestKeys` does not include
 * `scripts`, so a sync leaves the target's `scripts` block alone and the target's CI keeps
 * invoking its own chain — against files that are, after the sync, corvidae's. Two hand-kept
 * copies of one gate drift, which is the failure the adoption was meant to close.
 *
 * **Why the data goes with the script.** Two of these gates are not pure functions of the source
 * they read: `.oxlintrc.json` carries fourteen per-file `max-lines` and `complexity` overrides,
 * and `check-implementation-file-sizes.ts` carries a registry of named files with a rationale
 * each. Both are statements about corvidae's source, and after a sync the target's `src/` is
 * corvidae's source. Emitting a gate without the list it judges against is worse than not
 * emitting it: the check runs, passes, and measures a tree that no longer exists.
 *
 * These files are emitted, not walked for imports, so a workspace that declared nothing but these
 * would not be recorded as carrying TypeScript. Nothing can reach that state — a validator with
 * no source to validate is not a workspace — and the flag means "there is emitted source worth
 * type-checking", which these files are not the evidence for.
 */
/**
 * Files whose single exported version literal the transform rewrites to the composed manifest's
 * `version`, one per workspace, target-relative to the workspace directory.
 *
 * COR-1192. A published manifest's `version` is target-owned and the transform never writes it;
 * `src/version.ts` is emitted source. Left alone, the next sync after a target bump would ship
 * corvidae's stale literal beside the bumped manifest, against the release contract that tag,
 * manifest and exported `VERSION` agree. The manifest plan already resolves the version every
 * emitted manifest carries, so the constant is derived from it at emission: parity by
 * construction, at every sync, with the target's `verify-release-version.ts` left as the tag gate.
 * The alternative measured first — `version.ts` importing `package.json` — has weft's `Bun.build`
 * inline the whole manifest object into every bundle for one string. Declared explicitly rather
 * than by filename convention, so a workspace that stores its version some other way is a visible
 * omission here rather than a silent miss.
 */
export const versionConstants: Readonly<Record<string, string>> = {
  '@lostgradient/weft': 'src/version.ts',
};

/** The one shape a declared version file may have: any leading comment, then the export. */
const versionConstantShape = /^([\s\S]*?)export const VERSION = '([^']*)';\n$/;

/**
 * Rewrite each declared version file in `files` to its package's composed version, in place.
 *
 * Returns the target-relative paths rewritten. A declared file the plan does not carry, or one
 * whose content is not exactly the documented export, is a refusal: the rewrite exists so the
 * literal can never disagree with the manifest, and a shape it cannot see through would let it.
 */
export function applyVersionConstants(
  files: Record<string, string | Uint8Array>,
  published: readonly { workspace: string; directory: string; version: string }[],
): string[] {
  const rewritten: string[] = [];
  for (const entry of published) {
    const declared = versionConstants[entry.workspace];
    if (declared === undefined) continue;
    const path = `${entry.directory}/${declared}`;
    const current = files[path];
    if (current === undefined) {
      throw new SourceEmissionError(
        `${entry.workspace} declares ${declared} as its version constant in versionConstants, but the plan emits no ${path}`,
      );
    }
    const text = typeof current === 'string' ? current : new TextDecoder().decode(current);
    const match = versionConstantShape.exec(text);
    if (!match) {
      throw new SourceEmissionError(
        `${entry.workspace}'s ${path} is declared as a version constant but is not shaped as \`export const VERSION = '<version>';\` after an optional comment; the transform refuses to guess where the version lives`,
      );
    }
    const next = `${match[1]}export const VERSION = '${entry.version}';\n`;
    files[path] = typeof current === 'string' ? next : new TextEncoder().encode(next);
    rewritten.push(path);
  }
  return rewritten.toSorted();
}

export const validationInputs: Readonly<Record<string, readonly DeclaredSourceFiles[]>> = {
  '@lostgradient/weft': [
    // Under COR-1286's demotion the target runs no lint, coverage or documentation gate of its own
    // — those run in corvidae alone — so the nine `check-*.ts` gates, `check-coverage.ts` with its
    // test and `bunfig.toml`, the benchmark environment test and the allowlists they judged against
    // are no longer emitted. `target-owned.json` retires the target's copies instead.
    {
      paths: [
        'scripts/generate-operation-client.test.ts',
        'scripts/generate-operation-client.ts',
        'scripts/operation-client-aliases.test.ts',
        'scripts/operation-client-aliases.ts',
        'scripts/operation-client-catalog.test.ts',
        'scripts/operation-client-domains.test.ts',
        'scripts/operation-client-domains.ts',
        'scripts/operation-client-schema.test.ts',
        'scripts/operation-client-schema.ts',
        'scripts/operation-client-test-support.ts',
        'scripts/operation-client-test-support.test.ts',
      ],
      reason:
        "The generator that produces `src/client/generated/operation-client.generated.ts`, which is already emitted under `src/`, and therefore the check that the committed file still matches its inputs. It goes as a set or not at all: the target has only the first two, in a diverged singular-API form, and `generate-operation-client.ts` imports `operation-client-aliases.ts`, `operation-client-schema.ts` and the rest of this list, so emitting the entry point alone would land a script that cannot resolve its own imports. `operation-client-test-support.test.ts` (COR coverage-gate adoption) is the odd one out — nothing emitted imports it either, same as the benchmark case above — it exists solely to unit-test `snapshotTestOperation`'s invoke handler, which no other consumer of this test-support module ever calls; without declaring it the target's copy has no accompanying test and the coverage gate fails against the emitted tree even though it passes against corvidae's. Its only imports are `bun:test`, the already-declared `operation-client-test-support.ts`, and the already-emitted `../src/server/principal.ts`.",
    },
  ],
};

/**
 * Directory names never walked. An installed dependency tree is not source and cannot be, so a
 * stray one inside `src/` is skipped rather than mirrored a thousand files at a time.
 */
const skippedDirectories: readonly string[] = ['node_modules'];

/** Whether a file is source, judged by its name alone. */
export function isSourceFile(name: string): boolean {
  if ((nonSourceNames as readonly string[]).includes(name)) return false;
  return !nonSourcePrefixes.some((prefix) => name.startsWith(prefix));
}

export interface SourcePlan {
  /** Target-relative path to file contents. */
  files: Record<string, Uint8Array>;
  /** Target-relative paths whose corvidae counterpart is executable. */
  executable: string[];
  /**
   * Target-relative directory prefixes the transform owns, one per emitted workspace. Everything
   * beneath one of these is the transform's to write and to prune; everything outside is not.
   */
  ownedPrefixes: string[];
  /** Workspaces whose emitted source includes TypeScript, which is what makes a typecheck meaningful. */
  typeScriptWorkspaces: string[];
}

/**
 * Every source file beneath one directory, as `{ absolute, relative }` pairs in a stable order.
 *
 * One walker for both directions: the corvidae tree it emits and the target tree it prunes have
 * to agree on what a source file is, or a file would be written on one run and deleted on the
 * next. A directory that does not exist yields nothing, which is how a workspace with no `src/`
 * and a target that has not received one yet both read.
 */
async function walkSourceFiles(root: string): Promise<{ absolute: string; relative: string }[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      // Only "there is no such directory" is an empty tree. Any other failure — a permission
      // error, an I/O error — must not read as one: on the corvidae side it would plan zero
      // source for a workspace, and the prune would then delete the target's whole source tree
      // for exactly the reason a deletion must never be computed from a read that failed.
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: { absolute: string; relative: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isSourceFile(entry.name)) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relativeTo(root, absolute);
    if (path.split('/').some((segment) => skippedDirectories.includes(segment))) continue;
    files.push({ absolute, relative: path });
  }
  return files.toSorted((left, right) => left.relative.localeCompare(right.relative));
}

function relativeTo(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * Read one workspace's source tree, or nothing when the workspace has none.
 *
 * Every `tsconfig*.json` under the tree is left to `typescript-configuration.ts`, which is the
 * only producer that knows what an `extends` into `@lostgradient/typescript` becomes in this target —
 * a public specifier where the target holds the package, a relative path into a vendored copy
 * where it cannot. Emitting them here as opaque bytes is what shipped
 * `src/cli/__fixtures__/codegen/typecheck/tsconfig.json` still extending a package name that
 * exists nowhere downstream. The skip is here rather than in `isSourceFile` on purpose:
 * `collectPrunablePaths` shares that predicate, and a tsconfig the target keeps after corvidae
 * drops it still has to be prunable.
 */
async function readSourceTree(
  corvidaeRoot: string,
  workspace: EmittedWorkspace,
  plan: SourcePlan,
  targetDirectory: string | undefined,
): Promise<boolean> {
  const root = join(corvidaeRoot, workspace.corvidaeDirectory, sourceTree);
  let carriesTypeScript = false;
  for (const { absolute, relative: path } of await walkSourceFiles(root)) {
    if (isTypeScriptConfiguration(path)) continue;
    const target = `${workspace.targetDirectory}/${sourceTree}/${path}`;
    await readInto(plan, absolute, target, targetDirectory);
    if (path.endsWith('.ts') || path.endsWith('.tsx')) carriesTypeScript = true;
  }
  return carriesTypeScript;
}

/**
 * Read one file into the plan, formatted for the target, and record the executable bit.
 *
 * One funnel every emitted source file passes through — the `src/` tree, the declared roots and
 * the declared build inputs alike — because every one of them has to agree with the target's
 * formatter and preserve the same executable bit, whichever of them read it.
 *
 * The executable bit is preserved because corvidae's two `bin` entry points are executable in the
 * source tree, and a write path that dropped the mode would publish a binary nothing can run.
 */
async function readInto(
  plan: SourcePlan,
  absolute: string,
  path: string,
  targetDirectory: string | undefined,
): Promise<void> {
  const contents = new Uint8Array(await Bun.file(absolute).arrayBuffer());
  plan.files[path] = await formatEmittedFile(contents, targetDirectory, path);
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o111) !== 0) plan.executable.push(path);
}

/**
 * Every file a workspace declares beyond its `src/` tree.
 *
 * A declared path that corvidae does not carry is a refusal rather than a skip, which is the one
 * place this differs from `readDeclaredBuildInputs`: a build input corvidae lacks is target-owned
 * by definition, whereas a declared source file corvidae lacks means the declaration has gone
 * stale against a file that moved or was deleted, and the escape it was written to close is back.
 */
async function readAdditionalSourceRoots(
  corvidaeRoot: string,
  workspace: EmittedWorkspace,
  plan: SourcePlan,
  targetDirectory: string | undefined,
): Promise<boolean> {
  let carriesTypeScript = false;
  for (const declared of additionalSourceRoots[workspace.workspace] ?? []) {
    for (const path of declared.paths) {
      const absolute = join(corvidaeRoot, workspace.corvidaeDirectory, path);
      if (!(await Bun.file(absolute).exists())) {
        throw new SourceEmissionError(
          `${workspace.workspace} declares ${path} as source beyond its ${sourceTree}/ tree, but corvidae has no file there. Either restore it or remove the declaration from additionalSourceRoots in source.ts.`,
        );
      }
      await readInto(plan, absolute, `${workspace.targetDirectory}/${path}`, targetDirectory);
      if (path.endsWith('.ts') || path.endsWith('.tsx')) carriesTypeScript = true;
    }
  }
  return carriesTypeScript;
}

/**
 * Every file a workspace declares as a check on its emitted source.
 *
 * A missing path is refused for the same reason `readAdditionalSourceRoots` refuses one, and it
 * matters more here: a typo in one of twenty-six paths would otherwise emit twenty-five gates and
 * a target whose lint chain invokes a script that was never written.
 */
async function readValidationInputs(
  corvidaeRoot: string,
  workspace: EmittedWorkspace,
  plan: SourcePlan,
  targetDirectory: string | undefined,
): Promise<void> {
  for (const declared of validationInputs[workspace.workspace] ?? []) {
    for (const path of declared.paths) {
      const absolute = join(corvidaeRoot, workspace.corvidaeDirectory, path);
      if (!(await Bun.file(absolute).exists())) {
        throw new SourceEmissionError(
          `${workspace.workspace} declares ${path} as a check on its emitted source, but corvidae has no file there. Either restore it or remove the declaration from validationInputs in source.ts.`,
        );
      }
      await readInto(plan, absolute, `${workspace.targetDirectory}/${path}`, targetDirectory);
    }
  }
}

/** Every build input the surface declares that corvidae actually carries, emitted with the source. */
async function readDeclaredBuildInputs(
  corvidaeRoot: string,
  workspace: EmittedWorkspace,
  plan: SourcePlan,
  targetDirectory: string | undefined,
): Promise<void> {
  for (const input of workspace.entry?.build.requiredInputs ?? []) {
    const absolute = join(corvidaeRoot, workspace.corvidaeDirectory, input);
    const file = Bun.file(absolute);
    if (!(await file.exists())) continue;
    await readInto(plan, absolute, `${workspace.targetDirectory}/${input}`, targetDirectory);
  }
}

/**
 * Plan every emitted workspace's source at its target path.
 *
 * `ownedPrefixes` is the same list the prune reads, so what the transform writes and what it is
 * allowed to delete are one decision rather than two that can drift.
 */
export async function planSource(
  corvidaeRoot: string,
  emitted: readonly EmittedWorkspace[],
  targetDirectory?: string,
): Promise<SourcePlan> {
  const plan: SourcePlan = {
    files: {},
    executable: [],
    ownedPrefixes: [],
    typeScriptWorkspaces: [],
  };
  for (const workspace of emitted) {
    plan.ownedPrefixes.push(`${workspace.targetDirectory}/${sourceTree}`);
    const inTree = await readSourceTree(corvidaeRoot, workspace, plan, targetDirectory);
    const declared = await readAdditionalSourceRoots(
      corvidaeRoot,
      workspace,
      plan,
      targetDirectory,
    );
    if (inTree || declared) plan.typeScriptWorkspaces.push(workspace.workspace);
    await readValidationInputs(corvidaeRoot, workspace, plan, targetDirectory);
    await readDeclaredBuildInputs(corvidaeRoot, workspace, plan, targetDirectory);
  }
  plan.ownedPrefixes.sort();
  plan.executable.sort();
  plan.typeScriptWorkspaces.sort();
  return plan;
}

/**
 * Target files beneath a prefix the transform owns that this plan does not emit.
 *
 * This is the whole of what a sync deletes. A path outside every owned prefix is either the
 * target's own — its build scripts, its release notes, a working document nobody enumerated — or
 * something no one has ruled on, and both are left exactly as they are. The non-source filter is
 * applied here too, so a target that keeps its own `AGENTS.md` inside a source tree keeps it.
 */
export async function collectPrunablePaths(
  directory: string,
  plan: Pick<SourcePlan, 'ownedPrefixes'>,
  emittedPaths: Iterable<string>,
): Promise<string[]> {
  const emitted = new Set(emittedPaths);
  const prunable: string[] = [];
  for (const prefix of plan.ownedPrefixes) {
    for (const { relative: path } of await walkSourceFiles(join(directory, prefix))) {
      const target = `${prefix}/${path}`;
      if (!emitted.has(target)) prunable.push(target);
    }
  }
  return prunable.toSorted();
}

/** One producer's claim on a set of plan keys. */
export interface PlanOwnership {
  owner: string;
  paths: Iterable<string>;
}

/**
 * Refuse a plan whose keys are claimed by two producers.
 *
 * `planSurface` merges three file sets — the manifests, the TypeScript configuration and now the
 * source — with object spread, where the last writer wins and says nothing. Every one of them
 * emits paths under the same workspace directory, so a collision is a real possibility rather
 * than a theoretical one, and its symptom downstream would be a file that is silently the wrong
 * half of the transform.
 */
export function assertSingleOwner(claims: readonly PlanOwnership[]): void {
  const owners = new Map<string, string>();
  const conflicts: string[] = [];
  for (const claim of claims) {
    for (const path of claim.paths) {
      const previous = owners.get(path);
      if (previous !== undefined) {
        conflicts.push(`${path}: claimed by ${previous} and ${claim.owner}`);
        continue;
      }
      owners.set(path, claim.owner);
    }
  }
  if (conflicts.length > 0) {
    throw new SourceEmissionError(
      `Two halves of the transform claim the same plan key:\n${conflicts.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}
