import { createHash } from 'node:crypto';

import { BungalowInputError } from './errors.ts';

/** Contents and opaque revision observed together; a null revision means the file is absent. */
export type ConfigurationSnapshot = {
  /** Original configuration bytes decoded as text, unchanged by Bungalow. */
  readonly text: string | undefined;
  /** Backend revision from the same read; pass it back without interpreting it. */
  readonly revision: string | null;
};

/** Explicit create-if-absent (null), or the revision the caller used to compute the update. */
export type ConfigurationWriteCondition = {
  /** Null requires absence. A string requires exactly the observed revision. */
  readonly expectedRevision: string | null;
};

/** Storage capability, independent of caller authorization and local/remote placement. */
export type ConfigurationWriteCapability = 'writable' | 'read-only' | 'unsupported';

/** A write result never equates an uncertain response with a rejected mutation. */
export type ConfigurationWriteResult =
  | { readonly outcome: 'committed' }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'read-only' }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'unavailable' }
  | {
      readonly outcome: 'unknown';
      /** Best-effort current standing; it is not proof that this attempt did not commit. */
      readonly current?: ConfigurationSnapshot;
    };

/** Reject an unconditional or malformed mutation before any write can start. */
export function assertConfigurationWrite(
  text: string,
  condition: ConfigurationWriteCondition,
): void {
  if (typeof text !== 'string') throw new BungalowInputError('The configuration must be text.');
  if (
    typeof condition !== 'object' ||
    condition === null ||
    !Object.hasOwn(condition, 'expectedRevision') ||
    (condition.expectedRevision !== null &&
      (typeof condition.expectedRevision !== 'string' || condition.expectedRevision === ''))
  ) {
    throw new BungalowInputError(
      'A configuration write requires an expected revision or explicit absence.',
    );
  }
}

/** A content revision keeps manual edits visible without changing configuration.json's format. */
export function localConfigurationSnapshot(text: string | undefined): ConfigurationSnapshot {
  return {
    text,
    revision: text === undefined ? null : createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * Local conditional replacement. The caller holds the Bungalow root lock throughout its life;
 * this synchronous compare/replace section has no suspension where another local call can race.
 */
export function writeLocalConfiguration(
  text: string,
  condition: ConfigurationWriteCondition,
  read: () => string | undefined,
  replace: (text: string) => void,
): ConfigurationWriteResult {
  assertConfigurationWrite(text, condition);
  let current: ConfigurationSnapshot;
  try {
    current = localConfigurationSnapshot(read());
  } catch {
    return { outcome: 'unavailable' };
  }
  if (current.revision !== condition.expectedRevision) return { outcome: 'conflict' };
  try {
    replace(text);
    return { outcome: 'committed' };
  } catch {
    // A rename may have committed before directory sync failed. Never roll it back or replay it.
    try {
      return { outcome: 'unknown', current: localConfigurationSnapshot(read()) };
    } catch {
      return { outcome: 'unknown' };
    }
  }
}
