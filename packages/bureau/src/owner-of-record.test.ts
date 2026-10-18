import { describe, expect, it } from 'bun:test';

import {
  ANONYMOUS_LOCAL_OWNER,
  EXPIRY_ACTOR,
  RECOVERY_ACTOR,
  SCHEDULER_ACTOR,
  apiKeyOwner,
  isReservedOwnerSubject,
  ownerFromPrincipal,
  ownerOrLocal,
  principalDefect,
} from './owner-of-record';

describe('owner of record', () => {
  it('names the local owner and the three service principals', () => {
    expect(ANONYMOUS_LOCAL_OWNER).toBe('anonymous:local');
    expect(SCHEDULER_ACTOR).toBe('system:scheduler');
    expect(RECOVERY_ACTOR).toBe('system:recovery');
    expect(EXPIRY_ACTOR).toBe('system:expiry');
  });

  it('reads an absent owner as the local owner and leaves a stated one alone', () => {
    expect(ownerOrLocal(undefined)).toBe('anonymous:local');
    expect(ownerOrLocal('api-key:ops')).toBe('api-key:ops');
  });

  it('percent-encodes an API key subject, so two subjects never share an owner string', () => {
    expect(apiKeyOwner('ops')).toBe('api-key:ops');
    expect(apiKeyOwner('a:b')).toBe('api-key:a%3Ab');
    expect(apiKeyOwner('a:b')).not.toBe(apiKeyOwner('a%3Ab'));
  });

  it('reserves the system and anonymous namespaces', () => {
    expect(isReservedOwnerSubject('system:scheduler')).toBe(true);
    expect(isReservedOwnerSubject('anonymous:local')).toBe(true);
    expect(isReservedOwnerSubject('ops')).toBe(false);
    expect(isReservedOwnerSubject('systems')).toBe(false);
  });

  it('reads text or nothing as a principal, and names anything else as a defect', () => {
    expect(principalDefect(undefined)).toBeUndefined();
    expect(principalDefect('api-key:alice')).toBeUndefined();
    for (const value of [7, null, {}, [], true]) {
      expect(principalDefect(value, 'options.principal')).toBe(
        '"options.principal" must be a string',
      );
    }
  });

  it('refuses a principal in a reserved namespace, except the exact local owner', () => {
    expect(principalDefect('system:scheduler')).toMatch(/reserved/);
    expect(principalDefect('system:', 'options.principal')).toMatch(
      /^"options\.principal" .*reserved/,
    );
    expect(principalDefect('anonymous:other')).toMatch(/reserved/);
    expect(principalDefect('anonymous:')).toMatch(/reserved/);
    expect(principalDefect('anonymous:local')).toBeUndefined();
    // Only the namespace is reserved, not a subject that merely starts with its name.
    expect(principalDefect('systems')).toBeUndefined();
    expect(principalDefect('api-key:system%3Ascheduler')).toBeUndefined();
    const refuse = (message: string): never => {
      throw new Error(message);
    };
    expect(() => ownerFromPrincipal('system:recovery', refuse)).toThrow(/reserved/);
    expect(ownerFromPrincipal('anonymous:local', refuse)).toBe('anonymous:local');
  });

  it('derives an owner from a caller-supplied principal, and refuses what is not text', () => {
    const refuse = (message: string): never => {
      throw new Error(message);
    };

    expect(ownerFromPrincipal(undefined, refuse)).toBe('anonymous:local');
    expect(ownerFromPrincipal('api-key:alice', refuse)).toBe('api-key:alice');
    expect(() => ownerFromPrincipal(null, refuse)).toThrow('"principal" must be a string');
    expect(() => ownerFromPrincipal(7, refuse, 'goal principal')).toThrow(
      '"goal principal" must be a string',
    );
  });
});
