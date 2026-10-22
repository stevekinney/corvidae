import { describe, expect, test } from 'bun:test';

import {
  buildMcpAppContentSecurityPolicy,
  buildMcpAppDocument,
  sanitizeDeclaredSources,
} from './mcp-app-content-security-policy.ts';

describe('MCP App content security policy', () => {
  test('a missing declaration is deny-all apart from the document itself', () => {
    const policy = buildMcpAppContentSecurityPolicy(undefined);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toMatch(/https?:|wss?:|\*/);
    expect(buildMcpAppContentSecurityPolicy({})).toBe(policy);
  });

  test('maps each declared list to its directives', () => {
    const policy = buildMcpAppContentSecurityPolicy({
      connectDomains: ['https://api.example.com', 'wss://live.example.com'],
      resourceDomains: ['https://*.cdn.example.com'],
      frameDomains: ['https://www.youtube.com'],
      baseUriDomains: ['https://base.example.com'],
    });
    expect(policy).toContain('connect-src https://api.example.com wss://live.example.com');
    expect(policy).toContain("script-src 'unsafe-inline' https://*.cdn.example.com");
    expect(policy).toContain('img-src data: blob: https://*.cdn.example.com');
    expect(policy).toContain('frame-src https://www.youtube.com');
    expect(policy).toContain('base-uri https://base.example.com');
  });

  test('drops declared sources that could break out of their directive', () => {
    expect(
      sanitizeDeclaredSources([
        'https://ok.example.com',
        'https://a.com; script-src *',
        'https://a.com, https://b.com',
        "'unsafe-eval'",
        '*',
        'data:',
        'https://a.com"',
      ]),
    ).toEqual(['https://ok.example.com']);
    const policy = buildMcpAppContentSecurityPolicy({
      connectDomains: ['https://a.com; connect-src *'],
    });
    expect(policy).toContain("connect-src 'none'");
  });

  test('puts the policy ahead of the app markup and escapes it as an attribute', () => {
    const document = buildMcpAppDocument('<script>1</script>', {
      connectDomains: ['https://a.com'],
    });
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
    expect(document).not.toMatch(/content="[^"]*"[^>]*"[^>]*>.*content=/s);
  });
});
