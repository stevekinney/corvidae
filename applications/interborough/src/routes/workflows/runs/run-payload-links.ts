/**
 * What a run's Input and Output cards make of a value that names something in Interborough: a chat
 * (`chatId`), an agent (`agent`), another run (`runId`). The Fields view writes such a value as a link
 * under the thing's own name (the chat's title, the agent's display name, "Run 8f2c"), and leaves it
 * as plain text when the thing is not known: an identifier that leads nowhere is never a dead link.
 * The JSON view keeps the stored keys and values, because the card gives the inspector these
 * functions for its Fields view only.
 *
 * Plain functions over what the page has read, so the rules are tested without a page.
 */
import type { PayloadInspectorField } from '@lostgradient/cinder';

import { agentPath } from '../../../lib/agent-paths.ts';
import { chatSessionPath } from '../../../lib/identifier-paths.ts';
import { workflowDetailPath } from '../../../lib/router.svelte.ts';

/** The property names whose string value is a chat's identifier. */
export const CHAT_KEYS: readonly string[] = ['chatId', 'contextId'];
/** The property names whose string value is an agent's name. */
export const AGENT_KEYS: readonly string[] = ['agent', 'agentName'];
/** The property names whose string value is a run's identifier. */
export const RUN_KEYS: readonly string[] = ['runId', 'taskId'];

/** The identifiers of one kind that a payload names. */
export interface PayloadReferences {
  readonly chats: readonly string[];
  readonly agents: readonly string[];
  readonly runs: readonly string[];
}

/** What the page has found out about the identifiers a payload names. */
export interface PayloadLookups {
  /** A chat's title, by its identifier; a chat the Bureau does not have is not here. */
  readonly chats: ReadonlyMap<string, string>;
  /** An agent's name for a person, by its identifier; an agent that is not listed is not here. */
  readonly agents: ReadonlyMap<string, string>;
  /** The runs the Bureau has. */
  readonly runs: ReadonlySet<string>;
}

/** Lookups that know nothing, so every value stays plain text. */
export const NO_LOOKUPS: PayloadLookups = {
  chats: new Map(),
  agents: new Map(),
  runs: new Set(),
};

function topLevelStrings(value: unknown, keys: readonly string[]): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const found: string[] = [];
  for (const key of keys) {
    const entry: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (typeof entry === 'string' && entry !== '') found.push(entry);
  }
  return [...new Set(found)];
}

/** The identifiers a payload's top-level properties name, for the page to look up. */
export function payloadReferences(value: unknown): PayloadReferences {
  return {
    chats: topLevelStrings(value, CHAT_KEYS),
    agents: topLevelStrings(value, AGENT_KEYS),
    runs: topLevelStrings(value, RUN_KEYS),
  };
}

/** What a run is called by its identifier: "Run 8f2c" for `run-8f2c0d71`, from the first four characters of what follows `run-`. */
export function shortRunName(runId: string): string {
  const tail = runId.startsWith('run-') ? runId.slice('run-'.length) : runId;
  return `Run ${tail.slice(0, 4)}`;
}

type Kind = 'chat' | 'agent' | 'run';

/**
 * Which kind of thing a top-level property of the payload names, and the identifier it holds, or
 * `undefined` for a plain value.
 */
function referenceOf(field: PayloadInspectorField): { kind: Kind; id: string } | undefined {
  const id = field.value;
  if (field.path.length !== 1 || typeof id !== 'string') return undefined;
  if (CHAT_KEYS.includes(field.key)) return { kind: 'chat', id };
  if (AGENT_KEYS.includes(field.key)) return { kind: 'agent', id };
  if (RUN_KEYS.includes(field.key)) return { kind: 'run', id };
  return undefined;
}

/**
 * The address a value leads to, when it names a chat, an agent or a run that is known; otherwise
 * `undefined`, which leaves the value as text.
 */
export function payloadLinkFor(
  field: PayloadInspectorField,
  lookups: PayloadLookups,
): string | undefined {
  const reference = referenceOf(field);
  if (reference === undefined) return undefined;
  const { kind, id } = reference;
  if (kind === 'chat') return lookups.chats.has(id) ? chatSessionPath(id) : undefined;
  if (kind === 'agent') return lookups.agents.has(id) ? agentPath(id) : undefined;
  if (kind === 'run') return lookups.runs.has(id) ? workflowDetailPath(id) : undefined;
  return undefined;
}

/**
 * How a known value is written: a chat by its title, an agent by its name for a person, a run as
 * "Run 8f2c". `undefined` keeps the stored text, for a value that is not known.
 */
export function payloadValueText(
  field: PayloadInspectorField,
  lookups: PayloadLookups,
): string | undefined {
  const reference = referenceOf(field);
  if (reference === undefined) return undefined;
  const { kind, id } = reference;
  if (kind === 'chat') {
    const title = lookups.chats.get(id);
    return title === undefined || title === '' ? undefined : title;
  }
  if (kind === 'agent') return lookups.agents.get(id);
  if (kind === 'run') return lookups.runs.has(id) ? shortRunName(id) : undefined;
  return undefined;
}
