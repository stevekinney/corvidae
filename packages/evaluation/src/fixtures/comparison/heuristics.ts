/**
 * The versioned success heuristics the representative comparison dataset
 * cites, keyed `<name>@<version>`. Each is deterministic code: the same
 * content and expected value always give the same answer, so a success
 * contract that names one is as reproducible as an exact match.
 */
import type { SuccessHeuristics } from '../../comparison-datasets';

export const REPRESENTATIVE_SUCCESS_HEURISTICS: SuccessHeuristics = {
  /** One sentence whose whitespace-separated word count equals `expected`. */
  'exact-word-count@1': ({ content, expected }) => {
    const words = content.trim().split(/\s+/);
    return words.length === Number(expected);
  },
};
