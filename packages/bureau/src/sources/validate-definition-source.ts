/**
 * The check `createBureau` runs on `agentSource` and `workflowSource` (COR-1702): refuse a value
 * that is not a source of the right kind, with the option's name in the message.
 *
 * @module validate-definition-source
 */

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
