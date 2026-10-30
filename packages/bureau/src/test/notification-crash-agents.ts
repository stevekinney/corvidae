/**
 * The generate functions shared by `notification-crash-child.ts`, so the child that dies and the
 * test that restarts over its storage run the same configuration.
 */
import type { GenerateFunction } from '@lostgradient/operative';

/** A run that completes. */
export const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

/** A run that fails: the model call throws. */
export const failsToGenerate: GenerateFunction = async () => {
  throw new Error('the model is unavailable');
};
