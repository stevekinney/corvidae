import { describe, expect, it } from 'bun:test';

import {
  isSessionAuthorityAuthorized,
  isSessionHistoryReadAuthorized,
  isSessionRunTerminal,
  resolvePersistedRunOwningPrincipal,
  resolveSessionOwner,
  resolveSessionPreAdmission,
  SESSION_OWNER_METADATA_KEY,
} from './session-authority';

describe('resolveSessionOwner / isSessionAuthorityAuthorized (COR-718)', () => {
  it('reads the owner from the session owner key', () => {
    expect(resolveSessionOwner({ [SESSION_OWNER_METADATA_KEY]: 'api-key:alice' })).toBe(
      'api-key:alice',
    );
  });

  it('reads a session with no owner as anonymous:local, as a read rule', () => {
    expect(resolveSessionOwner({})).toBe('anonymous:local');
    expect(isSessionAuthorityAuthorized({}, 'anonymous:local')).toBe(true);
  });

  it('no longer treats a session with nothing recorded as open to every principal', () => {
    expect(isSessionAuthorityAuthorized({}, 'alice')).toBe(false);
    expect(isSessionAuthorityAuthorized({ lastRunId: 'run-1' }, 'alice')).toBe(false);
  });

  it('authorizes the owner and rejects every other principal', () => {
    const metadata = { [SESSION_OWNER_METADATA_KEY]: 'alice' };
    expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(true);
    expect(isSessionAuthorityAuthorized(metadata, 'bob')).toBe(false);
    expect(isSessionAuthorityAuthorized(metadata, '')).toBe(false);
  });

  it('does not let the recorded tool-execution authority stand in for the owner', () => {
    const metadata = {
      [SESSION_OWNER_METADATA_KEY]: 'alice',
      lastRunId: 'run-1',
      lastRequestAuthorities: { 'run-1': { principalId: 'bob' } },
      lastRequestAuthority: { principalId: 'bob' },
    };
    expect(isSessionAuthorityAuthorized(metadata, 'bob')).toBe(false);
    expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(true);
  });

  it('fails closed, denying every principal, when the owner key is malformed', () => {
    for (const malformed of [42, null, ['alice'], { principalId: 'alice' }]) {
      const metadata = { [SESSION_OWNER_METADATA_KEY]: malformed };
      expect(resolveSessionOwner(metadata)).toBeUndefined();
      expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(false);
      expect(isSessionAuthorityAuthorized(metadata, 'anonymous:local')).toBe(false);
    }
  });

  it('gives the same verdict whichever run a request targets', () => {
    const metadata = { [SESSION_OWNER_METADATA_KEY]: 'alice', lastRunId: 'run-b' };
    expect(isSessionAuthorityAuthorized(metadata, 'alice', 'run-a')).toBe(true);
    expect(isSessionAuthorityAuthorized(metadata, 'bob', 'run-a')).toBe(false);
  });
});

describe('resolvePersistedRunOwningPrincipal (AB-359)', () => {
  it('returns undefined when the map is entirely absent — the exact shape an older, pre-AB-359 record decodes as', () => {
    expect(resolvePersistedRunOwningPrincipal({}, 'run-1')).toBeUndefined();
  });

  it('returns undefined when the map does not carry an entry for this runId', () => {
    expect(
      resolvePersistedRunOwningPrincipal(
        { lastRunOwningPrincipals: { 'run-other': 'alice' } },
        'run-1',
      ),
    ).toBeUndefined();
  });

  it('returns undefined when the map itself is malformed (not a plain object)', () => {
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: ['not-a-map'] }, 'run-1'),
    ).toBeUndefined();
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: 'not-a-map' }, 'run-1'),
    ).toBeUndefined();
  });

  it('returns undefined when the entry for this runId is present but not a string', () => {
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: { 'run-1': 42 } }, 'run-1'),
    ).toBeUndefined();
  });

  it('returns the persisted principal for a well-formed entry', () => {
    expect(
      resolvePersistedRunOwningPrincipal(
        { lastRunOwningPrincipals: { 'run-1': 'alice', 'run-2': 'bob' } },
        'run-1',
      ),
    ).toBe('alice');
  });
});

