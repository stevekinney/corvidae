/**
 * What the Settings tab shows and writes of an agent (board PageAgent, rows 38u to 39b, 39s).
 *
 * An agent defined in code is shown read-only (`settingsOf`): its model and the models a chat may be
 * switched to. An agent file the owner keeps is a form (`SettingsForm`): the model, the models a
 * chat may change to, the effort a chat starts at, and the step limit. A step limit left empty is
 * the default Operative applies (`DEFAULT_STEP_LIMIT`), never no limit: a run whose agent sets none
 * still stops at that default.
 *
 * A save sends a whole definition (`settingsDefinition`), because `bureau.agents.definitions.update`
 * removes `tools` and `models` when they are left out. The keys the tab does not edit are carried
 * back as the file has them, as the editor carries them (`skills`, `children`, `guardrails`,
 * `approvals`, `retry`, `compaction` and `interceptors`), or left out where leaving them out keeps
 * the file's (the spend and tool limits, and `references`).
 *
 * The rest words the versions list and the delete question: what each version changed
 * (`versionChanges`), the changes a restore removes (`restoredChanges`), and what stops finding an
 * agent once it is deleted (`dependentsLine`).
 */
import { AGENT_PAGE_COPY, EFFORT_LABELS } from '../../app/copy.ts';
import {
  EFFORTS,
  type AgentDefinitionInput,
  type AgentDetail,
  type AgentReferences,
  type AgentVersion,
  type Effort,
} from '../../lib/agent-definitions.ts';
import { parseLimit } from '../agent-editor/agent-editor-state.svelte.ts';
import { modelDisplayName, providerDisplayName } from '../settings/models/format-model.ts';
import { humanizeName } from '../settings/plugins/plugin-presentation.ts';

/** The settings of one agent, each already worded or `null` when the file sets none. */
export interface AgentSettingsView {
  readonly model: string | null;
  readonly models: readonly string[];
  readonly stepLimit: string | null;
  readonly effort: string | null;
}

/** The settings of `detail`: the file's for an agent with one, the agent's own statement for one in code. */
export function settingsOf(detail: AgentDetail): AgentSettingsView {
  const definition = detail.definition;
  if (detail.source !== 'file' || definition === null) {
    return {
      model: detail.codeDefinition?.model ?? null,
      models: detail.codeDefinition?.models ?? [],
      stepLimit: null,
      effort: null,
    };
  }
  return {
    model: definition.model,
    models: definition.models ?? [],
    stepLimit: definition.limits.steps === null ? null : String(definition.limits.steps),
    effort: definition.effort === null ? null : EFFORT_LABELS[definition.effort],
  };
}

/** The definition of an agent file, as `bureau.agents.definitions.get` shows it. */
type FileDefinition = NonNullable<AgentDetail['definition']>;

/** The most steps the Settings tab lets one run take (row 39s). */
export const STEP_LIMIT_MAXIMUM = 100;

/** The efforts the Effort control offers when the model's own are not known (row 38v). */
export const DEFAULT_EFFORT_CHOICES: readonly Effort[] = ['low', 'medium', 'high'];

/** What the Settings form holds: the model, the models a chat may change to, the effort and the step limit as typed. */
export interface SettingsForm {
  /** The model a chat starts on, `<provider>/<model>`, as the file wrote it until it is changed. */
  readonly model: string;
  /** The models a chat may change to, in the order they were added. */
  readonly models: readonly string[];
  /** The effort a chat starts at, or `''` when the file sets none. */
  readonly effort: Effort | '';
  /** The step limit as typed; empty is the default. */
  readonly stepLimit: string;
}

/** The form as the file fills it. */
export function settingsFormOf(definition: FileDefinition): SettingsForm {
  return {
    model: definition.model,
    models: definition.models ?? [],
    effort: definition.effort ?? '',
    stepLimit: definition.limits.steps === null ? '' : String(definition.limits.steps),
  };
}

