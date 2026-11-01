/**
 * Duplicating an agent (`/agents/new?from=<id>`): the definition a copy's form is filled from, and
 * the identifier it starts with. A file agent is copied whole, so `toolApproval`, the budgets, the
 * guardrails, the model list and the `references` come with it. A built-in agent has no file, so its
 * `codeDefinition` (what the agent states about itself) is read as one; it states no approvals or
 * budgets, so the copy has none. Nothing is written until the person saves the form.
 */
import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import {
  AGENT_IDENTIFIER_MAX_LENGTH,
  AGENT_IDENTIFIER_PATTERN,
  type AgentDetail,
} from '../../lib/agent-definitions.ts';
import type { DefinitionSeed } from './agent-editor-state.svelte.ts';

/** The suffix a copy's identifier and name start with, so the copy is not mistaken for the original. */
const COPY_SUFFIX = '-copy';

/**
 * The definition a copy of `detail` starts from, or `null` when the agent has nothing to copy: an
 * invalid file. The copy never opts into A2A, which is a decision about the original.
 */
export function copySeedOf(detail: AgentDetail): DefinitionSeed | null {
  const { definition, codeDefinition } = detail;
  if (detail.source === 'file') {
    if (definition === null) return null;
    return {
      ...definition,
      name: AGENT_EDITOR_COPY.copyName(definition.name),
      a2a: false,
      // The documents a `references` list names sit beside the original, in the directory the copy
      // is written to, so the copy finds them. Only a plugin's documents are out of reach, and the
      // Bureau refuses that copy when it is saved.
    };
  }
  if (codeDefinition === null) return null;
  return {
    name: AGENT_EDITOR_COPY.copyName(codeDefinition.name),
    description: codeDefinition.description,
    // A scripted or routed agent names no model, so its first switchable model stands in (a file's
    // model list must hold its model); with none of those either, the form starts on the first one
    // offered.
    model: codeDefinition.model ?? codeDefinition.models[0] ?? '',
    models: codeDefinition.models.length === 0 ? null : codeDefinition.models,
    tools: codeDefinition.tools,
    skillDescriptors: codeDefinition.skillDescriptors,
    // A file agent has only the skills it names, so the copy names what the original can activate.
    allowedSkills: codeDefinition.skills.length === 0 ? null : codeDefinition.skills,
    a2a: false,
    stepLimit: null,
    retry: null,
    compaction: null,
    hooks: null,
    references: null,
    guardrails: null,
    costBudget: null,
    toolBudget: null,
    toolApproval: null,
    instructions: codeDefinition.instructions ?? '',
  };
}

/**
 * The identifier a copy of the agent `id` starts with: `<id>-copy`, cut so it stays an identifier
 * the Bureau accepts. A plugin's agent (`plugin:name`) is copied under its own name. When nothing
 * valid is left, the empty string, and the form suggests one from the name.
 */
export function copyIdentifierOf(id: string): string {
  const own = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const room = AGENT_IDENTIFIER_MAX_LENGTH - COPY_SUFFIX.length;
  const stem = own.slice(0, room).replace(/-+$/, '');
  const candidate = `${stem}${COPY_SUFFIX}`;
  return AGENT_IDENTIFIER_PATTERN.test(candidate) ? candidate : '';
}
