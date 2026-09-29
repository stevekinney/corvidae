import type { InputDetector } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { scanGovernedContent } from '../../src/governance/content-scan';

const quiet: InputDetector = {
  name: 'quiet',
  detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
};
const loud: InputDetector = {
  name: 'loud',
  detect: async () => ({ triggered: true, confidence: 0.8, category: 'poison', detail: 'x' }),
};
const broken: InputDetector = {
  name: 'broken',
  detect: async () => {
    throw new Error('detector offline');
  },
};

describe('scanGovernedContent', () => {
  it('reports clean content', async () => {
    expect(await scanGovernedContent('fact', [quiet], 'user-input')).toEqual({ flagged: false });
  });

  it('reports the first detector that trips, without the content', async () => {
    const seen: string[] = [];
    const spy: InputDetector = {
      name: 'spy',
      detect: async (_input, context) => {
        seen.push(context.provenance);
        return { triggered: false, confidence: 0, category: 'none' };
      },
    };
    expect(await scanGovernedContent('fact', [spy, loud, broken], 'ingested-document')).toEqual({
      flagged: true,
      detector: 'loud',
      category: 'poison',
      confidence: 0.8,
    });
    expect(seen).toEqual(['ingested-document']);
  });

  it('fails closed when a detector throws', async () => {
    expect(await scanGovernedContent('fact', [broken, quiet], 'recalled-memory')).toEqual({
      flagged: true,
      detector: 'broken',
      category: 'detector-failure',
      confidence: 1,
    });
  });
});
