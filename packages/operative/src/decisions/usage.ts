import type { TokenUsage } from 'conversationalist';

/**
 * Adds two usage reports. An absent report contributes nothing, so the sum
 * stays absent until some attempt reports; the cache fields likewise stay
 * absent until one report carries them, because absent and zero differ.
 */
export function addTokenUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined,
): TokenUsage | undefined {
  if (left === undefined) return right === undefined ? undefined : { ...right };
  if (right === undefined) return { ...left };
  const sum: TokenUsage = {
    prompt: left.prompt + right.prompt,
    completion: left.completion + right.completion,
    total: left.total + right.total,
  };
  if (left.cacheCreationTokens !== undefined || right.cacheCreationTokens !== undefined) {
    sum.cacheCreationTokens = (left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0);
  }
  if (left.cacheReadTokens !== undefined || right.cacheReadTokens !== undefined) {
    sum.cacheReadTokens = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0);
  }
  return sum;
}
