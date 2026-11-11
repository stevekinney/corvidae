// Type-level tripwire (COR-2132): the scorer option and its list were renamed, so a host that still
// passes `onlineEvals`, or the option's `judges` member, fails type-checking.

import type { BureauOptions } from './bureau-types/options.ts';

type ScorerOption = Pick<BureauOptions, 'scorers'>;

export const renamed: ScorerOption = { scorers: { list: [], sampleRate: 1 } };

// @ts-expect-error -- `onlineEvals` was renamed `scorers`
export const staleOption: ScorerOption = { onlineEvals: { list: [], sampleRate: 1 } };

// @ts-expect-error -- the option's `judges` member was renamed `list`
export const staleMember: ScorerOption = { scorers: { judges: [], sampleRate: 1 } };
