import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as memory from '../src/index';

/**
 * Guards on the shape of the transition path: it touches evidence and
 * projections only, and `MemoryRecord.version` plays no part in it.
 */

const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const transitionSources = [
  ...readdirSync(sourceDirectory).filter((file) => file.startsWith('transition-')),
  'consolidate-projections.ts',
];

describe('the transition path', () => {
  it('never imports the record store, so MemoryRecord.version is not read for concurrency', () => {
    for (const file of transitionSources) {
      const source = readFileSync(`${sourceDirectory}${file}`, 'utf8');
      expect(source, file).not.toContain('memory-record-storage');
      expect(source, file).not.toContain('MemoryRecord');
    }
  });

  it('points concurrency-safe changes at the transition engine from the version marker', () => {
    const source = readFileSync(`${sourceDirectory}memory-record-storage.ts`, 'utf8');
    expect(source).toContain('createTransitionEngine');
    // The existing expectedVersion guidance stays.
    expect(source).toContain('`expectedVersion`');
  });

  it('exports the engine, its errors, and the consolidation entry point from the package root', () => {
    expect(typeof memory.createTransitionEngine).toBe('function');
    expect(typeof memory.consolidateProjections).toBe('function');
    expect(typeof memory.transitionDigest).toBe('function');
    expect(memory.EMBEDDING_PROFILE_SCHEMA_VERSION).toBe(1);
    expect(
      memory.embeddingProfileSchema.safeParse({
        schemaVersion: 1,
        model: 'm',
        dimensions: 2,
        generation: 1,
      }).success,
    ).toBe(true);
    expect(memory.TRANSITION_EVENT_KINDS).toHaveLength(9);
    expect(memory.TRANSITION_PROPOSAL_KINDS).toHaveLength(5);
    expect(new memory.MemoryTransitionProposalError('x').code).toBe('malformed');
    expect(typeof memory.TransitionIdentifierConflictError).toBe('function');
  });
});
