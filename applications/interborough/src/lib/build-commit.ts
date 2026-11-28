import { readRuntimeConfig } from './config.ts';

/** The publication label shown in the browser shell. */
export function buildCommit(): string {
  return typeof document === 'undefined' ? '' : (readRuntimeConfig().buildCommit ?? '');
}
