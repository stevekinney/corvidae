/**
 * Dynamic workflow source fixtures for the end-to-end host (WFT-116). Registers
 * `invoice-reconciliation` as a `registerSource()` workflow at two revisions,
 * so the engine holds a source that has no workflow file. The Workflows list
 * leaves such a source out (`tests/e2e/26-workflows.spec.ts` asserts it), and
 * this is the real engine-only source that assertion is made against. The
 * revisions are chosen to leave the engine in two different load states:
 *
 * - `DYNAMIC_SOURCE_LOADABLE_REVISION` — a real, loadable module. Registered
 *   and never loaded, so it starts `idle` with no load duration; a preload
 *   turns it `ready` and installs it durably. Nothing here preloads it.
 * - `DYNAMIC_SOURCE_FAILING_REVISION` — its loader rejects, so preloading it
 *   produces the bounded `Conflict` + `reason: 'load-failed'` refusal and
 *   leaves `state: 'failed'` with a `lastFailureCategory` behind. Weft
 *   deliberately never forwards a loader's own message onto the wire
 *   (`preload-workflow-revision.ts`'s own catch says why), so that category
 *   is the only classified account of the failure.
 *
 * `weft.system.registry` is built from `internals.registrations`, which a
 * dynamic source never enters — not even after a preload installs a revision
 * durably. `invoice-reconciliation` is therefore reached only through
 * `weft.catalog.sources.list` and the exact `(name, revision)` diagnostics
 * and preload calls.
 */
import { workflowSource, type WorkflowSourceHandle } from '@lostgradient/weft';

/** The one dynamic workflow name in the dev harness — never eagerly registered. */
export const DYNAMIC_SOURCE_WORKFLOW_NAME = 'invoice-reconciliation';

/**
 * The content-derived revision of `dynamic-workflows/invoice-reconciliation.ts`.
 * Pinned by `dynamic-sources.test.ts` against a real engine — if that test
 * fails, the module changed and this constant needs the new value it reports,
 * not a retry.
 */
export const DYNAMIC_SOURCE_LOADABLE_REVISION =
  'sha256:b11d3fa030a2d8af8e85e3d83ec246d5e4c68cdf5643803d4aca12c4b23c264b';

/**
 * Registered with a loader that rejects. Its label is arbitrary precisely
 * because the load fails before any revision comparison can happen — there
 * is no module content for it to have to match.
 */
export const DYNAMIC_SOURCE_FAILING_REVISION = 'invoice-reconciliation-unreachable';

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern this file follows. */
export interface DynamicSourcesEngine {
  registerSource(source: WorkflowSourceHandle): void;
}

/** See this module's doc on WFT-166 for why the namespace is spread rather than returned directly. */
async function loadInvoiceReconciliation(): Promise<Record<string, unknown>> {
  return { ...(await import('./dynamic-workflows/invoice-reconciliation.ts')) };
}

/**
 * A loader that always rejects, standing in for the real-world cases the
 * bounded `load-failed` classification exists for: an artifact that isn't
 * there, a network-mounted module that can't be read, an import that throws
 * at evaluation time. The message deliberately looks like one carrying a
 * filesystem path, so it is visible in review that the wire response never
 * repeats it.
 */
function loadUnreachableModule(): Promise<Record<string, unknown>> {
  return Promise.reject(
    new Error("ENOENT: no such file or directory, open '/srv/artifacts/invoice-unreachable.js'"),
  );
}

/**
 * Registers both source revisions. Loads neither: every revision starts
 * `idle`. The load state is read back through `weft.catalog.diagnostics`,
 * never from this module.
 */
export function seedDynamicSources(engine: DynamicSourcesEngine): void {
  engine.registerSource(
    workflowSource(
      {
        name: DYNAMIC_SOURCE_WORKFLOW_NAME,
        location: './dynamic-workflows/invoice-reconciliation.ts',
        exportName: 'invoiceReconciliation',
        revision: DYNAMIC_SOURCE_LOADABLE_REVISION,
      },
      loadInvoiceReconciliation,
    ),
  );
  engine.registerSource(
    workflowSource(
      {
        name: DYNAMIC_SOURCE_WORKFLOW_NAME,
        location: './dynamic-workflows/invoice-unreachable.ts',
        exportName: 'invoiceReconciliation',
        revision: DYNAMIC_SOURCE_FAILING_REVISION,
      },
      loadUnreachableModule,
    ),
  );
}
