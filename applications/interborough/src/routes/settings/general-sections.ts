/**
 * How Settings › General arranges the Bureau's settings (board SettingsShell, "General · /settings"):
 * Tools, Runs, then Storage, or in remote mode the "Remote deployment" card that holds what the
 * deployment owns. The page is drawn from the schema, so a key the Bureau adds lands in a section
 * with no change here; only the order of the first rows of Runs is the page's.
 *
 * "Engine" is not a name the interface shows, so every key that is not a tool sits under Runs. The
 * retention windows belong to Data and retention, the decision model to Models and the A2A
 * settings to A2A (`inSection`).
 */
import { groupOf, inSection } from './settings-controls.ts';

/** The sections of the General page that hold the Bureau's settings, in the order they are drawn. */
export type GeneralSectionId = 'tools' | 'runs' | 'storage' | 'remote';

/** One section: the settings under its heading, in order. `storage` and `remote` also hold the backend row. */
export interface GeneralSection {
  readonly id: GeneralSectionId;
  readonly keys: readonly string[];
}

/** The settings Runs lists first, in this order: the two a person changes to tune how runs execute. */
const RUNS_FIRST: readonly string[] = [
  'engine.workflowClaimRenewInterval',
  'engine.maxConcurrentRuns',
];

/**
 * The sections for the keys the Bureau publishes. In remote mode the settings the deployment locks
 * move into the Remote deployment card; locally a locked setting stays in its section and says so.
 */
export function generalSections(
  keys: readonly string[],
  locked: (key: string) => boolean,
  remote: boolean,
): readonly GeneralSection[] {
  const general = keys.filter((key) => inSection(key, 'general'));
  const owned = remote ? general.filter(locked) : [];
  const own = remote ? general.filter((key) => !locked(key)) : general;
  const tools = own.filter((key) => groupOf(key) === 'tools');
  const rest = own.filter((key) => groupOf(key) !== 'tools');
  const first = RUNS_FIRST.filter((key) => rest.includes(key));
  const runs = [...first, ...rest.filter((key) => !first.includes(key))];
  const sections: GeneralSection[] = [];
  if (tools.length > 0) sections.push({ id: 'tools', keys: tools });
  if (runs.length > 0) sections.push({ id: 'runs', keys: runs });
  sections.push(remote ? { id: 'remote', keys: owned } : { id: 'storage', keys: [] });
  return sections;
}
