import { cosineSimilarity } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createHashingEmbedder, HASHING_EMBEDDER_DIMENSION } from './hashing-embedder';

const embedder = createHashingEmbedder();

async function embed(text: string): Promise<number[]> {
  const [vector] = await embedder([text]);
  return vector!;
}

function magnitude(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0));
}

describe('createHashingEmbedder', () => {
  it('produces 256 finite dimensions', async () => {
    expect(HASHING_EMBEDDER_DIMENSION).toBe(256);
    const vector = await embed('The user prefers aisle seats.');
    expect(vector).toHaveLength(256);
    expect(vector.every(Number.isFinite)).toBe(true);
  });

  it('gives the same vector for the same text, in any batch and from any embedder', async () => {
    const vector = await embed('aisle seats');
    expect(await embedder(['aisle seats', 'aisle seats'])).toEqual([vector, vector]);
    expect(await createHashingEmbedder()(['aisle seats'])).toEqual([vector]);
  });

  it('normalizes a text with features to unit length', async () => {
    expect(magnitude(await embed('one two three four'))).toBeCloseTo(1, 10);
  });

  it('gives the zero vector to an empty text, which is similar to nothing', async () => {
    const empty = await embed('   ');
    expect(empty.every((entry) => entry === 0)).toBe(true);
    expect(cosineSimilarity(empty, await embed('aisle seats'))).toBe(0);
  });

  it('keeps a text of punctuation as a feature of its own', async () => {
    const vector = await embed('?!');
    expect(magnitude(vector)).toBeCloseTo(1, 10);
    expect(vector).not.toEqual(await embed('!?'));
  });

  it('ignores case and punctuation, as the package’s tokenizer does', async () => {
    expect(await embed('Aisle seats!')).toEqual(await embed('aisle seats'));
  });

  it('ranks a text that shares vocabulary above one that shares none', async () => {
    const query = await embed('which seats do I prefer');
    const related = await embed('The user prefers aisle seats on every flight.');
    const unrelated = await embed('Quarterly invoices are due on the first of the month.');
    const sharesSeats = await embed('Window seats are noisy.');
    expect(cosineSimilarity(query, sharesSeats)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    );
    expect(cosineSimilarity(query, related)).toBeGreaterThan(0);
    expect(cosineSimilarity(related, related)).toBeCloseTo(1, 10);
  });

  it('puts texts that share a phrase closer than texts that share only its words', async () => {
    const phrase = await embed('aisle seats please');
    const samePhrase = await embed('aisle seats always');
    const scattered = await embed('seats aisle always');
    expect(cosineSimilarity(phrase, samePhrase)).toBeGreaterThan(
      cosineSimilarity(phrase, scattered),
    );
  });

  it('does not depend on the batch it is called with', async () => {
    const alone = await embed('alpha beta');
    const other = await embed('gamma delta');
    expect(await embedder(['alpha beta', 'gamma delta', 'alpha beta'])).toEqual([
      alone,
      other,
      alone,
    ]);
    expect(alone).not.toEqual(other);
  });
});
