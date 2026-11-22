import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import { AUTHORIZATION_SCOPES, type Principal } from '../../../../lib/scopes.svelte.ts';
import { confirmFork, forkOperations, previewAnswer } from './fork-comparison.test-support.ts';
import ForkDialogHarness from './fork-dialog.test-harness.svelte';

function allScopesPrincipal(): Principal {
  return { scopes: AUTHORIZATION_SCOPES, unauthenticatedAccess: null };
}

/** Holds `workflows:write`, which the fork needs, but not the `workflows:read` the revision listing needs. */
function deniedPrincipal(): Principal {
  return { scopes: ['workflows:write'], unauthenticatedAccess: null };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function installedRevisionRecord(revision: string, installedAt: number) {
  return {
    manifest: { manifestVersion: 1, name: 'order-processing', workflowVersion: '1.0.0', revision },
    installedAt,
  };
}

function baseClient(
  overrides: {
    fork?: (id: string, options?: unknown) => Promise<{ readonly id: string }>;
    revisionsList?: () => Promise<unknown>;
  } = {},
) {
  return {
    fork: overrides.fork ?? (async () => ({ id: 'wf-forked-1' })),
    operations: {
      'weft.workflows.revisions.list':
        overrides.revisionsList ??
        (async () => [
          installedRevisionRecord('order-processing-rev-a', 1_000),
          installedRevisionRecord('order-processing-rev-b', 2_000),
        ]),
    },
  };
}

describe('ForkDialog', () => {
  test('default state says it retains the source run’s own revision for a run with a persisted source revision', async () => {
    const { getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(getByText(/^Retains/)).not.toBeNull();
  });

  test('states the fork worker-binding inheritance rule (COR-164)', async () => {
    const { getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(getByText('Worker version for a fork')).not.toBeNull();
    expect(getByText(/unless it names an explicit revision that differs/)).not.toBeNull();
  });

  test("qualifies the default retention promise as a snapshot, not a guarantee (Codex review, PR #978, round 5) — sourceRevision is threaded from the detail page's own fetch, which can be stale by the time the operator submits", async () => {
    const { getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(getByText(/as last loaded here/)).not.toBeNull();
  });

  test('refetches the source run on open and reflects a revision that changed since the page loaded, keeping the snapshot disclosure (COR-15)', async () => {
    const requestedIds: string[] = [];
    const client = {
      ...baseClient(),
      get: async (id: string) => {
        requestedIds.push(id);
        return { revision: 'order-processing-rev-replacement' };
      },
    };

    const { getByText, queryByText } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    // The revision is in the tooltip, in full, never printed as a label.
    await waitFor(() => {
      expect(getByText(/as last loaded: order-processing-rev-replacement\./)).not.toBeNull();
    });
    expect(queryByText(/as last loaded: order-processing-rev-current\./)).toBeNull();
    expect(requestedIds).toEqual(['wf-1']);
    // The refetch is added ON TOP of the snapshot disclosure, not instead of it.
    expect(getByText(/as last loaded here/)).not.toBeNull();
  });

  test('falls back to the page-load revision when the open-time refetch finds the run purged or fails (COR-15)', async () => {
    for (const outcome of ['purged', 'fails'] as const) {
      let calls = 0;
      const queryClient = newQueryClient();
      const { getByText, unmount } = render(ForkDialogHarness, {
        props: {
          client: {
            ...baseClient(),
            get: async () => {
              calls += 1;
              if (outcome === 'fails') throw new Error('network down');
              return null;
            },
          },
          workflowId: 'wf-1',
          initialStep: 3,
          workflowType: 'order-processing',
          sourceRevision: 'order-processing-rev-current',
          principal: allScopesPrincipal(),
          queryClient,
        },
      });
      // The refetch settles (no fetch left in flight) before asserting the fallback held.
      await waitFor(() => expect(calls).toBe(1));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(getByText(/as last loaded: order-processing-rev-current\./)).not.toBeNull();
      unmount();
    }
  });

  test('an unpinned page-load source picks up a revision persisted since (COR-15)', async () => {
    const client = { ...baseClient(), get: async () => ({ revision: 'order-processing-rev-new' }) };

    const { getByText } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: undefined,
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await waitFor(() => {
      expect(getByText(/^Retains/)).not.toBeNull();
    });
  });

  test('default state shows the unpinned-legacy variant when sourceRevision is undefined', async () => {
    const { getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: undefined,
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(getByText(/^Unpinned source/)).not.toBeNull();
  });

  test('the unpinned-legacy variant does NOT promise the catalog-active revision (Codex review, PR #978, round 3): it says the revision can be a different one', async () => {
    const { getByText, queryByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: undefined,
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    expect(
      getByText(/It usually follows the active revision, but it can be a different one/),
    ).not.toBeNull();
    expect(
      queryByText(/resolves normally against\s*whichever revision is currently active/),
    ).toBeNull();
  });

  test('the picker disclosure lists installed revisions when workflows:read is granted', async () => {
    const { getByRole, getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));

    // Full revision ids, not a truncated form — two installed revisions
    // could otherwise share the same displayed prefix/suffix and be
    // indistinguishable before selection (Codex review, PR #978).
    await waitFor(() => {
      expect(getByText(/order-processing-rev-a/)).not.toBeNull();
      expect(getByText(/order-processing-rev-b/)).not.toBeNull();
    });
  });

  test('the picker degrades to a free-text input with an explanatory note when workflows:read is denied', async () => {
    const { getByRole, getByText } = render(ForkDialogHarness, {
      props: {
        client: baseClient(),
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: deniedPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));

    await waitFor(() => {
      expect(getByRole('textbox', { name: 'Revision ID' })).not.toBeNull();
      expect(getByText(/don't have permission to list installed revisions/)).not.toBeNull();
    });
  });

  test('the picker also degrades to the free-text fallback when the listing itself comes back 403, even though the principal store still says workflows:read is granted (Codex review, PR #978, round 3)', async () => {
    // Simulates a scope revoked server-side after principal bootstrap:
    // client-side `readGate.disabled` stays false, but the actual request
    // is rejected. `weft.workflows.fork` itself is public, so this must not
    // be a dead end — the same free-text degrade as an already-known denial.
    const client = baseClient({
      revisionsList: async () => {
        throw new HttpClientError(403, 'workflows:read required', { faultCode: 'Forbidden' });
      },
    });

    const { getByRole, getByText, queryByText } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));

    await waitFor(() => {
      expect(getByRole('textbox', { name: 'Revision ID' })).not.toBeNull();
      expect(getByText(/don't have permission to list installed revisions/)).not.toBeNull();
    });
    expect(queryByText('Could not load the list of installed revisions.')).toBeNull();
  });

  test('a non-Forbidden query failure still shows the generic "could not load" error, not the free-text fallback', async () => {
    const client = baseClient({
      revisionsList: async () => {
        throw new HttpClientError(500, 'internal engine failure', { faultCode: 'EngineFailure' });
      },
    });

    const { getByRole, getByText, queryByRole } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: allScopesPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));

    await waitFor(() => {
      expect(getByText('Could not load the list of installed revisions.')).not.toBeNull();
    });
    expect(queryByRole('textbox', { name: 'Revision ID' })).toBeNull();
  });

  test('disables Create fork for a principal without workflows:write, which weft.workflows.fork requires', async () => {
    const forkCalls: unknown[] = [];
    const client = baseClient({
      fork: async (_id, options) => {
        forkCalls.push(options);
        return { id: 'wf-forked-1' };
      },
    });

    const { getByRole } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: { scopes: ['workflows:read'], unauthenticatedAccess: null },
        queryClient: newQueryClient(),
      },
    });

    const create = getByRole('button', { name: 'Create fork' });
    expect(create.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(create);
    expect(forkCalls).toEqual([]);
  });

  test('submitting with an explicit revision passes {fromStep, revision} to client.fork', async () => {
    const forkCalls: unknown[] = [];
    const client = baseClient({
      fork: async (_id, options) => {
        forkCalls.push(options);
        return { id: 'wf-forked-1' };
      },
    });

    const { getByRole } = render(ForkDialogHarness, {
      props: {
        client,
        workflowId: 'wf-1',
        initialStep: 3,
        workflowType: 'order-processing',
        sourceRevision: 'order-processing-rev-current',
        principal: deniedPrincipal(),
        queryClient: newQueryClient(),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));
    const input = getByRole('textbox', { name: 'Revision ID' });
    await fireEvent.input(input, { target: { value: 'order-processing-rev-explicit' } });
    await confirmFork(getByRole);

    await waitFor(() => {
      expect(forkCalls).toEqual([{ fromStep: 3, revision: 'order-processing-rev-explicit' }]);
    });
  });
});

describe('ForkDialog fork preview (COR-2538)', () => {
  type PreviewInput = {
    workflowId: string;
    fromStep?: unknown;
    revision?: string;
    dryRun?: boolean;
  };

  function previewClient(
    answer: (input: PreviewInput) => Promise<ReturnType<typeof previewAnswer>>,
    calls: PreviewInput[],
  ) {
    const client = baseClient();
    return {
      ...client,
      operations: {
        ...client.operations,
        ...forkOperations({
          fork: async (input) => {
            calls.push(input);
            return answer(input);
          },
        }),
      },
    };
  }

  function props(client: ReturnType<typeof previewClient>, principal = allScopesPrincipal()) {
    return {
      client,
      workflowId: 'wf-1',
      initialStep: 3,
      workflowType: 'order-processing',
      sourceRevision: 'order-processing-rev-current',
      principal,
      queryClient: newQueryClient(),
    };
  }

  test('shows the kept and re-run steps the server answered, and enables Create fork only once it has', async () => {
    const held = Promise.withResolvers<ReturnType<typeof previewAnswer>>();
    const calls: PreviewInput[] = [];
    const { getByRole, getByText, container } = render(ForkDialogHarness, {
      props: props(previewClient(() => held.promise, calls)),
    });

    expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(true);
    await waitFor(() => expect(calls).toEqual([{ workflowId: 'wf-1', fromStep: 3, dryRun: true }]));
    expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(true);

    held.resolve(
      previewAnswer({
        keptSteps: [
          { index: 0, operationType: 'activity', label: 'reserveStock', status: 'completed' },
          { index: 1, operationType: 'activity', label: 'chargeCard', status: 'completed' },
        ],
        rerunSteps: [
          { index: 2, operationType: 'activity', label: 'issueTicket', status: 'completed' },
        ],
      }),
    );

    await waitFor(() => expect(getByText('Kept, not run again (2)')).not.toBeNull());
    expect(getByText('Run again (1)')).not.toBeNull();
    expect(
      [...container.querySelectorAll('[data-fork-preview-kept] li')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Step 1, reserveStock', 'Step 2, chargeCard']);
    expect(
      [...container.querySelectorAll('[data-fork-preview-rerun] li')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Step 3, issueTicket']);
    await waitFor(() =>
      expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(false),
    );
  });

  test('asks again when the step changes, and does not offer the old answer for the new step', async () => {
    const calls: PreviewInput[] = [];
    const second = Promise.withResolvers<ReturnType<typeof previewAnswer>>();
    const { getByRole, getByLabelText, getByText, queryByText } = render(ForkDialogHarness, {
      props: props(
        previewClient(
          (input) =>
            input.fromStep === 1
              ? second.promise
              : Promise.resolve(
                  previewAnswer({
                    keptSteps: [],
                    rerunSteps: [
                      {
                        index: 0,
                        operationType: 'activity',
                        label: 'reserveStock',
                        status: 'completed',
                      },
                    ],
                  }),
                ),
          calls,
        ),
      ),
    });

    await waitFor(() => expect(getByText('Run again (1)')).not.toBeNull());

    await fireEvent.input(getByLabelText('Target step'), { target: { value: '1' } });

    await waitFor(() => expect(calls.map((call) => call.fromStep)).toEqual([3, 1]));
    // The answer for step 3 is gone while step 1's is pending, so Create fork cannot confirm it.
    expect(queryByText('Run again (1)')).toBeNull();
    expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(true);

    second.resolve(
      previewAnswer({
        forkPoint: 1,
        keptSteps: [],
        rerunSteps: [
          { index: 0, operationType: 'activity', label: 'reserveStock', status: 'completed' },
          { index: 1, operationType: 'activity', label: 'issueTicket', status: 'completed' },
        ],
      }),
    );
    await waitFor(() => expect(getByText('Run again (2)')).not.toBeNull());
    await waitFor(() =>
      expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(false),
    );
  });

  test('asks again with the revision the operator typed', async () => {
    const calls: PreviewInput[] = [];
    const { getByRole } = render(ForkDialogHarness, {
      props: props(
        previewClient(async () => previewAnswer({ revisionWouldChange: true }), calls),
        deniedPrincipal(),
      ),
    });
    await waitFor(() => expect(calls).toHaveLength(1));

    await fireEvent.click(getByRole('button', { name: 'Fork a different revision' }));
    await fireEvent.input(getByRole('textbox', { name: 'Revision ID' }), {
      target: { value: 'order-processing-rev-explicit' },
    });

    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        workflowId: 'wf-1',
        fromStep: 3,
        revision: 'order-processing-rev-explicit',
        dryRun: true,
      }),
    );
  });

  test('says when the fork would run on a different revision, in a warning Callout, and says the revision once', async () => {
    const calls: PreviewInput[] = [];
    const { getByText, container, queryByText } = render(ForkDialogHarness, {
      props: props(
        previewClient(
          async () =>
            previewAnswer({
              revisionWouldChange: true,
              sourceRevision: 'rev-source',
              forkRevision: 'rev-fork',
            }),
          calls,
        ),
      ),
    });

    await waitFor(() =>
      expect(
        getByText('The fork would run on a different revision than the source run.'),
      ).not.toBeNull(),
    );
    const callout = container.querySelector('.cinder-callout[data-cinder-variant="warning"]');
    expect(callout?.textContent).toContain('Runs on a different revision');
    // No revision id is printed, and the "Retains…" line is not a second statement beside it.
    expect(container.textContent).not.toContain('rev-source');
    expect(container.textContent).not.toContain('rev-fork');
    expect(queryByText(/^Retains/)).toBeNull();
  });

  test('keeps the "Retains…" line, and adds no second statement, when the revision would not change', async () => {
    const calls: PreviewInput[] = [];
    const { getByText, container } = render(ForkDialogHarness, {
      props: props(previewClient(async () => previewAnswer(), calls)),
    });

    await waitFor(() => expect(container.querySelector('[data-fork-preview-kept]')).not.toBeNull());
    // The line is one sentence with no revision in it; the full revision is the tooltip's.
    expect(getByText(/^Retains the source run's own revision/).textContent).not.toContain('rev-');
    expect(container.querySelector('.cinder-callout[data-cinder-variant="warning"]')).toBeNull();
    expect(container.textContent).not.toContain('same revision as the source');
  });

  test('a refused preview shows the revision conflict as a Callout and leaves Create fork disabled', async () => {
    const calls: PreviewInput[] = [];
    const { getByRole, getByText, container } = render(ForkDialogHarness, {
      props: props(
        previewClient(async () => {
          throw new HttpClientError(409, 'revision not registered', {
            faultCode: 'Conflict',
            weftCode: 'WorkflowRevisionUnavailableError',
          });
        }, calls),
      ),
    });

    await waitFor(() => expect(getByText('Revision unavailable')).not.toBeNull());
    // In the person's words: the engine's own text ("revision not registered") is never shown.
    expect(getByText(/isn’t loaded, so the fork can’t run on it/)).not.toBeNull();
    expect(container.textContent).not.toContain('revision not registered');
    expect(container.textContent).not.toMatch(/this process/i);
    // Still announced as an alert, drawn by Cinder's Callout rather than a bordered box of its own.
    const alert = getByRole('alert');
    expect(alert.querySelector('.cinder-callout[data-cinder-variant="warning"]')).not.toBeNull();
    expect(container.querySelector('.weft-fork-dialog__conflict')).toBeNull();
    expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(true);
  });

  test('draws no box around the preview, a normal-width Create fork, and names no field of the record', async () => {
    const calls: PreviewInput[] = [];
    const { getByRole, container } = render(ForkDialogHarness, {
      props: props(previewClient(async () => previewAnswer(), calls)),
    });

    await waitFor(() => expect(container.querySelector('[data-fork-preview-kept]')).not.toBeNull());
    const preview = container.querySelector('[data-fork-preview]');
    expect(preview).not.toBeNull();
    // A box is a border or a fill; the preview's rule has neither, so no box sits inside the dialog's.
    const source = await Bun.file(new URL('./fork-dialog.svelte', import.meta.url)).text();
    const rule = /\.weft-fork-dialog__preview \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/border|background|padding/);
    expect(
      getByRole('button', { name: 'Create fork' }).hasAttribute('data-cinder-full-width'),
    ).toBe(false);
    expect(container.textContent).not.toContain('forkedFrom');
    expect(container.querySelector('code')).toBeNull();
  });

  test('names the fork by its workflow and when it started, links to its id, and prints no id', async () => {
    const { getByRole, getByText, container } = render(ForkDialogHarness, {
      props: props(previewClient(async () => previewAnswer(), [])),
    });
    await waitFor(() =>
      expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(false),
    );

    await fireEvent.click(getByRole('button', { name: 'Create fork' }));

    await waitFor(() => expect(getByText(/^Forked as/)).not.toBeNull());
    const link = getByRole('link', { name: 'order-processing' });
    expect(link.getAttribute('href')).toContain('wf-forked-1');
    expect(container.textContent).toContain('started just now');
    expect(container.textContent).not.toContain('wf-forked-1');
  });

  test('asks nothing for a step that is not a number, and for a principal that may not fork', async () => {
    const calls: PreviewInput[] = [];
    const { getByLabelText } = render(ForkDialogHarness, {
      props: props(previewClient(async () => previewAnswer(), calls)),
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    await fireEvent.input(getByLabelText('Target step'), { target: { value: 'abc' } });
    expect(calls).toHaveLength(1);

    const readOnly: PreviewInput[] = [];
    render(ForkDialogHarness, {
      props: props(
        previewClient(async () => previewAnswer(), readOnly),
        {
          scopes: ['workflows:read'],
          unauthenticatedAccess: null,
        },
      ),
    });
    expect(readOnly).toEqual([]);
  });
});
