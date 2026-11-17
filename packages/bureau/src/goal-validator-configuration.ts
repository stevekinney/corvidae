/**
 * COR-2117 — parsing the configuration a goal gives its validator.
 *
 * `create` and `update` share one rule: the validator's Zod `configuration` schema decides what is
 * accepted, a validator without one takes none, and the parsed value (never the caller's) is what
 * the goal's record stores. A refusal names each field the schema refused, by path, so a caller can
 * show it beside the field.
 *
 * @module goal-validator-configuration
 */

import type { JSONValue, Validator } from '@lostgradient/operative';

import { isJsonValue } from './goal-state';

/** A configuration's most bytes once stored, so a record's size stays bounded. */
export const GOAL_VALIDATOR_CONFIGURATION_MAXIMUM_BYTES = 16 * 1024;

/** One field a configuration was refused for. `path` is empty when the configuration as a whole is. */
export interface GoalConfigurationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** The answer of {@link parseValidatorConfiguration}. */
export type ValidatorConfigurationParse =
  /** `value` is the copy to store; `undefined` when the goal names no configuration. */
  | { readonly ok: true; readonly value: JSONValue | undefined }
  | { readonly ok: false; readonly issues: readonly GoalConfigurationIssue[] };

const encoder = new TextEncoder();

/** The sentence a rejection carries for `issues`: the validator, then each field and what is wrong. */
export function describeConfigurationRefusal(
  validator: { readonly name: string; readonly version: string },
  issues: readonly GoalConfigurationIssue[],
): string {
  const named = issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
  return `The configuration for the validator "${validator.name}@${validator.version}" is refused: ${named}`;
}

const refused = (...issues: GoalConfigurationIssue[]): ValidatorConfigurationParse => ({
  ok: false,
  issues,
});

/**
 * Parses `supplied` against `validator`'s configuration schema. A configuration for a validator with
 * no schema is refused. The schema is given `undefined` when the caller named none, so it decides
 * whether that is allowed. The parsed value must be JSON, since the record stores it; it is copied,
 * so nothing the caller or a schema transform holds is shared with the record.
 */
export function parseValidatorConfiguration(
  validator: Pick<Validator, 'configuration' | 'identity'>,
  supplied: unknown,
): ValidatorConfigurationParse {
  const schema = validator.configuration;
  if (schema === undefined) {
    return supplied === undefined
      ? { ok: true, value: undefined }
      : refused({
          path: [],
          message: `The validator "${validator.identity.name}" takes no configuration.`,
        });
  }
  let parsed: ReturnType<typeof schema.safeParse>;
  try {
    parsed = schema.safeParse(supplied);
  } catch {
    // A transform or refinement that throws is the schema refusing, not an exception to surface.
    return refused({ path: [], message: 'The configuration could not be parsed.' });
  }
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === 'symbol' ? String(segment) : segment,
        ),
        message: issue.message,
      })),
    };
  }
  const { data } = parsed;
  if (data === undefined) return { ok: true, value: undefined };
  if (!isJsonValue(data)) {
    return refused({ path: [], message: 'The parsed configuration must be JSON.' });
  }
  const text = JSON.stringify(data);
  if (encoder.encode(text).byteLength > GOAL_VALIDATOR_CONFIGURATION_MAXIMUM_BYTES) {
    return refused({
      path: [],
      message: `The configuration must be at most ${GOAL_VALIDATOR_CONFIGURATION_MAXIMUM_BYTES} bytes.`,
    });
  }
  return { ok: true, value: JSON.parse(text) as JSONValue };
}
