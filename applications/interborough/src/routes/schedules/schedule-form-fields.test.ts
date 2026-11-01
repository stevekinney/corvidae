import { requireElement } from '../../../tests/dom.test-support.ts';

/**
 * Component tests for `<ScheduleFormFields>` — a pure presentational
 * component (no client/query/principal context needed), so these render
 * standalone.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import ScheduleFormFields from './schedule-form-fields.svelte';
import { ScheduleFormState } from './schedule-form-state.svelte.ts';

describe('ScheduleFormFields — cadence, overlap and backfill', () => {
  test('renders an editable Description field (COR-15)', () => {
    const form = new ScheduleFormState();
    const { getByRole } = render(ScheduleFormFields, {
      props: { form },
    });
    expect(
      requireElement(getByRole('textbox', { name: 'Description' }), HTMLInputElement).disabled,
    ).toBe(false);
  });

  test('an exact cadence below a minute is shown as text until Change cadence brings the builder back', async () => {
    const form = new ScheduleFormState({
      cadence: { every: { unit: 'minutes', count: 1 }, timeZone: 'UTC' },
      originalCadence: { intervalMs: 30_000 },
    });

    const { getByRole, queryByRole } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(requireElement(getByRole('textbox', { name: 'Cadence' }), HTMLInputElement).value).toBe(
      'Every 30 seconds',
    );
    expect(queryByRole('combobox', { name: 'Repeats' })).toBeNull();
    await fireEvent.click(getByRole('button', { name: SCHEDULE_COPY.form.changeCadenceAction }));
    expect(form.cadenceChanged).toBe(true);
    expect(getByRole('combobox', { name: 'Repeats' })).not.toBeNull();
    expect(queryByRole('button', { name: SCHEDULE_COPY.form.changeCadenceAction })).toBeNull();
  });

  test('selecting an overlap policy updates the form and shows its consequence', async () => {
    const form = new ScheduleFormState();

    const { getByRole, getByText } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(
      getByText(
        'Concurrent runs are permitted. Multiple instances may run simultaneously. Use only if the workflow is safe to parallelize.',
      ),
    ).not.toBeNull();

    await fireEvent.click(getByRole('radio', { name: 'Allow' }));

    expect(form.overlap).toBe('allow');
  });

  test('enabling backfill shows the catch-up-window warning', async () => {
    const form = new ScheduleFormState();

    const { getByRole, queryByText, getByText } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(queryByText(/missed occurrences fire/)).toBeNull();
    await fireEvent.click(getByRole('switch', { name: 'Backfill missed occurrences' }));

    expect(form.backfill).toBe(true);
    expect(getByText(/missed occurrences fire/)).not.toBeNull();
  });

  test('renders the catch-up-window warning already mounted when backfill starts enabled, and removes it when disabled', async () => {
    // Complements the toggle-on case above: mounting with `backfill` already
    // `true` exercises the `{#if}` block's initial-render path directly
    // (rather than only its post-toggle transition-in), and toggling back
    // off exercises its teardown/transition-out path — both are distinct
    // compiled code paths from the toggle-on assertion alone.
    const form = new ScheduleFormState({ backfill: true });

    const { getByRole, queryByText, getByText } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(getByText(/missed occurrences fire/)).not.toBeNull();
    await fireEvent.click(getByRole('switch', { name: 'Backfill missed occurrences' }));

    expect(form.backfill).toBe(false);
    expect(queryByText(/missed occurrences fire/)).toBeNull();
  });
});

describe('ScheduleFormFields — what an edit can change', () => {
  test('shows the workflow type fixed; overlap, jitter, backfill, and description are editable (COR-15)', async () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      overlap: 'queue',
    });

    const { getByRole, queryByRole } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(
      requireElement(getByRole('textbox', { name: 'Workflow type' }), HTMLInputElement).disabled,
    ).toBe(true);
    // What a schedule starts with is fixed when it is made, and is not a field here.
    expect(queryByRole('textbox', { name: 'Input (JSON)' })).toBeNull();
    expect(queryByRole('textbox', { name: 'Schedule ID' })).toBeNull();
    expect(queryByRole('switch', { name: 'Start paused' })).toBeNull();
    expect(requireElement(getByRole('radio', { name: 'Skip' }), HTMLInputElement).disabled).toBe(
      false,
    );
    expect(
      requireElement(getByRole('textbox', { name: 'Jitter' }), HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      requireElement(
        getByRole('switch', { name: 'Backfill missed occurrences' }),
        HTMLButtonElement,
      ).disabled,
    ).toBe(false);
    expect(
      requireElement(getByRole('textbox', { name: 'Description' }), HTMLInputElement).disabled,
    ).toBe(false);
  });

  test('editing the description writes through to the form', async () => {
    const form = new ScheduleFormState({ workflowType: 'report-gen', description: 'Old' });
    const { getByRole } = render(ScheduleFormFields, {
      props: { form },
    });
    const field = requireElement(getByRole('textbox', { name: 'Description' }), HTMLInputElement);
    expect(field.value).toBe('Old');
    await fireEvent.input(field, { target: { value: 'New' } });
    expect(form.description).toBe('New');
  });

  test('does NOT disable the revision-policy radio group in edit mode', async () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      revisionPolicy: 'active-at-fire',
    });

    const { getByRole } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(
      requireElement(getByRole('radio', { name: 'Active at fire' }), HTMLInputElement).disabled,
    ).toBe(false);
    expect(requireElement(getByRole('radio', { name: 'Pinned' }), HTMLInputElement).disabled).toBe(
      false,
    );
  });

  test('shows the re-capture warning when CHANGING to pinned in edit mode', async () => {
    // Starts active-at-fire so `form.initialRevisionPolicy` captures that
    // baseline; the click below is a real transition, not a same-value
    // re-render, so `toUpdateRevisionPolicy()` would actually submit it.
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      revisionPolicy: 'active-at-fire',
    });

    const { getByRole, getByText, getAllByText } = render(ScheduleFormFields, {
      props: { form },
    });

    await fireEvent.click(getByRole('radio', { name: 'Pinned' }));

    expect(getByText(/captures whichever revision is active right now/)).not.toBeNull();
    // `resolveScheduleRevisionForPin()` deliberately uses the same
    // executable-resolution path as a fresh start (Codex review, PR #978,
    // round 5) — for an eager-registered type, or when only one revision
    // is a viable dynamic-source candidate, the captured pin can differ
    // from whatever the catalog's active pointer shows. This exact hedge
    // now legitimately renders TWICE while the operator has "Pinned"
    // selected — once here in the re-capture warning, and once in the
    // still-visible "Active at fire" option's own description (Codex
    // review, PR #978, round 7: the active-at-fire consequence text needed
    // the identical caveat, since a fresh occurrence can bypass the active
    // pointer the same way) — `RadioGroup` renders every option's
    // description regardless of which one is currently selected.
    expect(
      getAllByText(/a fresh start can run without consulting the active pointer at all/).length,
    ).toBe(2);
  });

  test('does NOT show the pinned warning when active-at-fire is selected in edit mode', async () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      revisionPolicy: 'active-at-fire',
    });

    const { queryByText } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(queryByText(/captures whichever revision is active right now/)).toBeNull();
  });

  test('does NOT show the pinned warning for an already-pinned schedule left unchanged — toUpdateRevisionPolicy() sends nothing, so the prior "never a no-op" framing was misleading (Codex review, PR #978)', async () => {
    const form = new ScheduleFormState({
      workflowType: 'report-gen',
      revisionPolicy: 'pinned',
    });

    const { queryByText } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(form.toUpdateRevisionPolicy()).toBeUndefined();
    expect(queryByText(/captures whichever revision is active right now/)).toBeNull();
  });

  test("a fresh mount always captures its OWN form instance's revisionPolicy — the one-shot draft is safe precisely because the parent guarantees a fresh mount per form instance (Codex review, PR #978, round 2; see schedule-edit.svelte's `{#key form}` and its test for the swap-while-mounted case this documents)", async () => {
    const firstForm = new ScheduleFormState({
      workflowType: 'report-gen',
      revisionPolicy: 'active-at-fire',
    });
    const { getByRole: getByRoleFirst, unmount } = render(ScheduleFormFields, {
      props: { form: firstForm },
    });
    expect(
      requireElement(getByRoleFirst('radio', { name: 'Active at fire' }), HTMLInputElement).checked,
    ).toBe(true);
    unmount();

    const secondForm = new ScheduleFormState({
      workflowType: 'report-gen',
      revisionPolicy: 'pinned',
    });
    const { getByRole: getByRoleSecond } = render(ScheduleFormFields, {
      props: { form: secondForm },
    });
    expect(
      requireElement(getByRoleSecond('radio', { name: 'Pinned' }), HTMLInputElement).checked,
    ).toBe(true);
  });
});

describe('ScheduleFormFields — revision policy', () => {
  test('renders both REVISION_POLICIES options with their labels and consequences', async () => {
    const form = new ScheduleFormState();

    const { getByText } = render(ScheduleFormFields, {
      props: { form },
    });

    expect(getByText('Active at fire')).not.toBeNull();
    expect(getByText('Pinned')).not.toBeNull();
    expect(getByText(/Each occurrence resolves whichever revision is active/)).not.toBeNull();
    expect(getByText(/Every occurrence resolves the exact revision captured/)).not.toBeNull();
  });

  test('selecting Pinned updates form.revisionPolicy', async () => {
    const form = new ScheduleFormState();

    const { getByRole } = render(ScheduleFormFields, {
      props: { form },
    });

    await fireEvent.click(getByRole('radio', { name: 'Pinned' }));

    expect(form.revisionPolicy).toBe('pinned');
  });
});
