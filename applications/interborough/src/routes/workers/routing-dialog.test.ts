import { HttpClientError } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { PreviewResult, RoutingAction, RoutingChange } from './deployments-data.ts';
import { routing, version } from './deployments-test-support.test-support.ts';
import RoutingDialog, { type RoutingDialogRequest } from './routing-dialog.svelte';

const VERSIONS = [
  version('build-a'),
  version('build-b'),
  version('build-c', { state: 'draining' }),
];

function setup(
  request: RoutingDialogRequest,
  handlers: {
    preview?: (change: RoutingChange) => Promise<PreviewResult>;
    apply?: (action: RoutingAction, expectedGeneration: number) => Promise<unknown>;
  } = {},
) {
  const log: string[] = [];
  const previewed: RoutingChange[] = [];
  const applied: { action: RoutingAction; expectedGeneration: number }[] = [];
  const view = render(RoutingDialog, {
    props: {
      open: true,
      request,
      versions: VERSIONS,
      initial: {
        currentBuildId: routing().currentBuildId,
        rampingBuildId: undefined,
        rampBasisPoints: 0,
      },
      onPreview:
        handlers.preview ??
        (async (change: RoutingChange) => {
          previewed.push(change);
          return { valid: true, message: 'Routing targets are available.', currentGeneration: 3 };
        }),
      onApply:
        handlers.apply ??
        (async (action: RoutingAction, expectedGeneration: number) => {
          applied.push({ action, expectedGeneration });
        }),
      onApplied: () => log.push('applied'),
      onClose: () => log.push('closed'),
    },
  });
  return { ...view, log, previewed, applied };
}

describe('RoutingDialog — promote and rollback', () => {
  test('previews first, asks for confirmation, and applies with the previewed generation', async () => {
    const { findByRole, findByText, getByRole, previewed, applied, log } = setup({
      kind: 'promote',
      deploymentName: 'billing',
      buildId: 'build-b',
    });

    // Opening previews; nothing is applied yet.
    expect(await findByText('Routing targets are available.')).not.toBeNull();
    expect(previewed).toEqual([
      { deploymentName: 'billing', currentBuildId: 'build-b', rampBasisPoints: 10_000 },
    ]);
    expect(applied).toEqual([]);
    expect(await findByText(/applies against routing generation 3/)).not.toBeNull();

    await fireEvent.click(await findByRole('button', { name: 'Confirm promote build' }));

    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual({
      action: { kind: 'promote', deploymentName: 'billing', buildId: 'build-b' },
      expectedGeneration: 3,
    });
    expect(log).toEqual(['applied']);
    expect(getByRole).toBeDefined();
  });

  test('a rollback is previewed and confirmed the same way', async () => {
    const { findByRole, applied } = setup({
      kind: 'rollback',
      deploymentName: 'billing',
      buildId: 'build-a',
    });
    await fireEvent.click(await findByRole('button', { name: 'Confirm roll back to build' }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]?.action.kind).toBe('rollback');
  });

  test('a pointer that moved after the preview is named as stale, applies nothing, and offers a fresh preview', async () => {
    let previews = 0;
    const { findByRole, findByText, log } = setup(
      { kind: 'promote', deploymentName: 'billing', buildId: 'build-b' },
      {
        preview: async () => {
          previews += 1;
          return { valid: true, message: 'ok', currentGeneration: 3 + previews };
        },
        apply: async () => {
          throw new HttpClientError(409, 'changed', {
            data: { reason: 'stale-generation', currentGeneration: 9 },
          });
        },
      },
    );
    await fireEvent.click(await findByRole('button', { name: 'Confirm promote build' }));

    expect(
      await findByText(
        /Routing changed since you previewed it: the pointer is now at generation 9/,
      ),
    ).not.toBeNull();
    expect(log).toEqual([]);

    await fireEvent.click(await findByRole('button', { name: 'Preview again' }));
    expect(await findByText(/applies against routing generation 5/)).not.toBeNull();
    expect(previews).toBe(2);
  });

  test('any other fault is shown as that fault, not as a stale generation', async () => {
    const { findByRole, findByText, queryByText } = setup(
      { kind: 'promote', deploymentName: 'billing', buildId: 'build-b' },
      {
        apply: async () => {
          throw new HttpClientError(409, 'Build is draining, so it is not eligible for routing.', {
            data: { reason: 'version-not-ready' },
          });
        },
      },
    );
    await fireEvent.click(await findByRole('button', { name: 'Confirm promote build' }));
    expect(
      await findByText('Build is draining, so it is not eligible for routing.'),
    ).not.toBeNull();
    expect(queryByText(/Routing changed since you previewed it/)).toBeNull();
  });

  test('a preview that fails never reaches confirmation', async () => {
    const { findByText, queryByRole, applied } = setup(
      { kind: 'promote', deploymentName: 'billing', buildId: 'build-b' },
      {
        preview: async () => {
          throw new HttpClientError(404, 'Deployment build billing/build-b does not exist.');
        },
      },
    );
    expect(await findByText('Deployment build billing/build-b does not exist.')).not.toBeNull();
    expect(queryByRole('button', { name: /^Confirm/ })).toBeNull();
    expect(applied).toEqual([]);
  });
});