/**
 * Why the step limit cannot be saved as typed (row 39s), or `''` when it can. Empty is the default.
 * The limit the file already has (`kept`) is never refused, even past the bound the tab offers, so
 * a file written by hand with a larger limit can still save its other settings.
 */
export function stepLimitError(text: string, kept = ''): string {
  if (text.trim() !== '' && text.trim() === kept.trim()) return '';
  return parseLimit(text, true, STEP_LIMIT_MAXIMUM) === undefined
    ? AGENT_PAGE_COPY.settings.stepLimitError(STEP_LIMIT_MAXIMUM)
    : '';
}

/** The parts of the form, in the order the leave question names them. */
const FORM_PARTS = ['model', 'models', 'effort', 'stepLimit'] as const;

/** What `form` changed from `baseline`, as the leave question names the parts (row 39b). */
export function changedParts(baseline: SettingsForm, form: SettingsForm): string[] {
  const words = AGENT_PAGE_COPY.settings.parts;
  return FORM_PARTS.filter((part) => {
    if (part === 'models') return baseline.models.join('\n') !== form.models.join('\n');
    if (part === 'stepLimit') return baseline.stepLimit.trim() !== form.stepLimit.trim();
    return baseline[part] !== form[part];
  }).map((part) => words[part]);
}

/** The definition a save writes: the file's own, with the settings the form holds. */
export function settingsDefinition(
  definition: FileDefinition,
  form: SettingsForm,
): AgentDefinitionInput {
  // A step limit left as the file has it is written as the file has it, even past the bound the
  // tab offers, so saving another setting never changes it.
  const written = definition.limits.steps;
  const steps =
    form.stepLimit.trim() === (written === null ? '' : String(written))
      ? written
      : (parseLimit(form.stepLimit, true, STEP_LIMIT_MAXIMUM) ?? null);
  return {
    name: definition.name,
    description: definition.description,
    model: form.model,
    models: form.models.length === 0 ? null : [...form.models],
    // An effort is written when one is chosen, and `null` removes one the file had; a file that
    // never had one is left without.
    ...(form.effort === ''
      ? definition.effort === null
        ? {}
        : { effort: null }
      : { effort: form.effort }),
    tools: definition.tools,
    card: definition.card,
    // The keys the tab does not edit are carried back as the file has them, as the editor does.
    ...(definition.skills === null ? {} : { skills: definition.skills }),
    ...(definition.children == null ? {} : { children: definition.children }),
    a2a: definition.a2a,
    ...(definition.retry === null ? {} : { retry: definition.retry }),
    ...(definition.compaction === null ? {} : { compaction: definition.compaction }),
    ...(definition.interceptors === null ? {} : { interceptors: definition.interceptors }),
    ...(definition.guardrails === null ? {} : { guardrails: definition.guardrails }),
    ...(definition.approvals === null ? {} : { approvals: definition.approvals }),
    // Only the step limit: a limit left out of `limits` keeps the file's.
    limits: { steps },
    instructions: definition.instructions,
  };
}

/**
 * The efforts the Effort control offers: the ones the model supports, or Low, Medium and High when
 * the model's are not known, and always the one the form holds, so the control shows what the
 * file says.
 */
export function effortChoices(
  supported: readonly string[] | undefined,
  held: Effort | '',
): Effort[] {
  const offered: readonly string[] =
    supported === undefined || supported.length === 0 ? DEFAULT_EFFORT_CHOICES : supported;
  return EFFORTS.filter((effort) => effort === held || offered.includes(effort));
}

/** A model as a person says it, `Claude Sonnet 5.5`, from `<provider>/<model>`. */
export function modelName(model: string): string {
  const separator = model.indexOf('/');
  return separator === -1 ? model : modelDisplayName(model.slice(separator + 1));
}

