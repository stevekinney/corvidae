/**
 * COR-1879 — the names plugin composition hands out, and who holds each. The first holder keeps a
 * name; a later claim on it is a `name-clash`.
 *
 * @module plugin-claims
 */

import type { PluginClashParty, PluginContributionKind, PluginProblem } from './plugin-types';

/**
 * A space of names. A contribution kind holds `plugin:name` ids, `plugin` holds plugin names,
 * `event-kind` holds the event kinds a formatter claims, and `provider-name` holds the bare names
 * of model providers, which the host resolves a generate by, so two plugins cannot share one.
 */
export type ClaimSpace = PluginContributionKind | 'plugin' | 'event-kind' | 'provider-name';

/** One name in one space. */
export interface Claim {
  /** The space the name lives in. */
  readonly space: ClaimSpace;
  /** The name. */
  readonly name: string;
}

/** The names held so far. */
export interface Claims {
  /** Records `party` as the holder of `claim`, unless it is already held. */
  hold(claim: Claim, party: PluginClashParty): void;
  /** Who holds `claim`, or `undefined`. */
  holder(claim: Claim): PluginClashParty | undefined;
  /**
   * A `name-clash` for each of `claims` that is already held, or that `claims` repeats: a plugin
   * that contributes two things under one name clashes with itself.
   */
  clashesOf(claims: readonly Claim[], party: PluginClashParty): PluginProblem[];
}

function keyOf(claim: Claim): string {
  return `${claim.space}\u0000${claim.name}`;
}

/** An empty set of claims. */
export function createClaims(): Claims {
  const held = new Map<string, PluginClashParty>();
  return {
    hold(claim, party) {
      const key = keyOf(claim);
      if (!held.has(key)) held.set(key, party);
    },
    holder: (claim) => held.get(keyOf(claim)),
    clashesOf(claims, party) {
      const problems: PluginProblem[] = [];
      const seen = new Set<string>();
      for (const claim of claims) {
        const key = keyOf(claim);
        const first = held.get(key) ?? (seen.has(key) ? party : undefined);
        seen.add(key);
        if (first !== undefined) {
          problems.push({ code: 'name-clash', name: claim.name, first, second: party });
        }
      }
      return problems;
    },
  };
}
