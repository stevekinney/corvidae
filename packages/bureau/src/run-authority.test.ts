import { describe, expect, it } from 'bun:test';

import { BUREAU_SCOPES } from './http/bureau-scopes.ts';
import { createRunPrincipal, mayRunAccess } from './run-authority.ts';

describe('run authority (COR-2026)', () => {
  it('gives local runs every Bureau scope', () => {
    const principal = createRunPrincipal('anonymous:local');
    expect(BUREAU_SCOPES.every((scope) => principal.hasScope(scope))).toBe(true);
  });

  it('gives API-key runs no Bureau scopes', () => {
    const principal = createRunPrincipal('api-key:a2a');
    expect(BUREAU_SCOPES.some((scope) => principal.hasScope(scope))).toBe(false);
  });

  it('uses owner equality without scopes for custom owners', () => {
    const principal = createRunPrincipal('library:custom');
    expect(BUREAU_SCOPES.some((scope) => principal.hasScope(scope))).toBe(false);
    expect(mayRunAccess('library:custom', 'bureau.tasks:read', 'library:custom')).toBe(true);
    expect(mayRunAccess('library:custom', 'bureau.tasks:read', 'library:other')).toBe(false);
  });
});
