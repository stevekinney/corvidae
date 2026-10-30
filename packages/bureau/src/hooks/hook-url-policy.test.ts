import { describe, expect, it } from 'bun:test';

import { hookUrlDefect } from './hook-url-policy.ts';

describe('hook URL policy', () => {
  it.each([
    'https://example.com/hook',
    'http://example.com:8080/a?token=abc',
    'http://localhost:3000/hook',
    'http://127.0.0.1/hook',
    'http://[::1]/hook',
    'http://10.1.2.3/hook',
    'http://172.16.0.1/hook',
    'http://192.168.1.1/hook',
    'http://[fd00::1]/hook',
    'http://8.8.8.8/hook',
  ])('allows %s by default', (url) => {
    expect(hookUrlDefect(url)).toBeUndefined();
  });

  it.each([
    ['ftp://example.com/hook', 'http or https'],
    ['file:///etc/passwd', 'http or https'],
    ['javascript:alert(1)', 'http or https'],
    ['not a url', 'valid absolute URL'],
    ['/relative', 'valid absolute URL'],
    ['https://user:pass@example.com/hook', 'user name or password'],
    ['https://user@example.com/hook', 'user name or password'],
    ['https://example.com/hook#frag', 'fragment'],
    ['http://169.254.169.254/latest/meta-data', 'address a hook may not'],
    ['http://169.254.0.1/', 'address a hook may not'],
    ['http://[fe80::1]/', 'address a hook may not'],
    ['http://0.0.0.0/', 'address a hook may not'],
    ['http://[::]/', 'address a hook may not'],
    ['http://224.0.0.1/', 'address a hook may not'],
    ['http://[ff02::1]/', 'address a hook may not'],
    ['http://[::ffff:169.254.169.254]/', 'address a hook may not'],
    ['http://[::ffff:a9fe:a9fe]/', 'address a hook may not'],
    ['http://2852039166/', 'address a hook may not'],
    ['http://0xa9.0xfe.0xa9.0xfe/', 'address a hook may not'],
  ])('refuses %s whatever the policy', (url, reason) => {
    expect(hookUrlDefect(url)).toContain(reason);
    expect(hookUrlDefect(url, { allowPrivateNetworks: false })).toContain(reason);
  });

  it('refuses a URL longer than 2048 characters', () => {
    expect(hookUrlDefect(`https://example.com/${'a'.repeat(2048)}`)).toContain('2048');
  });

  it.each([
    'http://localhost/hook',
    'http://app.localhost/hook',
    'http://127.0.0.1/hook',
    'http://127.1.2.3/hook',
    'http://[::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://10.0.0.1/hook',
    'http://172.31.255.255/hook',
    'http://192.168.0.1/hook',
    'http://[fc00::1]/hook',
  ])('refuses %s when the deployment refuses private networks', (url) => {
    expect(hookUrlDefect(url, { allowPrivateNetworks: false })).toContain('loopback or private');
  });

  it('still allows a public address when private networks are refused', () => {
    expect(
      hookUrlDefect('https://example.com/hook', { allowPrivateNetworks: false }),
    ).toBeUndefined();
    expect(
      hookUrlDefect('http://172.32.0.1/hook', { allowPrivateNetworks: false }),
    ).toBeUndefined();
  });

  it('quotes nothing from the URL in a refusal, which may hold a token', () => {
    expect(hookUrlDefect('ftp://example.com/?token=SECRET-TOKEN')).not.toContain('SECRET-TOKEN');
    expect(hookUrlDefect('https://u:SECRET-TOKEN@example.com/')).not.toContain('SECRET-TOKEN');
  });
});
