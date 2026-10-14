export const CONTEXTS: string[];
export function savedEnvelopeText(): string;
export type ConsumerArtifacts = {
  envelope: {
    name: string;
    base: { packageVersion: string; sourceDigest: string };
    overrides: Record<string, unknown>;
    cssOverrides: Record<string, unknown>;
  };
  maps: Record<string, Record<string, string>>;
  css: string;
  diagnostics: unknown[];
};
export function consumerArtifacts(): ConsumerArtifacts;
export function runConsumerChecks(): ConsumerArtifacts;
