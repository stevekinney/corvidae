/**
 * How Settings › General arranges the Bureau's settings (board SettingsShell, "General, /settings"):
 * Tools, Runs, Memory, then Storage, or in remote mode the "Remote deployment" card that holds what
 * the deployment owns. The Advanced disclosure follows those installation sections. The page is drawn
 * from the schema, so a key the Bureau adds lands in Advanced with no change here; only the order of
 * the two visible Runs rows is the page's.
 *
 * "Engine" is not a name the interface shows, so every key that is not one of the two drawn tools
 * sits under Advanced. The
 * retention windows belong to Data and retention, the decision model to Models and the A2A
 * settings to A2A (`inSection`).
 */
import { inSection } from './settings-controls.ts';

/** The sections of the General page that hold the Bureau's settings, in the order they are drawn. */
export type GeneralSectionId = 'tools' | 'runs' | 'memory' | 'storage' | 'remote' | 'advanced';

/** One section: the settings under its heading, in order. `storage` and `remote` also hold the backend row. */
export interface GeneralSection {
  readonly id: GeneralSectionId;
  readonly keys: readonly string[];
}

/**
 * The tool settings Tools lists: the two the board draws (47e). Any other `tools.*` key the Bureau
 * publishes is not drawn, so it follows the designed rows under Advanced, like every undrawn key.
 */
const TOOLS_DRAWN: readonly string[] = ['tools.humanInput', 'tools.wakeup'];

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
  const tools = TOOLS_DRAWN.filter((key) => own.includes(key));
  // Memory holds every `memory.*` setting, which Runs would otherwise absorb as an undrawn key.
  const memory = own.filter((key) => key.startsWith('memory.'));
  const rest = own.filter((key) => !tools.includes(key) && !memory.includes(key));
  const first = RUNS_FIRST.filter((key) => rest.includes(key));
  const advanced = rest.filter((key) => !first.includes(key));
  const sections: GeneralSection[] = [];
  if (tools.length > 0) sections.push({ id: 'tools', keys: tools });
  if (first.length > 0) sections.push({ id: 'runs', keys: first });
  if (memory.length > 0) sections.push({ id: 'memory', keys: memory });
  sections.push(remote ? { id: 'remote', keys: owned } : { id: 'storage', keys: [] });
  if (advanced.length > 0) sections.push({ id: 'advanced', keys: advanced });
  return sections;
}