describe('RoutingDialog — set routing', () => {
  test('starts from the pointer, previews the chosen change, and applies it with the previewed generation', async () => {
    const { findByRole, getByLabelText, previewed, applied } = setup({
      kind: 'setrouting',
      deploymentName: 'billing',
    });

    // Only ready builds are offered.
    const current = getByLabelText('Current build') as HTMLSelectElement;
    expect(Array.from(current.options).map((option) => option.value)).toEqual([
      'build-a',
      'build-b',
    ]);
    expect(previewed).toEqual([]);

    await fireEvent.change(current, { target: { value: 'build-a' } });
    await fireEvent.change(getByLabelText('Ramping build'), { target: { value: 'build-b' } });
    // The field commits on blur, as it does when the operator tabs or clicks to the next control.
    const share = getByLabelText('Traffic to the ramping build');
    await fireEvent.input(share, { target: { value: '12.5' } });
    await fireEvent.blur(share);
    await fireEvent.click(await findByRole('button', { name: 'Preview change' }));

    await waitFor(() => expect(previewed).toHaveLength(1));
    expect(previewed[0]).toEqual({
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampingBuildId: 'build-b',
      rampBasisPoints: 1_250,
    });
    expect(applied).toEqual([]);

    await fireEvent.click(await findByRole('button', { name: 'Confirm set routing' }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toMatchObject({ action: { kind: 'setrouting' }, expectedGeneration: 3 });
  });

  test('will not preview a ramping build equal to the current build', async () => {
    const { findByRole, getByLabelText, findByText } = setup({
      kind: 'setrouting',
      deploymentName: 'billing',
    });
    await fireEvent.change(getByLabelText('Ramping build'), { target: { value: 'build-a' } });
    expect(
      await findByText('The ramping build must differ from the current build.'),
    ).not.toBeNull();
    const preview = await findByRole('button', { name: 'Preview change' });
    expect(preview.hasAttribute('disabled')).toBe(true);
  });
});

describe('RoutingDialog — one invocation at a time', () => {
  test('a slow preview from a closed session never replaces the next session, so confirm applies the build shown', async () => {
    let releaseFirst!: (result: PreviewResult) => void;
    const slowFirst = new Promise<PreviewResult>((resolve) => {
      releaseFirst = resolve;
    });
    const applied: { action: RoutingAction; expectedGeneration: number }[] = [];
    const view = render(RoutingDialog, {
      props: {
        open: true,
        request: { kind: 'promote', deploymentName: 'billing', buildId: 'build-a' },
        versions: VERSIONS,
        initial: {},
        onPreview: async (change: RoutingChange) =>
          change.currentBuildId === 'build-a'
            ? slowFirst
            : { valid: true, message: `Ready for ${change.currentBuildId}.`, currentGeneration: 8 },
        onApply: async (action: RoutingAction, expectedGeneration: number) => {
          applied.push({ action, expectedGeneration });
        },
        onApplied: () => {},
        onClose: () => {},
      },
    });

    // Close the first dialog while its preview is still running, then open it for another build.
    await view.rerender({ open: false });
    await view.rerender({
      open: true,
      request: { kind: 'promote', deploymentName: 'billing', buildId: 'build-b' },
    });
    expect(await view.findByText('Ready for build-b.')).not.toBeNull();

    // The first preview finishes late, with its own generation and message.
    releaseFirst({ valid: true, message: 'Ready for build-a.', currentGeneration: 99 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.queryByText('Ready for build-a.')).toBeNull();
    expect(view.getByText('Ready for build-b.')).not.toBeNull();
    await fireEvent.click(await view.findByRole('button', { name: 'Confirm promote build' }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual({
      action: { kind: 'promote', deploymentName: 'billing', buildId: 'build-b' },
      expectedGeneration: 8,
    });
  });
});
