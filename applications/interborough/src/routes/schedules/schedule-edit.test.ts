import { requireElement } from '../../../tests/dom.test-support.ts';

/**
 * Component tests for `<ScheduleEdit>` against a REAL in-process weft
 * server.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  buildWorkflowContract,
  deriveWorkflowRevision,
  HttpClient,
  normalizeWorkflowContract,
  workflow,
  workflowSource,
} from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import ScheduleEditHarness from './schedule-edit-test-harness.test-harness.svelte';
import { scheduleDetailQueryKey } from './schedule-queries.ts';

describe('ScheduleEdit', () => {
  test('changing revisionPolicy from active-at-fire to pinned and saving sends the new value (WFT-117)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'to-be-pinned',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'to-be-pinned',
          onClose: () => (closed = true),
        },
      });

      await waitFor(() => getByRole('radio', { name: 'Active at fire' }));
      await fireEvent.click(getByRole('radio', { name: 'Pinned' }));
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      const after = await server.engine.getSchedule('to-be-pinned');
      expect(after?.revisionPolicy).toBe('pinned');
    } finally {
      await server.stop();
    }
  });

  test('a background refetch that swaps `form` mid-edit does not leak the stale revisionPolicy draft onto the new form (Codex review, PR #978, round 2)', async () => {
    // Reproduces the exact race the finding described: an external actor
    // (e.g. the System route's Activate flow) changes the schedule's
    // `revisionPolicy` on the server WHILE this drawer is open; a refetch
    // of `editDetailQuery` then reconstructs `form` as a brand-new
    // `ScheduleFormState` carrying the externally-updated value. Before the
    // `{#key form}` fix, `schedule-form-fields.svelte`'s one-shot draft
    // would have kept the OLD 'active-at-fire' value and silently written
    // it back into the new form, so a subsequent unrelated save would have
    // reverted the external pin. This proves it doesn't.
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'externally-pinned',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    let queryClient: QueryClient | undefined;
    try {
      const { getByRole } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'externally-pinned',
          onClose: () => (closed = true),
          onQueryClient: (qc) => (queryClient = qc),
        },
      });

      await waitFor(() => {
        const radio = requireElement(
          getByRole('radio', { name: 'Active at fire' }),
          HTMLInputElement,
        );
        expect(radio.checked).toBe(true);
      });

      // Out-of-band change: NOT through this drawer's own form submission.
      await server.engine.updateSchedule('externally-pinned', '0 2 * * *', {
        revisionPolicy: 'pinned',
      });
      if (queryClient === undefined) throw new Error('queryClient was never captured');
      await queryClient.invalidateQueries({
        queryKey: scheduleDetailQueryKey('externally-pinned'),
      });

      await waitFor(() => {
        const radio = requireElement(getByRole('radio', { name: 'Pinned' }), HTMLInputElement);
        expect(radio.checked).toBe(true);
      });

      // An unrelated save after the refetch — must not resend the OLD draft.
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      const after = await server.engine.getSchedule('externally-pinned');
      expect(after?.revisionPolicy).toBe('pinned');
    } finally {
      await server.stop();
    }
  });

  test('a background refetch with changed server data does not discard an unsaved revisionPolicy edit, refuses to save it over the changed schedule, and starts over on request (COR-15)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'mid-edit',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    let queryClient: QueryClient | undefined;
    try {
      const { getByRole, getByTestId } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'mid-edit',
          onClose: () => (closed = true),
          onQueryClient: (qc) => (queryClient = qc),
        },
      });

      const pinned = await waitFor(() => getByRole('radio', { name: 'Pinned' }));
      await fireEvent.click(pinned);
      expect(requireElement(pinned, HTMLInputElement).checked).toBe(true);

      // Another operator edits the description: `updatedAt` moves, so the
      // refetch delivers a genuinely different `ScheduleSummary` object.
      await server.engine.updateSchedule('mid-edit', '0 2 * * *', {
        description: 'edited elsewhere',
      });
      if (queryClient === undefined) throw new Error('queryClient was never captured');
      await queryClient.invalidateQueries({ queryKey: scheduleDetailQueryKey('mid-edit') });
      await waitFor(() => {
        const cached = queryClient?.getQueryData<{ description?: string }>(
          scheduleDetailQueryKey('mid-edit'),
        );
        expect(cached?.description).toBe('edited elsewhere');
      });

      // The operator's unsaved change survives the refetch.
      expect(requireElement(getByRole('radio', { name: 'Pinned' }), HTMLInputElement).checked).toBe(
        true,
      );

      // The schedule changed after the draft was built, so saving it is refused and writes nothing.
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      const notice = await waitFor(() => getByTestId('schedule-notice'));
      expect(notice.getAttribute('data-notice')).toBe('stale');
      expect(closed).toBe(false);
      const refused = await server.engine.getSchedule('mid-edit');
      expect(refused?.revisionPolicy).toBe('active-at-fire');
      expect(requireElement(getByRole('radio', { name: 'Pinned' }), HTMLInputElement).checked).toBe(
        true,
      );

      // Starting over builds the draft from the schedule as it is now, and that saves.
      await fireEvent.click(getByRole('button', { name: 'Start over from the current schedule' }));
      await waitFor(() =>
        expect(
          requireElement(getByRole('textbox', { name: 'Description' }), HTMLInputElement).value,
        ).toBe('edited elsewhere'),
      );
      expect(requireElement(getByRole('radio', { name: 'Pinned' }), HTMLInputElement).checked).toBe(
        false,
      );
      await fireEvent.click(getByRole('radio', { name: 'Pinned' }));
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));
      const after = await server.engine.getSchedule('mid-edit');
      expect(after?.revisionPolicy).toBe('pinned');
    } finally {
      await server.stop();
    }
  });

  test('a background refetch after the schedule fires does not discard an unsaved cadence-only edit, and the edit still saves (COR-15 review)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'cadence-edit',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    let queryClient: QueryClient | undefined;
    try {
      const { container, getByRole } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'cadence-edit',
          onClose: () => (closed = true),
          onQueryClient: (qc) => (queryClient = qc),
        },
      });

      // Edit ONLY the cadence: `0 2 * * *` opens as Every day, and At moves from 2:00 to 5:00.
      const at = await waitFor(() => {
        const field = container.querySelector('input[type="time"]');
        if (!(field instanceof HTMLInputElement)) throw new Error('At field not rendered');
        return field;
      });
      await fireEvent.change(at, { target: { value: '05:00' } });

      // The schedule is run: `updatedAt` moves while the revision, which only a change to the
      // schedule moves, stays what the draft was built from.
      const before = await server.engine.getSchedule('cadence-edit');
      await server.engine.triggerSchedule('cadence-edit');
      if (queryClient === undefined) throw new Error('queryClient was never captured');
      await queryClient.invalidateQueries({ queryKey: scheduleDetailQueryKey('cadence-edit') });
      await waitFor(() => {
        const cached = queryClient?.getQueryData<{ updatedAt: number }>(
          scheduleDetailQueryKey('cadence-edit'),
        );
        expect(cached?.updatedAt).not.toBe(before?.updatedAt);
      });

      // The unsaved cadence edit survives the refetch.
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));
      const saved = await server.engine.getSchedule('cadence-edit');
      expect(saved?.cronExpression).toBe('0 5 * * *');
    } finally {
      await server.stop();
    }
  });

  test("switching to another schedule while the form is dirty rebuilds the form instead of saving one schedule's edits onto the other (COR-15 review)", async () => {
    const server = await startLiveSourceTestServer();
    for (const id of ['switch-a', 'switch-b']) {
      await server.engine.schedule({
        workflow: 'inventory-sync-sweep',
        id,
        cron: '0 2 * * *',
        input: {},
        description: id,
      });
    }
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    try {
      const { getByRole, rerender } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'switch-a', onClose: () => {} },
      });
      const description = await waitFor(() => getByRole('textbox', { name: 'Description' }));
      await fireEvent.input(description, { target: { value: 'dirty edit for a' } });

      await rerender({ client, scheduleId: 'switch-b', onClose: () => {} });
      await waitFor(() =>
        expect(
          requireElement(getByRole('textbox', { name: 'Description' }), HTMLInputElement).value,
        ).toBe('switch-b'),
      );
    } finally {
      await server.stop();
    }
  });

  test('saving edited description, overlap, backfill, and jitter persists them (COR-15)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'all-options',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
      description: 'before',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'all-options', onClose: () => (closed = true) },
      });

      const description = await waitFor(() => getByRole('textbox', { name: 'Description' }));
      expect(requireElement(description, HTMLInputElement).value).toBe('before');
      await fireEvent.input(description, { target: { value: 'after' } });
      await fireEvent.click(getByRole('radio', { name: 'Queue' }));
      await fireEvent.click(getByRole('switch', { name: 'Backfill missed occurrences' }));
      await fireEvent.input(getByRole('textbox', { name: 'Jitter' }), { target: { value: '30s' } });

      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      const after = await server.engine.getSchedule('all-options');
      expect(after?.description).toBe('after');
      expect(after?.overlap).toBe('queue');
      expect(after?.backfill).toBe(true);
      expect(after?.jitterMs).toBe(30_000);
    } finally {
      await server.stop();
    }
  });

  test('a rejected revision-policy save (ambiguous dynamic-source revision, no catalog active pointer) renders a fault instead of silently pinning (review, PR #978)', async () => {
    // `resolveScheduleRevisionForPin()` (engine-side) requires an
    // unambiguous revision for the type being pinned — for a
    // `registerSource()`-registered type with more than one candidate
    // revision and no catalog active pointer resolved, it throws
    // `DynamicWorkflowSourceUnavailableError` (reason `'ambiguous-revision'`).
    // This is a REAL rejection reachable through the edit drawer's own new
    // `revisionPolicy` `RadioGroup`: the schedule below is created while its
    // workflow type has exactly one registered dynamic-source revision
    // (unambiguous — creation succeeds), a SECOND revision is then
    // registered for the same type (simulating a later deploy adding a
    // candidate, with nobody ever having called `engine.workflows.activate()`),
    // and only THEN does the operator try to switch the schedule to `pinned`.
    //
    // `mapScheduleErrorToFault()` maps `DynamicWorkflowSourceUnavailableError`
    // to a `Conflict` fault (COR-19), so the console renders the explicit
    // "Conflict" banner — not a silent, wrongly-applied pin and not a masked
    // generic internal failure.
    const server = await startLiveSourceTestServer();
    const workflowType = 'ambiguous-pin-target';

    // `workflowSource()`'s `revision` is not a free-form label — it must
    // equal the exact content-derived revision
    // `buildWorkflowManifestFromDefinition()` computes from the loaded
    // module's contract (documentation/guides/workflow-versioning.md,
    // "`workflowSource()`: a typed, serializable source descriptor").
    // Two distinct `workflowVersion`s produce two distinct derived
    // revisions for the same workflow name, which is what this test needs
    // to register a genuinely ambiguous second candidate.
    async function derivedRevisionFor(version: string): Promise<string> {
      const contract = buildWorkflowContract({ name: workflowType, version });
      return deriveWorkflowRevision(normalizeWorkflowContract(contract));
    }
    const buildSource = async (version: string) =>
      workflowSource(
        {
          name: workflowType,
          location: `./fixtures/${workflowType}-${version}.ts`,
          exportName: 'target',
          revision: await derivedRevisionFor(version),
        },
        async () => ({
          // This workflow is never actually started in this test (only its
          // dynamic-source registration matters, for revision ambiguity) —
          // the trivial `yield* ctx.sleep()` exists solely so this is a real
          // generator body, satisfying `require-yield`, not because it ever
          // runs.
          target: workflow({ name: workflowType, version }).execute(async function* (ctx) {
            yield* ctx.sleep('1ms');
            return 'done';
          }),
        }),
      );

    server.engine.registerSource(await buildSource('1.0.0'));
    await server.engine.schedule({
      workflow: workflowType,
      id: 'ambiguous-pin-schedule',
      cron: '0 2 * * *',
      input: {},
    });
    // Registered AFTER creation succeeded on the sole-candidate fast path —
    // this is what makes the type ambiguous for the pin attempt below.
    server.engine.registerSource(await buildSource('2.0.0'));

    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole, getByText } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'ambiguous-pin-schedule',
          onClose: () => (closed = true),
        },
      });

      await waitFor(() => getByRole('radio', { name: 'Active at fire' }));
      await fireEvent.click(getByRole('radio', { name: 'Pinned' }));
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(getByText('Conflict')).not.toBeNull());
      expect(closed).toBe(false);

      // The rejected mutation must not have silently pinned the schedule.
      const after = await server.engine.getSchedule('ambiguous-pin-schedule');
      expect(after?.revisionPolicy).toBe('active-at-fire');
      expect(after?.pinnedRevision).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test('renders the not-found fault when the schedule no longer exists', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'missing', onClose: () => {} },
      });

      await waitFor(() => expect(getByText('Not found')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('says the schedule could not be loaded, and tries again on request', async () => {
    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:1' });

    const { getByRole, getByText } = render(ScheduleEditHarness, {
      props: { client, scheduleId: 'nightly-rollup' },
    });

    await waitFor(() => expect(getByText(SCHEDULE_COPY.detail.loadFailed)).not.toBeNull());
    expect(getByRole('button', { name: 'Try again' })).not.toBeNull();
  });
  test('keeps a skipped run across a save that leaves the cadence alone, and says nothing about one (COR-1985)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'skip-then-edit',
      cron: '0 2 * * *',
      timeZone: 'UTC',
      input: { warehouseId: 'wh-main' },
    });
    await server.engine.skipNextScheduleOccurrence('skip-then-edit');
    const skipped = await server.engine.getSchedule('skip-then-edit');
    expect(skipped?.skipUntil).toBeDefined();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole, queryByTestId } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'skip-then-edit', onClose: () => (closed = true) },
      });

      await waitFor(() => getByRole('radio', { name: 'Pinned' }));
      await fireEvent.click(getByRole('radio', { name: 'Pinned' }));
      expect(queryByTestId('schedule-edit-skip-pending')).toBeNull();
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));
      // The skip names a run the save leaves next, so the save does not restore it.
      const saved = await server.engine.getSchedule('skip-then-edit');
      expect(saved?.revisionPolicy).toBe('pinned');
      expect(saved?.skipUntil).toBe(skipped?.skipUntil);
    } finally {
      await server.stop();
    }
  });

  test('says a save restores the run that was skipped when the cadence changes, because the skip ends with it (COR-1985)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'skip-then-move',
      cron: '0 2 * * *',
      timeZone: 'UTC',
      input: { warehouseId: 'wh-main' },
    });
    await server.engine.skipNextScheduleOccurrence('skip-then-move');
    const skipped = await server.engine.getSchedule('skip-then-move');
    expect(skipped?.skipUntil).toBeDefined();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { container, getByRole, getByTestId, queryByTestId } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'skip-then-move', onClose: () => (closed = true) },
      });

      const at = await waitFor(() => {
        const field = container.querySelector('input[type="time"]');
        if (!(field instanceof HTMLInputElement)) throw new Error('At field not rendered');
        return field;
      });
      expect(queryByTestId('schedule-edit-skip-pending')).toBeNull();
      await fireEvent.change(at, { target: { value: '05:00' } });
      await waitFor(() =>
        expect(getByTestId('schedule-edit-skip-pending').textContent).toContain(
          SCHEDULE_COPY.edit.skipPending,
        ),
      );
      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));
      // The warning is true: a new cadence ends the skip.
      const saved = await server.engine.getSchedule('skip-then-move');
      expect(saved?.cronExpression).toBe('0 5 * * *');
      expect(saved?.skipUntil).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test('says nothing about a skip when none is pending', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'no-skip-edit',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, queryByTestId } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'no-skip-edit', onClose: () => {} },
      });

      await waitFor(() => getByRole('radio', { name: 'Pinned' }));
      expect(queryByTestId('schedule-edit-skip-pending')).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
