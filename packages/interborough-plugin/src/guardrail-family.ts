/** What a guardrail guards, which is the family it is claimed in and the group it is returned under. */
export type GuardrailFamily = 'input' | 'output' | 'memory';

/**
 * The identity of a guardrail, `plugin:family/name`, such as `acme:memory/credentials`. A name is
 * claimed within its family and the family is part of the identity, so one detector can serve
 * `guardrails.input` and `guardrails.memory` under one name. An agent file names an input or output
 * guardrail as `plugin:name` instead, which carries no family.
 */
export function guardrailId(plugin: string, family: GuardrailFamily, name: string): string {
  return `${plugin}:${family}/${name}`;
}
