/**
 * Component tests for `<StorageValueDisplay>` (plan §9.6: "Value display via
 * PayloadInspector — values are opaque bytes — handle non-JSON gracefully").
 * No `HttpClient`/query context needed — this component only classifies and
 * renders the `value` prop it's handed, so it's rendered directly rather than
 * through a `.test-harness.svelte` wrapper.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import StorageValueDisplay from './storage-value-display.svelte';

describe('StorageValueDisplay', () => {
  test('renders an explicit empty-value message for zero-length bytes', () => {
    const { getByText } = render(StorageValueDisplay, { props: { value: new Uint8Array() } });

    expect(getByText('Empty value (0 bytes).')).not.toBeNull();
  });

  test('renders a binary fallback message for bytes that fail UTF-8 decoding', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x80, 0x01]);
    const { getByText } = render(StorageValueDisplay, { props: { value: bytes } });

    expect(getByText(/Binary value/)).not.toBeNull();
    expect(getByText(/not valid UTF-8, cannot be displayed as text/)).not.toBeNull();
  });

  test('renders valid UTF-8 text through PayloadInspector using the default label', () => {
    const bytes = new TextEncoder().encode('{"owner":"ops"}');
    const { getByText } = render(StorageValueDisplay, { props: { value: bytes } });

    // PayloadInspector shows fields by default: a formatted label and a bare value.
    expect(getByText('Owner')).not.toBeNull();
    expect(getByText('ops')).not.toBeNull();
  });

  test('shows a stored property named for a secret, because the stored value is the source', () => {
    const bytes = new TextEncoder().encode('{"key":"theme","value":"dark"}');
    const { getByText, queryByText } = render(StorageValueDisplay, { props: { value: bytes } });

    expect(getByText('theme')).not.toBeNull();
    expect(getByText('dark')).not.toBeNull();
    expect(queryByText('Hidden')).toBeNull();
  });

  test('passes a custom label through to PayloadInspector', () => {
    const bytes = new TextEncoder().encode('{"owner":"ops"}');
    const { getByText } = render(StorageValueDisplay, {
      props: { value: bytes, label: 'app:config' },
    });

    expect(getByText('app:config')).not.toBeNull();
  });

  test('shows a value that is not JSON as text with its size, no switch, and a note saying why', () => {
    const { getByText, getByTestId, queryAllByRole } = render(StorageValueDisplay, {
      props: { value: new TextEncoder().encode('server started') },
    });

    expect(getByText('Value, text, 14 B')).not.toBeNull();
    expect(getByTestId('storage-text-value').textContent).toContain('server started');
    expect(queryAllByRole('radio')).toHaveLength(0);
    expect(getByTestId('storage-text-note').textContent).toBe(
      'This value isn’t JSON, so there is no Fields or JSON switch.',
    );
  });

  test('draws only the first 64 KB of a large value and says Copy value copies all of it', () => {
    const line = '2026-11-02 09:00:02 server started\n';
    const bytes = new TextEncoder().encode(line.repeat(70_000));
    const { getByText, getByTestId } = render(StorageValueDisplay, { props: { value: bytes } });

    expect(getByText('Value, text, 2.3 MB')).not.toBeNull();
    expect(getByTestId('storage-text-note').textContent).toBe(
      'Showing the first 64 KB. Copy value copies all 2.3 MB. This value isn’t JSON, so there is no Fields or JSON switch.',
    );
    const drawn =
      getByTestId('storage-text-value').querySelector('.cinder-code-block')?.textContent;
    expect(drawn?.length ?? 0).toBeLessThanOrEqual(64 * 1024 + 64);
    expect(drawn?.length ?? 0).toBeGreaterThan(60 * 1024);
  });

  test('shows JSON past 64 KB as text, not as fields', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ rows: 'x'.repeat(70_000) }));
    const { getByTestId, queryAllByRole } = render(StorageValueDisplay, {
      props: { value: bytes },
    });

    expect(queryAllByRole('radio')).toHaveLength(0);
    expect(getByTestId('storage-text-note').textContent).toContain(
      'This value is too large for the Fields and JSON switch.',
    );
  });
});
