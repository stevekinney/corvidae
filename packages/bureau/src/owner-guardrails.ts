/**
 * COR-2120 — how an agent file names the guardrails its owner wrote as files, beside the plugin
 * guardrails it names as `plugin:name`.
 *
 * An owner's guardrail is named by its file's stem, which holds no `:`, so it can never be a
 * contributed id. Bureau resolves a stem the way it resolves a contributed id, through
 * {@link AgentContributions}, by laying the owner's guardrails over the plugins'.
 *
 * An agent does not keep reading the file. When an agent is built it copies, for each owner guardrail
 * it names, the guardrail's id, digest and parsed definition ({@link OwnerGuardrailCopy}): its
 * identity folds the digests in (a changed guardrail is a changed agent, so a new revision and a
 * new snapshot), its guardrails are built from the copies, and its run snapshot stores them, so a
 * run that resumes rebuilds the agent it began as whatever the files say now.
 *
 * @module owner-guardrails
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { GuardrailListing } from './plugins/plugin-types';
import type { AgentContributions, ContributedGuardrail } from './agent-contributions';
import type { AgentFileDefinition } from './agent-file';
import { guardrailIdOf } from './agent-file';
import {
  type GuardrailFileDefinition,
  guardrailDefinitionSchema,
  ownerGuardrailEntries,
} from './guardrail-file';

/** The name an owner's guardrail carries where a contributed one carries its plugin's. */
export const OWNER_GUARDRAIL_PLUGIN = 'bungalow';

/** What an agent copies of an owner guardrail it names. */
export interface OwnerGuardrailCopy {
  /** The stem the agent file lists it by. */
  readonly id: string;
  /** The SHA-256 of the definition, folded into the agent's identity. */
  readonly digest: string;
  readonly definition: GuardrailFileDefinition;
}

/**
 * The rows `bureau.guardrails.list` shows for the owner's guardrail files: one per guardrail, in the
 * family its `checks` puts it in (`tools` for `tool-call`, `input` for `input` and `tool-result`,
 * which Operative runs as input detectors, and `output`), never configurable, with no plugin.
 */
export function ownerGuardrailRows(
  files: readonly { readonly name: string; readonly definition: GuardrailFileDefinition }[],
): GuardrailListing[] {
  return files.map(({ name, definition }) => ({
    id: name,
    family:
      definition.checks === 'tool-call'
        ? 'tools'
        : definition.checks === 'output'
          ? 'output'
          : 'input',
    description: definition.description,
    configurable: false,
    configuration: null,
    source: 'bungalow',
    plugin: null,
  }));
}

/** The schema a snapshot's copies are read with. */
export const ownerGuardrailCopySchema = z.strictObject({
  id: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  definition: guardrailDefinitionSchema,
});

/** The owner's guardrails as `contributions` holds a contributed one. */
function contributedOf(copy: OwnerGuardrailCopy): ContributedGuardrail {
  return {
    id: copy.id,
    plugin: OWNER_GUARDRAIL_PLUGIN,
    ...ownerGuardrailEntries(copy.id, copy.definition),
  };
}

/**
 * `base` with the owner's guardrails laid over its guardrails. The owner's ids hold no `:`, and a
 * contributed id always does, so neither shadows the other.
 */
export function withOwnerGuardrails(
  base: AgentContributions,
  owned: readonly OwnerGuardrailCopy[],
): AgentContributions {
  if (owned.length === 0) return base;
  const guardrails = new Map(base.guardrails);
  for (const copy of owned) guardrails.set(copy.id, contributedOf(copy));
  return { guardrails, interceptors: base.interceptors };
}

/**
 * The owner guardrails `definition` names, as copies, from `owned`: each id of its `guardrails` and
 * `escalations` that is one of them, once, in the order the file lists them.
 */
export function ownerCopiesNamedBy(
  definition: Pick<AgentFileDefinition, 'guardrails' | 'escalations'>,
  owned: ReadonlyMap<string, OwnerGuardrailCopy>,
): OwnerGuardrailCopy[] {
  const named: OwnerGuardrailCopy[] = [];
  const seen = new Set<string>();
  const ids = [
    ...(definition.guardrails ?? []).map((selection) => guardrailIdOf(selection)),
    ...(definition.escalations ?? []),
  ];
  for (const id of ids) {
    const copy = owned.get(id);
    if (copy === undefined || seen.has(id)) continue;
    seen.add(id);
    named.push(copy);
  }
  return named;
}

/**
 * The identity of an agent whose guardrails include owner guardrails: `base` (its file's hash, or
 * that folded with its reference documents) with each copy's id and digest, in the order the file
 * lists them. With none it is `base`, so an agent that names no owner guardrail keeps every revision
 * and snapshot it has.
 */
export function guardrailIdentity(base: string, copies: readonly OwnerGuardrailCopy[]): string {
  if (copies.length === 0) return base;
  return createHash('sha256')
    .update(`${base}\n${copies.map(({ id, digest }) => `guardrail\0${id}\0${digest}\n`).join('')}`)
    .digest('hex');
}

/** Whether two lists copy the same guardrails at the same digests, in the same order. */
export function sameGuardrailCopies(
  left: readonly OwnerGuardrailCopy[] | undefined,
  right: readonly OwnerGuardrailCopy[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return (
    a.length === b.length &&
    a.every((copy, index) => copy.id === b[index]?.id && copy.digest === b[index].digest)
  );
}
