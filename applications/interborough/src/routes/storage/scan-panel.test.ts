/**
 * Component tests for `<ScanPanel>` (plan §9.6, Appendix B: prefix and
 * start/end range scans, NDJSON pages, cursor-based "Load more").
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import type { StorageConnection } from './storage-client.ts';

import ScanPanelHarness from './scan-panel-test-harness.test-harness.svelte';
import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';

function fakeClient(): StorageConnection {
  return { baseUrl: 'http://localhost:7233', headers: {} };
}

function ndjsonRow(key: string, value: Uint8Array): string {
  return JSON.stringify({ key, value: Buffer.from(value).toString('base64') });
}

function ndjsonResponse(rows: readonly string[]): Response {
  return new Response(rows.length > 0 ? `${rows.join('\n')}\n` : '', {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

let activeStub: { calls: StubbedFetchCall[]; restore: () => void } | undefined;

afterEach(() => {
  activeStub?.restore();
  activeStub = undefined;
});

describe('ScanPanel', () => {
  test('prompts for a prefix before any scan has run', () => {
    const { getByText } = render(ScanPanelHarness, { props: { client: fakeClient() } });

    expect(getByText('Scan storage')).not.toBeNull();
  });

  test('scans by prefix and renders a text value preview', async () => {
    activeStub = stubStorageFetch(() =>
      ndjsonResponse([ndjsonRow('app:config', new TextEncoder().encode('hello'))]),
    );

    const { getByLabelText, getByText, findByText } = render(ScanPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.input(getByLabelText('Prefix'), { target: { value: 'app:' } });
    await fireEvent.click(getByText('Scan'));

    expect(await findByText('app:config')).not.toBeNull();
    expect(getByText('hello')).not.toBeNull();
    expect(getByText(/prefix "app:"/)).not.toBeNull();
    expect(activeStub.calls[0]?.url).toContain('prefix=app%3A');
  });

  test('renders binary and empty value previews', async () => {
    activeStub = stubStorageFetch(() =>
      ndjsonResponse([
        ndjsonRow('app:binary', new Uint8Array([0xff, 0xfe, 0x80, 0x01])),
        ndjsonRow('app:empty', new Uint8Array()),
      ]),
    );

    const { getByText, findByText } = render(ScanPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.click(getByText('Scan'));

    expect(await findByText('(binary, 4 bytes)')).not.toBeNull();
    expect(getByText('(empty)')).not.toBeNull();
  });

  test('shows a no-keys-found empty state when the scan returns nothing', async () => {
    activeStub = stubStorageFetch(() => ndjsonResponse([]));

    const { getByText, findByText } = render(ScanPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.click(getByText('Scan'));

    expect(await findByText('No keys found')).not.toBeNull();
  });

  test('shows the fault message when the scan fails', async () => {
    activeStub = stubStorageFetch(
      () =>
        new Response(JSON.stringify({ error: 'Raw storage access requires storage:admin.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const { getByText, findByText } = render(ScanPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.click(getByText('Scan'));

    expect(await findByText('Raw storage access requires storage:admin.')).not.toBeNull();
  });

  test('scans by start/end range instead of prefix when that mode is selected', async () => {
    activeStub = stubStorageFetch(() => ndjsonResponse([]));

    const { getByLabelText, getByText } = render(ScanPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.click(getByText('Start / end'));
    await fireEvent.input(getByLabelText('Start (inclusive)'), { target: { value: 'app:a' } });
    await fireEvent.input(getByLabelText('End (exclusive)'), { target: { value: 'app:z' } });
    await fireEvent.click(getByText('Scan'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeStub.calls[0]?.url).toContain('gte=app%3Aa');
    expect(activeStub.calls[0]?.url).toContain('lt=app%3Az');
  });

  test('loads the next page with the previous page cursor and stops once a page is short', async () => {
    let callCount = 0;
    activeStub = stubStorageFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return ndjsonResponse([
          ndjsonRow('app:a', new TextEncoder().encode('1')),
          ndjsonRow('app:b', new TextEncoder().encode('2')),
        ]);
      }
      return ndjsonResponse([ndjsonRow('app:c', new TextEncoder().encode('3'))]);
    });

    const { getByLabelText, getByText, findByText, queryByText } = render(ScanPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.input(getByLabelText('Limit'), { target: { value: '2' } });
    await fireEvent.click(getByText('Scan'));
    await findByText('app:b');

    expect(getByText('Load more')).not.toBeNull();
    await fireEvent.click(getByText('Load more'));

    expect(await findByText('app:c')).not.toBeNull();
    expect(activeStub.calls[1]?.url).toContain('gt=app%3Ab');
    expect(queryByText('Load more')).toBeNull();
  });

  describe('with the prefixes found in storage', () => {
    const KNOWN = ['agent-session:', 'bureau-goal:'] as const;

    test('picks the prefix from them, with Any key first and Other last, instead of typing it', () => {
      const { getByLabelText } = render(ScanPanelHarness, {
        props: { client: fakeClient(), knownPrefixes: KNOWN },
      });

      const picker = getByLabelText('Prefix') as HTMLSelectElement;
      expect(picker.tagName).toBe('SELECT');
      expect([...picker.options].map((option) => option.textContent?.trim())).toEqual([
        'Any key',
        'agent-session:',
        'bureau-goal:',
        'Other…',
      ]);
    });

    test('scans the prefix that was picked, and everything when none was', async () => {
      activeStub = stubStorageFetch(() =>
        ndjsonResponse([ndjsonRow('bureau-goal:g1', new TextEncoder().encode('goal'))]),
      );

      const { getByLabelText, getByText, findByText } = render(ScanPanelHarness, {
        props: { client: fakeClient(), knownPrefixes: KNOWN },
      });

      await fireEvent.click(getByText('Scan'));
      await findByText('bureau-goal:g1');
      expect(new URL(activeStub.calls[0]?.url ?? '').searchParams.get('prefix')).toBe('');

      await fireEvent.change(getByLabelText('Prefix'), { target: { value: 'bureau-goal:' } });
      await fireEvent.click(getByText('Scan'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(new URL(activeStub.calls[1]?.url ?? '').searchParams.get('prefix')).toBe(
        'bureau-goal:',
      );
    });

    test('Other brings a field to type a prefix that is not in the list, such as a reserved one', async () => {
      activeStub = stubStorageFetch(() => ndjsonResponse([]));

      const { getByLabelText, getByText, queryByLabelText } = render(ScanPanelHarness, {
        props: { client: fakeClient(), knownPrefixes: KNOWN },
      });
      expect(queryByLabelText('Other prefix')).toBeNull();

      await fireEvent.change(getByLabelText('Prefix'), { target: { value: '__other__' } });
      await fireEvent.input(getByLabelText('Other prefix'), { target: { value: 'wf:' } });
      await fireEvent.click(getByText('Scan'));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(new URL(activeStub.calls[0]?.url ?? '').searchParams.get('prefix')).toBe('wf:');
    });
  });
});
