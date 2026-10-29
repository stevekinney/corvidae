/**
 * Component tests for `<CapabilitiesPanel>` (COR-1539): every capability
 * `weft.storage.capabilities` reports, shown as the server reports it, plus
 * the loading and fault states.
 */
import type { StorageCapabilities } from '@lostgradient/storage';
import { render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { requireElement } from '../../../tests/dom.test-support.ts';
import CapabilitiesPanel from './capabilities-panel.svelte';

const supportedEverything: StorageCapabilities = {
  persistence: 'local',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  boundedRangeDelete: true,
};

/** The text of the `<dd>` paired with the `<dt>` named `term`. */
function definitionFor(container: HTMLElement, term: string): HTMLElement {
  const termElement = within(container).getByText(term);
  expect(termElement.tagName).toBe('DT');
  const definition = termElement.nextElementSibling;
  if (!definition) throw new Error(`No definition for ${term}`);
  return requireElement(definition, HTMLElement);
}

describe('CapabilitiesPanel', () => {
  test('shows all six reported capabilities', () => {
    const { container } = render(CapabilitiesPanel, {
      props: { capabilities: supportedEverything, loading: false, error: null },
    });
    const root = requireElement(container, HTMLElement);

    expect(definitionFor(root, 'Persistence').textContent).toContain('local');
    expect(definitionFor(root, 'Read after write').textContent).toContain('linearizable');
    expect(definitionFor(root, 'Scan consistency').textContent).toContain('snapshot');
    expect(definitionFor(root, 'Atomic batch').textContent).toContain('supported');
    expect(definitionFor(root, 'Conditional batch').textContent).toContain('supported');
    expect(definitionFor(root, 'Bounded range delete').textContent).toContain('supported');
  });

  test('a capability reported as supported reads "supported"', () => {
    const { container } = render(CapabilitiesPanel, {
      props: { capabilities: supportedEverything, loading: false, error: null },
    });
    const definition = definitionFor(requireElement(container, HTMLElement), 'Conditional batch');

    expect(within(definition).getByText('supported')).not.toBeNull();
    expect(within(definition).queryByText('not supported')).toBeNull();
  });

  test('a capability reported as unsupported reads "not supported"', () => {
    const { container } = render(CapabilitiesPanel, {
      props: {
        capabilities: {
          ...supportedEverything,
          persistence: 'ephemeral',
          conditionalBatch: false,
          boundedRangeDelete: false,
        },
        loading: false,
        error: null,
      },
    });
    const root = requireElement(container, HTMLElement);

    expect(
      within(definitionFor(root, 'Conditional batch')).getByText('not supported'),
    ).not.toBeNull();
    expect(
      within(definitionFor(root, 'Bounded range delete')).getByText('not supported'),
    ).not.toBeNull();
    expect(within(definitionFor(root, 'Atomic batch')).getByText('supported')).not.toBeNull();
    expect(definitionFor(root, 'Persistence').textContent).toContain('ephemeral');
  });

  test('shows a loading status while the capabilities are being read', () => {
    const { getByRole, queryByText } = render(CapabilitiesPanel, {
      props: { capabilities: undefined, loading: true, error: null },
    });

    expect(getByRole('status', { name: 'Loading storage capabilities' })).not.toBeNull();
    expect(queryByText('Conditional batch')).toBeNull();
  });

  test('shows the fault, and no capability rows, when the read failed', () => {
    const { getByRole, queryByText } = render(CapabilitiesPanel, {
      props: { capabilities: undefined, loading: false, error: new Error('boom') },
    });

    expect(getByRole('alert')).not.toBeNull();
    expect(queryByText('Conditional batch')).toBeNull();
  });

  test('no longer points at the retired upstream issue', () => {
    const { queryByRole } = render(CapabilitiesPanel, {
      props: { capabilities: supportedEverything, loading: false, error: null },
    });

    expect(queryByRole('link', { name: /weft#727/ })).toBeNull();
  });
});
