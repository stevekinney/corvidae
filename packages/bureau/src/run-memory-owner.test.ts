import type { JSONValue } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { resolveRunMemoryOwner } from './session-authority';

const metadata = (entries: Record<string, JSONValue>) => entries;

describe('resolveRunMemoryOwner (COR-1546)', () => {
  it('prefers the owner persisted for the run', () => {
    expect(
      resolveRunMemoryOwner(
        metadata({
          lastRunOwningPrincipals: { 'run-1': 'api-key:alice' },
          sessionOwner: 'api-key:session-owner',
        }),
        'run-1',
      ),
    ).toBe('api-key:alice');
  });

  it('falls back to the session’s owner when the run has none recorded, or no run is named', () => {
    const session = metadata({
      lastRunOwningPrincipals: { 'run-other': 'api-key:bob' },
      sessionOwner: 'api-key:session-owner',
    });
    expect(resolveRunMemoryOwner(session, 'run-1')).toBe('api-key:session-owner');
    expect(resolveRunMemoryOwner(session)).toBe('api-key:session-owner');
  });

  it('is anonymous:local when nothing records an owner', () => {
    expect(resolveRunMemoryOwner(metadata({}), 'run-1')).toBe('anonymous:local');
    expect(resolveRunMemoryOwner(metadata({ lastRunOwningPrincipals: 'malformed' }), 'run-1')).toBe(
      'anonymous:local',
    );
  });
});