/** The provider of a model written `<provider>/<model>`, or `''` for one that names none. */
export function providerOf(model: string): string {
  const separator = model.indexOf('/');
  return separator === -1 ? '' : model.slice(0, separator);
}

/** The model and its provider, as the Model section names them: "Claude Sonnet 5.5, Anthropic" (row 38u). */
export function modelLineOf(model: string): string {
  const provider = providerOf(model);
  return provider === ''
    ? modelName(model)
    : AGENT_PAGE_COPY.settings.modelLine(modelName(model), providerDisplayName(provider));
}

/** What a changed key is called. */
function keyLabel(key: string): string {
  const keys: Readonly<Record<string, string>> = AGENT_PAGE_COPY.versions.keys;
  return Object.hasOwn(keys, key) ? (keys[key] ?? key) : key;
}

/** One changed key of `version` against the version before it, in words. */
function changeOf(
  key: string,
  version: FileDefinition | null,
  previous: FileDefinition | null,
): string {
  const words = AGENT_PAGE_COPY.versions.change;
  const label = keyLabel(key);
  if (version === null || previous === null) return words.edited(label);
  switch (key) {
    case 'model':
      return words.fromTo(label, modelName(previous.model), modelName(version.model));
    case 'effort':
      return words.fromTo(
        label,
        previous.effort === null ? words.none : EFFORT_LABELS[previous.effort],
        version.effort === null ? words.none : EFFORT_LABELS[version.effort],
      );
    case 'tools': {
      const added = version.tools.filter((tool) => !previous.tools.includes(tool));
      const removed = previous.tools.filter((tool) => !version.tools.includes(tool));
      if (added.length === 0 && removed.length === 0) return words.edited(label);
      return `${label}: ${words.tools(added.map(humanizeName), removed.map(humanizeName))}`;
    }
    default:
      return words.edited(label);
  }
}

/**
 * What a version changed from the one before it, in one line: "Model: Claude Haiku 5.5 to Claude
 * Sonnet 5.5; Tools: added Issue refund". The first version says Created, and a save that changed
 * nothing says so. `previous` is the version before it, when it is still kept.
 */
export function versionChanges(version: AgentVersion, previous: AgentVersion | undefined): string {
  const words = AGENT_PAGE_COPY.versions;
  if (version.revision === 1) return words.created;
  if (version.changedKeys.length === 0) return words.nothingChanged;
  return version.changedKeys
    .map((key) => changeOf(key, version.definition, previous?.definition ?? null))
    .join('; ');
}

/**
 * The parts a restore of `revision` removes: what every later version changed, each part once,
 * as the restore question names them ("Instructions and Tools").
 */
export function restoredChanges(versions: readonly AgentVersion[], revision: number): string {
  const keys = new Set<string>();
  for (const version of versions) {
    if (version.revision <= revision) continue;
    for (const key of version.changedKeys) keys.add(key);
  }
  return AGENT_PAGE_COPY.settings.dependents.joined([...keys].map(keyLabel));
}

/**
 * What stops finding the agent once it is deleted, as the delete question names it: "1 schedule
 * (Weekly refund audit), 1 workflow (Order refund) and 1 hook (Refund audit)", or `''` when nothing
 * names it. A schedule, workflow or hook with no name is called by its identifier.
 */
export function dependentsLine(references: AgentReferences | undefined): string {
  if (references === undefined) return '';
  const words = AGENT_PAGE_COPY.settings.dependents;
  const groups = [
    {
      counted: words.schedule(references.schedules.length),
      names: references.schedules.map((schedule) => schedule.name ?? schedule.id),
    },
    {
      counted: words.workflow(references.workflows.length),
      names: references.workflows.map((workflow) => workflow.title ?? workflow.id),
    },
    {
      counted: words.hook(references.hooks.length),
      names: references.hooks.map((hook) => hook.name ?? hook.id),
    },
  ].filter((group) => group.names.length > 0);
  return words.joined(groups.map((group) => words.named(group.counted, group.names)));
}
