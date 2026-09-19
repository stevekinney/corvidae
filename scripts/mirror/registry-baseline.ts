import { z } from 'zod';

/**
 * Surface parity: every subpath the last published version exported must still be exported after
 * a sync. A removal is a broken import for somebody — `conversationalist` alone is installed
 * roughly 53,608 times a month — so a missing key fails the run rather than being reported.
 *
 * Additions pass. The gate is a superset check, not an equality check, because a sync that adds a
 * component legitimately adds subpaths.
 *
 * The baseline it compares against is committed rather than fetched. See
 * `refresh-registry-baseline.ts` for why, and for the command that updates it.
 */

export const baselineFile = new URL('./registry-baseline.json', import.meta.url);

const baselineEntrySchema = z.object({
  /** The corvidae workspace this published name belongs to. */
  workspace: z.string().min(1),
  version: z.string().min(1),
  fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fetchedAt must be an ISO calendar date'),
  subpaths: z.array(z.string().min(1)),
});

const baselineSchema = z.object({
  documentation: z.string().min(1),
  source: z.string().min(1),
  packages: z.record(z.string().min(1), baselineEntrySchema),
});

export type RegistryBaseline = z.infer<typeof baselineSchema>;
export type RegistryBaselineEntry = z.infer<typeof baselineEntrySchema>;

export class RegistryBaselineError extends Error {}

export async function loadRegistryBaseline(
  source: URL | string = baselineFile,
): Promise<RegistryBaseline> {
  const parsed = baselineSchema.safeParse(await Bun.file(source).json());
  if (!parsed.success) {
    throw new RegistryBaselineError(
      `registry-baseline.json is malformed:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export interface ParityResult {
  publicName: string;
  /** `undefined` when the package has no published predecessor, which is a first publish. */
  baselineVersion: string | undefined;
  /** Published subpaths the emitted map no longer carries. Non-empty means the gate fails. */
  missing: string[];
  /** Subpaths the emitted map adds. Always allowed; reported so a sync is legible. */
  added: string[];
}

export function isFirstPublish(result: ParityResult): boolean {
  return result.baselineVersion === undefined;
}

/** Compare one emitted exports map against the baseline. A missing predecessor is a first publish. */
export function checkParity(
  baseline: RegistryBaseline,
  publicName: string,
  emitted: Readonly<Record<string, unknown>>,
): ParityResult {
  const entry = baseline.packages[publicName];
  const emittedKeys = Object.keys(emitted);
  if (entry === undefined) {
    return { publicName, baselineVersion: undefined, missing: [], added: emittedKeys.toSorted() };
  }
  return {
    publicName,
    baselineVersion: entry.version,
    missing: entry.subpaths.filter((subpath) => !emittedKeys.includes(subpath)),
    added: emittedKeys.filter((subpath) => !entry.subpaths.includes(subpath)).toSorted(),
  };
}

/** One line per package, failures first, suitable for a sync log or a test failure message. */
export function describeParity(results: readonly ParityResult[]): string {
  return results
    .map((result) => {
      if (result.missing.length > 0) {
        return `FAIL ${result.publicName}: ${result.missing.length} published subpath(s) missing — ${result.missing.join(', ')}`;
      }
      if (isFirstPublish(result)) {
        return `first publish ${result.publicName}: no published predecessor, ${result.added.length} subpath(s) proposed`;
      }
      return `ok ${result.publicName} (${result.baselineVersion}): ${result.added.length} added`;
    })
    .join('\n');
}

/** Throws when any package lost a published subpath. */
export function assertParity(results: readonly ParityResult[]): void {
  const failures = results.filter((result) => result.missing.length > 0);
  if (failures.length === 0) return;
  throw new RegistryBaselineError(
    `The emitted exports maps drop published subpaths:\n${describeParity(failures)}`,
  );
}
