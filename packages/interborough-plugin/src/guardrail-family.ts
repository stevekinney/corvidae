import type { PluginGuardrailFactory } from './contributions.ts';

/** What a guardrail guards, which is the family it is claimed in and the group it is returned under. */
export type GuardrailFamily = 'input' | 'output' | 'tools' | 'memory';

/**
 * The identity of a guardrail, `plugin:family/name`, such as `acme:memory/credentials`. A name is
 * claimed within its family and the family is part of the identity, so one detector can serve
 * `guardrails.input` and `guardrails.memory` under one name. An agent file names an input, output or
 * tool-call guardrail as `plugin:name` instead, which carries no family.
 */
export function guardrailId(plugin: string, family: GuardrailFamily, name: string): string {
  return `${plugin}:${family}/${name}`;
}

/** Whether `value` is a {@link PluginGuardrailFactory} rather than a detector or validator. */
export function isGuardrailFactory<T>(
  value: T | PluginGuardrailFactory<T>,
): value is PluginGuardrailFactory<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly create?: unknown }).create === 'function' &&
    // `typeof null` is `'object'`, so a factory whose `configuration` is `null` is not one.
    typeof (value as { readonly configuration?: unknown }).configuration === 'object' &&
    (value as { readonly configuration?: unknown }).configuration !== null
  );
}
