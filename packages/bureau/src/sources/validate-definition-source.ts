/**
 * The check `createBureau` runs on `agentSource` and `workflowSource` (COR-1702): refuse a value
 * that is not a source of the right kind, with the option's name in the message.
 *
 * @module validate-definition-source
 */

import type { AgentSource, WorkflowSource } from './definition-source';
import { layeredAgentSource, layeredWorkflowSource } from './layered-source';

const SOURCE_METHODS = ['load', 'watch', 'write', 'delete'] as const;

/**
 * Refuse, through `badRequest`, a value that is not a {@link DefinitionSource} of the named `kind`.
 * A workflow source passed as `agentSource` (or the reverse) is the mistake the `kind` tag exists
 * to catch.
 */
export function validateDefinitionSource(
  option: 'agentSource' | 'workflowSource',
  kind: 'agent' | 'workflow',
  value: unknown,
  badRequest: (message: string) => never,
): void {
  if (typeof value !== 'object' || value === null) {
    badRequest(`"options.${option}" must be a definition source`);
  }
  const record = value as Record<string, unknown>;
  const missing = SOURCE_METHODS.find((method) => typeof record[method] !== 'function');
  if (missing !== undefined) {
    badRequest(`"options.${option}" must be a definition source: it has no "${missing}" method`);
  }
  if (record['kind'] !== kind) {
    badRequest(
      `"options.${option}" must be ${kind === 'agent' ? 'an agent' : 'a workflow'} source (kind "${kind}"), not kind ${JSON.stringify(record['kind'])}`,
    );
  }
  if (kind === 'agent' && typeof record['readSibling'] !== 'function') {
    badRequest(
      `"options.${option}" must be a definition source: it has no "readSibling" method, which reads an agent file's reference documents`,
    );
  }
}

/**
 * The one source Bureau reads `agentSource` or `workflowSource` through (COR-1873): the value
 * itself, or several sources layered with `layeredAgentSource` or `layeredWorkflowSource`. Each
 * source is checked as {@link validateDefinitionSource} checks one, and a list that cannot be
 * layered (empty, or two layers of one plugin) is refused through `badRequest`.
 */
export function resolveDefinitionSource<TKind extends 'agent' | 'workflow'>(
  option: 'agentSource' | 'workflowSource',
  kind: TKind,
  value: unknown,
  badRequest: (message: string) => never,
): TKind extends 'agent' ? AgentSource : WorkflowSource {
  type Resolved = TKind extends 'agent' ? AgentSource : WorkflowSource;
  if (!Array.isArray(value)) {
    validateDefinitionSource(option, kind, value, badRequest);
    return value as Resolved;
  }
  for (const [index, source] of value.entries()) {
    validateDefinitionSource(option, kind, source, (message) =>
      badRequest(message.replace(`"options.${option}"`, `"options.${option}[${index}]"`)),
    );
  }
  try {
    return (
      kind === 'agent'
        ? layeredAgentSource(value as AgentSource[])
        : layeredWorkflowSource(value as WorkflowSource[])
    ) as Resolved;
  } catch (error) {
    return badRequest(
      `"options.${option}" cannot be layered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
