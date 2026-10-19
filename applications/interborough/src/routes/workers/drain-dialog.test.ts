import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import DrainDialog from './drain-dialog.svelte';

describe('DrainDialog', () => {
  test('worker target: shows the worker id and calls onDrain with a trimmed reason', async () => {
    const drained: (string | undefined)[] = [];
    const { getByText, getByLabelText, getByRole } = render(DrainDialog, {
      props: {
        open: true,
        target: { kind: 'worker', id: 'wkr_1' },
        submitting: false,
        onDrain: (reason) => drained.push(reason),
        onCancel: () => {},
      },
    });

    expect(getByText('wkr_1')).not.toBeNull();

    await fireEvent.input(getByLabelText('Reason'), { target: { value: '  rolling deploy  ' } });
    await fireEvent.click(getByRole('button', { name: 'Drain worker' }));

    expect(drained).toEqual(['rolling deploy']);
  });

  test('an empty/whitespace-only reason is passed as undefined', async () => {
    const drained: (string | undefined)[] = [];
    const { getByRole } = render(DrainDialog, {
      props: {
        open: true,
        target: { kind: 'worker', id: 'wkr_1' },
        submitting: false,
        onDrain: (reason) => drained.push(reason),
        onCancel: () => {},
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Drain worker' }));
    expect(drained).toEqual([undefined]);
  });

  test('deployment target: shows the deployment name and the deployment-specific title', async () => {
    const { getByText, getByRole } = render(DrainDialog, {
      props: {
        open: true,
        target: { kind: 'deployment', name: 'api-prod' },
        submitting: false,
        onDrain: () => {},
        onCancel: () => {},
      },
    });

    expect(getByText('api-prod')).not.toBeNull();
    expect(getByRole('button', { name: 'Drain deployment' })).not.toBeNull();
  });

  test('Cancel calls onCancel', async () => {
    let cancelled = false;
    const { getByRole } = render(DrainDialog, {
      props: {
        open: true,
        target: { kind: 'worker', id: 'wkr_1' },
        submitting: false,
        onDrain: () => {},
        onCancel: () => (cancelled = true),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(cancelled).toBe(true);
  });

  test('build target: names the deployment and build and drains with that title', async () => {
    const drained: (string | undefined)[] = [];
    const { getByText, getByRole } = render(DrainDialog, {
      props: {
        open: true,
        target: { kind: 'build', deploymentName: 'billing', buildId: 'build-7' },
        submitting: false,
        onDrain: (reason) => drained.push(reason),
        onCancel: () => {},
      },
    });

    expect(getByText('billing/build-7')).not.toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Drain build' }));
    expect(drained).toEqual([undefined]);
  });

  test.each(['current', 'ramping'] as const)(
    'a %s build warns that new policy-bearing starts will be refused while it drains',
    (routingRole) => {
      const { getByRole } = render(DrainDialog, {
        props: {
          open: true,
          target: { kind: 'build', deploymentName: 'api-prod', buildId: 'build-b' },
          routingRole,
          submitting: false,
          onDrain: () => {},
          onCancel: () => {},
        },
      });
      const warning = getByRole('note');
      expect(warning.textContent).toContain(routingRole);
      expect(warning.textContent).toContain('refuse');
    },
  );

  test('a build that routing does not name shows no such warning', () => {
    const { queryByRole } = render(DrainDialog, {
      props: {
        open: true,
        target: { kind: 'build', deploymentName: 'api-prod', buildId: 'build-a' },
        routingRole: 'none',
        submitting: false,
        onDrain: () => {},
        onCancel: () => {},
      },
    });
    expect(queryByRole('note')?.textContent ?? null).toBeNull();
  });
});
