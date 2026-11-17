/**
 * How Bureau starts an owner-defined file catalog (COR-2119 validators, COR-2120 guardrails): the
 * source is checked, the catalog is built over it and scanned once so a name an agent or goal uses is
 * known on first use, and a later change is reported as `definitions.changed` after that scan. Both
 * catalogs start the same way, so the steps live here and `create-bureau.ts` names each once.
 *
 * @module owner-file-startup
 */

import type { DefinitionChange } from './definition-scanner';
import { DefinitionsChangedEvent, type DefinitionCatalogKind } from './events';
import { forwardDefinitionChanges } from './bureau-event-forwarders';
import { validateOwnerFileSource } from './sources/validate-definition-source';

/** What a started catalog must offer: a first scan and an end. */
interface StartableCatalog {
  refresh(): Promise<unknown>;
  close(): unknown;
  onChange(listener: (change: DefinitionChange) => void): () => void;
}

/**
 * Builds the catalog `create` makes over `source` (nothing when the host gave no source), hands it to
 * `onCreated`, and scans it once. A source that is not the `kind` it was given as is refused through `badRequest`. The
 * catalog's `close` is pushed to `stopForwarding`, which the Bureau runs on dispose.
 */
export async function openOwnerFileCatalog<Source, Catalog extends StartableCatalog>(input: {
  readonly option: 'validatorSource' | 'guardrailSource';
  readonly kind: 'validator' | 'guardrail';
  readonly source: Source | undefined;
  readonly badRequest: (message: string) => never;
  readonly create: (source: Source) => Catalog;
  readonly stopForwarding: Array<() => void>;
  /**
   * Called with the catalog as soon as it exists, before its first scan, so what reads the catalog
   * while that scan runs (a model catalog that is replaced, a change that revalidates the agents)
   * finds it, as it did when this was written inline.
   */
  readonly onCreated: (catalog: Catalog) => void;
  /** Runs after each change, once the first scan is done. */
  readonly onChange?: () => void;
}): Promise<void> {
  if (input.source === undefined) return;
  validateOwnerFileSource(input.option, input.kind, input.source, input.badRequest);
  const catalog = input.create(input.source);
  input.onCreated(catalog);
  // Returned, not dropped: a Bureau that fails to construct waits for the watcher to close.
  input.stopForwarding.push(() => catalog.close());
  await catalog.refresh();
  const onChange = input.onChange;
  if (onChange !== undefined) input.stopForwarding.push(catalog.onChange(() => onChange()));
}

/** Reports `catalog`'s changes as `definitions.changed` of `kind`; no catalog, nothing to report. */
export function forwardOwnerFileChanges(
  kind: DefinitionCatalogKind,
  catalog: Parameters<typeof forwardDefinitionChanges>[1] | undefined,
  dispatch: (event: DefinitionsChangedEvent) => void,
): () => void {
  return catalog === undefined ? () => {} : forwardDefinitionChanges(kind, catalog, dispatch);
}
