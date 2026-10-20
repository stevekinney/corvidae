import type { Embedder, EmbeddingVector } from 'armorer';

import { tokenize } from './text-search';

/** How many dimensions {@link createHashingEmbedder} produces. */
export const HASHING_EMBEDDER_DIMENSION = 256;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a over the UTF-16 code units of `text`, as an unsigned 32-bit integer. */
function hashText(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * The features of one text: its words, and each pair of neighbouring words, so that two texts
 * sharing a phrase land closer than two sharing only scattered words. A text with no word at all,
 * such as one of punctuation, is its own single feature rather than the zero vector.
 */
function featuresOf(text: string): string[] {
  const words = tokenize(text);
  if (words.length === 0) return text.trim() === '' ? [] : [text.trim()];
  const features = [...words];
  for (let index = 0; index + 1 < words.length; index++) {
    features.push(`${words[index]} ${words[index + 1]}`);
  }
  return features;
}

function embedText(text: string): EmbeddingVector {
  const vector = Array.from({ length: HASHING_EMBEDDER_DIMENSION }, () => 0);
  for (const feature of featuresOf(text)) {
    const hash = hashText(feature);
    // The sign comes from a bit the bucket does not use, so two features sharing a bucket tend to
    // cancel instead of piling up.
    const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
    vector[hash % HASHING_EMBEDDER_DIMENSION]! += sign;
  }
  let magnitude = 0;
  for (const entry of vector) magnitude += entry * entry;
  magnitude = Math.sqrt(magnitude);
  return magnitude === 0 ? vector : vector.map((entry) => entry / magnitude);
}

/**
 * A deterministic embedder that makes no network call and needs no model: the feature-hashing
 * trick over a text's words and word pairs, folded into {@link HASHING_EMBEDDER_DIMENSION}
 * dimensions and normalized to unit length. The same text always gives the same vector, and two
 * texts that share words give vectors with a positive cosine similarity, so recall ranks by shared
 * vocabulary. It is lexical, not semantic: it knows nothing of synonyms, so a deployment that wants
 * meaning supplies a provider-backed embedder instead. A text with no feature, an empty one, gives
 * the zero vector, which is similar to nothing.
 *
 * Unlike `createMockEmbedder`, which exists for tests and gives unrelated vectors for related
 * texts, this one is meant to run in production on a host that has no model provider configured.
 */
export function createHashingEmbedder(): Embedder {
  return (texts) => texts.map(embedText);
}
