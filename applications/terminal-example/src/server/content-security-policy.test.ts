import { describe, expect, test } from 'bun:test';

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from './content-security-policy.ts';

function directives(): Map<string, string> {
  return new Map(
    CONTENT_SECURITY_POLICY.split('; ').map((directive) => {
      const [name = '', ...values] = directive.split(' ');
      return [name, values.join(' ')];
    }),
  );
}

describe('the COR-483 policy', () => {
  test('allows the selected engine and nothing that needs more than its own origin', () => {
    const policy = directives();
    // `@xterm/xterm` needs script-src 'self' and no WebAssembly compilation.
    expect(policy.get('script-src')).toBe("'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('wasm-unsafe-eval');
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    // The session request and the WebSocket upgrade are the page's only network destination.
    expect(policy.get('connect-src')).toBe("'self'");
    expect(policy.get('default-src')).toBe("'self'");
  });

  test('closes objects, bases, framing and form posts', () => {
    const policy = directives();
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'none'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('form-action')).toBe("'none'");
  });

  test('names no remote origin', () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
  });

  test('travels with every response, beside the headers that stop sniffing and caching', () => {
    expect(SECURITY_HEADERS['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['cache-control']).toBe('no-store');
  });
});