describe('isSessionRunTerminal (AB-194)', () => {
  it('is false when lastRunStatus is running', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'running' })).toBe(false);
  });

  it('is true for every non-running status, including absent', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'completed' })).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'error' })).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'aborted' })).toBe(true);
    expect(isSessionRunTerminal({})).toBe(true);
  });
});

describe('isSessionRunTerminal with a live-run set (COR-301)', () => {
  it('is terminal only when the last run is not running and no run is live', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'completed' }, [])).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'completed' }, ['run-a'])).toBe(false);
    expect(isSessionRunTerminal({}, ['run-a', 'run-c'])).toBe(false);
    expect(isSessionRunTerminal({ lastRunStatus: 'running' }, [])).toBe(false);
  });
});

describe('resolveSessionPreAdmission (COR-301)', () => {
  const owned = (extra: Record<string, unknown> = {}) => ({
    [SESSION_OWNER_METADATA_KEY]: 'alice',
    ...extra,
  });

  it('authorizes the owner whichever run is targeted or live, and refuses everyone else', () => {
    const metadata = owned({ lastRunId: 'run-b', lastRunStatus: 'completed' });
    expect(resolveSessionPreAdmission(metadata, 'alice', [])).toBe('session-terminal');
    expect(resolveSessionPreAdmission(metadata, 'alice', ['run-a'])).toBe('proceed');
    expect(resolveSessionPreAdmission(metadata, 'alice', ['run-a', 'run-c'])).toBe('proceed');
    expect(resolveSessionPreAdmission(metadata, 'alice', ['run-a', 'run-c'], 'run-a')).toBe(
      'proceed',
    );
    for (const live of [[], ['run-a'], ['run-a', 'run-c']]) {
      expect(resolveSessionPreAdmission(metadata, 'bob', live)).toBe('not-found');
      expect(resolveSessionPreAdmission(metadata, 'bob', live, 'run-a')).toBe('not-found');
    }
  });

  it('authorizes before it checks the lifecycle', () => {
    const terminal = owned({ lastRunId: 'run-1', lastRunStatus: 'completed' });
    expect(resolveSessionPreAdmission(terminal, 'alice', [])).toBe('session-terminal');
    expect(resolveSessionPreAdmission(terminal, 'mallory', [])).toBe('not-found');
    expect(resolveSessionPreAdmission({ ...terminal, lastRunStatus: 'running' }, 'alice', [])).toBe(
      'proceed',
    );
  });

  it('refuses a stranger on a session with nothing recorded, and admits anonymous:local', () => {
    const unrecorded = { lastRunId: 'run-b', lastRunStatus: 'completed' };
    expect(resolveSessionPreAdmission(unrecorded, 'anyone', ['run-a'])).toBe('not-found');
    expect(resolveSessionPreAdmission(unrecorded, 'anonymous:local', ['run-a'])).toBe('proceed');
    expect(resolveSessionPreAdmission(unrecorded, 'anonymous:local', [])).toBe('session-terminal');
  });
});

describe('isSessionHistoryReadAuthorized (COR-718)', () => {
  it('lets only the session owner read, whoever else ran on the session', () => {
    const metadata = {
      [SESSION_OWNER_METADATA_KEY]: 'alice',
      lastRunOwningPrincipals: { 'run-1': 'alice', 'run-2': 'bob' },
    };
    expect(isSessionHistoryReadAuthorized(metadata, 'alice')).toBe(true);
    expect(isSessionHistoryReadAuthorized(metadata, 'bob')).toBe(false);
  });

  it('reads a session with no owner as anonymous:local, and fails closed on a malformed owner', () => {
    expect(isSessionHistoryReadAuthorized({}, 'anonymous:local')).toBe(true);
    expect(isSessionHistoryReadAuthorized({}, 'alice')).toBe(false);
    expect(isSessionHistoryReadAuthorized({ [SESSION_OWNER_METADATA_KEY]: 7 }, 'alice')).toBe(
      false,
    );
  });
});
