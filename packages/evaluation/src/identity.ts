/**
 * Evaluator identity: `{ name, revision, digest }`. `name` and `revision`
 * are what a person cites; `digest` is what makes the citation exact. It is
 * the SHA-256 of the configuration's canonical serialization (object keys
 * sorted at every depth, array order kept), so any change to any field moves
 * it while two structurally equal configurations always share it, however
 * their keys were ordered.
 */
import { sha256Hex } from '@lostgradient/cryptography';

import type { EvaluatorConfiguration } from './configuration';

export interface EvaluatorIdentity {
  readonly name: string;
  readonly revision: number;
  readonly digest: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** JSON with object keys sorted at every depth; the input to {@link evaluatorIdentity}'s digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function evaluatorIdentity(
  configuration: EvaluatorConfiguration,
): Promise<EvaluatorIdentity> {
  return {
    name: configuration.name,
    revision: configuration.revision,
    digest: await sha256Hex(canonicalJson(configuration)),
  };
}
