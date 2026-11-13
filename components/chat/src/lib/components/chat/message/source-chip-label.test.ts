import { describe, expect, test } from 'bun:test';

import { sourceChipLabel } from './source-chip-label.ts';

describe('sourceChipLabel', () => {
  test('reads the host of a safe web address', () => {
    expect(sourceChipLabel({ label: 'Annual report', url: 'https://example.com/annual' })).toBe(
      'example.com',
    );
    expect(sourceChipLabel({ label: 'Docs', url: 'http://docs.example.com:8080/a?b=1' })).toBe(
      'docs.example.com:8080',
    );
  });

  test('uses supplied labels when same-host sources would otherwise be ambiguous', () => {
    const sources = [
      { label: 'Refund policy', url: 'https://docs.example.com/refunds' },
      { label: 'Duplicate-charge runbook', url: 'https://docs.example.com/duplicate' },
    ];
    expect(sourceChipLabel(sources[0]!, sources)).toBe('Refund policy');
    expect(sourceChipLabel(sources[1]!, sources)).toBe('Duplicate-charge runbook');
  });

  test('keeps a host when same-host sources have the same supplied label', () => {
    const sources = [
      { label: 'Refund policy', url: 'https://docs.example.com/refunds' },
      { label: 'Refund policy', url: 'https://docs.example.com/duplicate' },
    ];
    expect(sourceChipLabel(sources[0]!, sources)).toBe('docs.example.com');
  });

  test('reads the label when the source has no address', () => {
    expect(sourceChipLabel({ label: 'Board minutes' })).toBe('Board minutes');
    expect(sourceChipLabel({ label: 'Board minutes', url: '   ' })).toBe('Board minutes');
  });

  test('reads the label for a relative path, which has no host', () => {
    expect(sourceChipLabel({ label: 'Policy', url: '/policies/travel' })).toBe('Policy');
  });

  test('reads the label, never the address, when the address is not a safe web link', () => {
    expect(sourceChipLabel({ label: 'Unsafe source', url: 'javascript:alert(1)' })).toBe(
      'Unsafe source',
    );
    expect(sourceChipLabel({ label: 'Protocol-relative', url: '//evil.example/x' })).toBe(
      'Protocol-relative',
    );
  });
});
