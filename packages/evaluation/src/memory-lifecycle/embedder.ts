/**
 * A deterministic stand-in for an embedding model, shared by every baseline
 * that embeds (the envelope's `embedder`). It is a bag of words: each
 * non-stop-word token, as `@lostgradient/memory` tokenizes it, is hashed into
 * one of `dimension` buckets, and the counts are normalized to unit length.
 * Two texts are similar exactly as far as they share words, which is the
 * signal a lexical evaluation needs and nothing a fixture can game.
 *
 * `@lostgradient/memory`'s own `createMockEmbedder` hashes a whole text into
 * a pseudo-random vector, so any two different texts are equally dissimilar;
 * it suits storage tests, not retrieval comparisons.
 */
import { type Embedder, isStopWord, tokenize } from '@lostgradient/memory';

const FNV_OFFSET = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/** 32-bit FNV-1a of `token`'s UTF-16 code units. */
function bucketOf(token: string, dimension: number): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < token.length; index += 1) {
    hash = Math.imul(hash ^ token.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  return hash % dimension;
}

/** One unit vector for `text`. A text with no content words gets the first basis vector. */
export function lexicalVector(text: string, dimension: number): number[] {
  const vector = Array.from({ length: dimension }, () => 0);
  for (const token of tokenize(text)) {
    if (!isStopWord(token)) vector[bucketOf(token, dimension)]! += 1;
  }
  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

export function createLexicalHashEmbedder(dimension: number): Embedder {
  return (texts) => texts.map((text) => lexicalVector(text, dimension));
}
