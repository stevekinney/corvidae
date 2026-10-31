/**
 * COR-1874 — the activities and trigger kinds a Bureau's workflow files can name beyond the
 * `agent` activity and the `schedule` and `signal` triggers. They come from the versioned catalog
 * (`versioned-catalog.ts`), under the kinds `activity` and `trigger-kind`, as `plugin:name`.
 *
 * ## Files float, records pin
 *
 * A workflow file names a contributed activity as `plugin:name`, with no version, so a plugin that
 * is upgraded changes what the file runs. A revision does not float: Bureau writes the version of
 * every contributed activity the file uses into the document it registers
 * (`WorkflowDocument.activityVersions`), so the revision's identity includes it. A run keeps the
 * revision it started on, and after a restart it resumes only if exactly that version is loaded;
 * otherwise it is reported `missing` or `version-mismatch` and never run on another version.
 *
 * A trigger kind is not pinned: it binds a file to a source of starts, not a run to code. A run
 * that has started does not need its trigger kind, so a revision whose trigger kind is gone still
 * resumes its runs.
 *
 * @module workflow-contributions
 */

import type { PluginActivity, PluginTriggerKind } from '@lostgradient/interborough-plugin';
import type { DocumentActivity, DocumentTriggerValidator } from '@lostgradient/weft';

import { isNamespacedIdentifier, toWeftName } from './namespaced-identifier';
import type {
  VersionedCatalog,
  VersionedCatalogEntry,
  VersionedCatalogResolution,
} from './versioned-catalog';

/** What the workflow host takes from the catalog. */
export interface WorkflowContributions {
  /**
   * The contributed activities as document activities, by the Weft name of their `plugin:name`.
   * Each keeps every setting its definition declares (retry, timeout, verifier and the rest), so
   * Weft runs a step as the plugin said the activity runs.
   */
  readonly activities: Readonly<Record<string, DocumentActivity>>;
  /** The version each contributed activity is loaded at, by the Weft name of its `plugin:name`. */
  readonly activityVersions: Readonly<Record<string, string>>;
  /** A validator for each contributed trigger kind, by its `plugin:name`. */
  readonly triggerValidators: Readonly<Record<string, DocumentTriggerValidator>>;
  /** The contributed trigger kinds, by their `plugin:name`. */
  readonly triggerKinds: ReadonlyMap<string, VersionedCatalogEntry<PluginTriggerKind>>;
  /**
   * The exact contributed activity `id` (`plugin:name`) at `version`: the entry, or `missing`
   * when no version of it is loaded and `version-mismatch` when only others are.
   */
  resolveActivity(id: string, version: string): VersionedCatalogResolution<PluginActivity>;
}

/** No contributions: the host a Bureau without plugins has. */
export const NO_WORKFLOW_CONTRIBUTIONS: WorkflowContributions = Object.freeze({
  activities: Object.freeze({}),
  activityVersions: Object.freeze({}),
  triggerValidators: Object.freeze({}),
  triggerKinds: new Map(),
  resolveActivity: (id: string, version: string): VersionedCatalogResolution<PluginActivity> => ({
    ok: false,
    reason: 'missing',
    kind: 'activity',
    requested: Object.freeze({ name: id, version }),
    availableVersions: [],
  }),
});

/** The one entry of each name, or a `TypeError` naming a name that is loaded at two versions. */
function onePerName<TValue>(
  entries: readonly VersionedCatalogEntry<unknown>[],
  label: string,
): VersionedCatalogEntry<TValue>[] {
  const byName = new Map<string, VersionedCatalogEntry<TValue>>();
  for (const entry of entries as VersionedCatalogEntry<TValue>[]) {
    if (!isNamespacedIdentifier(entry.name)) {
      throw new TypeError(
        `The ${label} "${entry.name}" is not a plugin:name identifier, so a workflow file cannot name it.`,
      );
    }
    const known = byName.get(entry.name);
    if (known !== undefined) {
      throw new TypeError(
        `The ${label} "${entry.name}" is loaded at versions ${known.version} and ${entry.version}; a workflow file names it without a version, so one version must be loaded.`,
      );
    }
    byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

function configurationProblem(
  kind: PluginTriggerKind,
  trigger: Record<string, unknown>,
): string | undefined {
  const { kind: _kind, ...configuration } = trigger;
  const parsed = kind.configuration.safeParse(configuration);
  if (parsed.success) return undefined;
  const issues = parsed.error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `"${issue.path.join('.')}": ${issue.message}`,
  );
  return `the "${trigger['kind'] as string}" trigger is not valid: ${issues.join('; ')}`;
}

/**
 * The contributions `catalog` holds. A name loaded at two versions, or one that is not a
 * `plugin:name` identifier, is a `TypeError`: it is a startup error, as a validator registered
 * twice is.
 */
export function createWorkflowContributions(
  catalog: VersionedCatalog | undefined,
): WorkflowContributions {
  if (catalog === undefined) return NO_WORKFLOW_CONTRIBUTIONS;
  const activityEntries = onePerName<PluginActivity>(catalog.entries('activity'), 'activity');
  const triggerEntries = onePerName<PluginTriggerKind>(
    catalog.entries('trigger-kind'),
    'trigger kind',
  );
  for (const entry of activityEntries) {
    if (typeof entry.value?.execute !== 'function') {
      throw new TypeError(`The activity "${entry.name}" has no execute function.`);
    }
  }
  for (const entry of triggerEntries) {
    const kind = entry.value;
    if (typeof kind?.start !== 'function' || typeof kind.configuration?.safeParse !== 'function') {
      throw new TypeError(
        `The trigger kind "${entry.name}" needs a configuration schema and a start function.`,
      );
    }
  }
  const activities: Record<string, DocumentActivity> = {};
  const activityVersions: Record<string, string> = {};
  for (const entry of activityEntries) {
    const weftName = toWeftName(entry.name);
    // Everything the definition declares but its identity: the name is the registered key and the
    // version is pinned by the document, so neither is Weft's to read from the activity.
    const { name: _name, version: _version, execute: _execute, ...settings } = entry.value;
    activities[weftName] = {
      ...settings,
      execute: (argument, context) => entry.value.execute(argument, context),
    };
    activityVersions[weftName] = entry.version;
  }
  const triggerValidators: Record<string, DocumentTriggerValidator> = {};
  const triggerKinds = new Map<string, VersionedCatalogEntry<PluginTriggerKind>>();
  for (const entry of triggerEntries) {
    triggerKinds.set(entry.name, entry);
    triggerValidators[entry.name] = (trigger) => configurationProblem(entry.value, trigger);
  }
  return Object.freeze({
    activities: Object.freeze(activities),
    activityVersions: Object.freeze(activityVersions),
    triggerValidators: Object.freeze(triggerValidators),
    triggerKinds,
    resolveActivity: (id: string, version: string) =>
      catalog.resolve('activity', {
        name: id,
        version,
      }) as VersionedCatalogResolution<PluginActivity>,
  });
}
