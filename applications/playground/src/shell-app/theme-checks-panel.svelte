<script lang="ts">
  /*
   * The checks panel (COR-259): the accessibility report for the committed revision, grouped by
   * severity, with scoped wording only. It never says "Accessible" or "certified": it says what
   * was checked (this revision, six contexts, the listed scenes) and what was not.
   *
   * Background revalidation never moves focus. The aggregate result is announced once, after a
   * committed change, through a polite live region. A report for an older revision is shown as
   * out of date and can never read as a Pass.
   */
  import { Button, Select } from '@lostgradient/cinder';
  import { onDestroy, tick, untrack } from 'svelte';

  import type { OutputGamut } from './theme-chroma-grid.ts';
  import {
    countReport,
    exportReadiness,
    isReportCurrent,
    outstandingCount,
    reportFindings,
  } from './theme-check-engine.ts';
  import ThemeCheckFinding from './theme-check-finding.svelte';
  import { aggregateAnnouncement, ThemeChecksSession } from './theme-check-session.svelte.ts';
  import { SEVERITIES, type ReportRecord, type Severity } from './theme-check-types.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
  import {
    THEME_PREVIEW_COLOR_MODES,
    THEME_PREVIEW_MOTIONS,
    type ThemePreviewColorMode,
    type ThemePreviewMotion,
  } from './theme-preview-message.ts';
  import ThemeRemediationControl from './theme-remediation-control.svelte';
  import { diagnosticSubject, findingSubject } from './theme-remediation-subject.ts';
  import { ruleById } from './theme-check-rules.ts';
  import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    workbench: ThemeWorkbenchState;
    controller?: ThemeBuilderController;
    /** Supplies the evaluations; the real runtime unless a test passes another. */
    evaluator?: ThemeEvaluator;
  };
  let { workbench, controller, evaluator = createRuntimeEvaluator() }: Props = $props();

  /** The evaluation target fixes are computed for; sRGB unless the author picks Display P3. */
  let gamut = $state<OutputGamut>('srgb');

  const session = new ThemeChecksSession(untrack(() => evaluator));

  const SEVERITY_TITLES: Record<Severity, string> = {
    'invalid-source': 'Invalid source',
    'accessibility-error': 'Accessibility errors',
    'needs-review': 'Needs review',
    advisory: 'Advisory',
  };
  const SEVERITY_NOTES: Record<Severity, string> = {
    'invalid-source': 'This revision cannot be applied or checked until the source is valid.',
    'accessibility-error': 'A normative threshold was not met. These block the normal export.',
    'needs-review': 'Something could not be measured. These block a passing report.',
    advisory:
      'Cinder guardrails, APCA and gamut notes. They stay visible, can be acknowledged, and never change the result.',
  };

  /** Only an open group renders its findings, so a long advisory list costs nothing until read. */
  let opened = $state<Record<Severity, boolean>>({
    'invalid-source': true,
    'accessibility-error': true,
    'needs-review': true,
    advisory: false,
  });

  const draft = $derived(controller?.draft ?? null);
  const report = $derived(session.report);
  const current = $derived(
    isReportCurrent(report, draft?.envelope.id ?? null, draft?.revision ?? null),
  );
  const counts = $derived(report === null ? null : countReport(report));
  const findings = $derived(report === null ? [] : reportFindings(report));
  const readiness = $derived(exportReadiness(report, current, session.running));
  const grouped = $derived(
    SEVERITIES.map((severity) => ({
      severity,
      items: findings.filter((finding) => finding.severity === severity),
    })).filter((group) => group.items.length > 0),
  );

  $effect(() => {
    const value = draft;
    if (value === null) return;
    session.schedule(value.envelope, value.revision);
  });

  $effect(() => {
    workbench.setChecks({
      findings:
        counts === null || !current
          ? untrack(() => workbench.findingsCount)
          : outstandingCount(counts),
      readiness,
    });
  });

  onDestroy(() => session.stop());

  const STATUS_LINES: Record<typeof readiness, string> = {
    checking: 'Checking this revision in all six contexts.',
    stale: 'These results are for an earlier revision and are out of date.',
    'blocked-invalid-source': 'The theme source is invalid. Export is blocked.',
    'blocked-accessibility-errors':
      'Accessibility errors were found. The normal CSS and portable export is blocked.',
    'needs-review':
      'Some pairings could not be measured. This is not a passing report until they are reviewed.',
    ready:
      'No accessibility errors or items to review in the checked contexts and scenes. This is a scoped check, not a certification.',
  };

  function show(record: ReportRecord): void {
    const path = record.tokenPaths[0];
    if (path !== undefined) workbench.selectToken(path);
    const [colorMode, motion] = record.context.split('/');
    if (
      THEME_PREVIEW_COLOR_MODES.includes(colorMode as ThemePreviewColorMode) &&
      THEME_PREVIEW_MOTIONS.includes(motion as ThemePreviewMotion)
    ) {
      workbench.setContext({
        colorMode: colorMode as ThemePreviewColorMode,
        motion: motion as ThemePreviewMotion,
      });
    }
    const scene = record.scenes[0];
    if (scene !== undefined) workbench.selectScene(scene.sceneId);
    // The button keeps focus; the selection is reported once, politely.
    session.announcement = `Showing ${record.tokenPaths[0] ?? 'the affected tokens'} in the editor, ${record.context}${scene === undefined ? '' : `, scene ${scene.sceneId}`}.`;
  }

  // --- navigation and focus ---------------------------------------------------------------

  let root: HTMLElement | undefined = $state();
  let statusLine: HTMLElement | undefined = $state();

  /** The finding ids that render, in reading order. */
  const renderedIds = (): string[] =>
    grouped
      .filter((group) => opened[group.severity])
      .flatMap((group) => group.items.map((item) => item.id));

  const findingElement = (id: string): HTMLElement | null =>
    [...(root?.querySelectorAll<HTMLElement>('[data-finding-id]') ?? [])].find(
      (node) => node.dataset['findingId'] === id,
    ) ?? null;

  /** From the summary to the first finding of a severity, opening its group. */
  async function goTo(severity: Severity): Promise<void> {
    opened[severity] = true;
    await tick();
    const first = grouped.find((group) => group.severity === severity)?.items[0];
    if (first !== undefined) findingElement(first.id)?.focus();
    else root?.querySelector<HTMLElement>('#checks-invalid-heading')?.focus();
  }

  /** Set only by Apply or Undo, so background revalidation can never move focus. */
  let pendingFocus = $state.raw<{
    id: string;
    order: readonly string[];
    revision: number;
    message: string;
  } | null>(null);
  let lastFix = $state.raw<{ id: string } | null>(null);

  function requestFocus(id: string, message: string, order: readonly string[]): void {
    pendingFocus = { id, order, revision: controller?.draft?.revision ?? 0, message };
  }

  function fixed(id: string, message: string): void {
    lastFix = { id };
    requestFocus(id, message, renderedIds());
  }

  const undoable = $derived(
    lastFix !== null &&
      controller !== undefined &&
      controller.history?.entries[controller.history.cursor - 1]?.kind === 'remediation',
  );

  async function undoFix(): Promise<void> {
    const target = lastFix;
    if (controller === undefined || target === null) return;
    const label = controller.undoLabel ?? 'the fix';
    const outcome = await controller.undo();
    lastFix = null;
    if (outcome.ok) requestFocus(target.id, `Undid ${label}.`, [target.id]);
  }

  // Once the report for the fixed (or restored) revision lands, focus the finding it was
  // about if it is still there, otherwise the next unresolved one, otherwise the status line.
  $effect(() => {
    const request = pendingFocus;
    if (request === null || !current || report === null) return;
    if (report.stamp.sourceRevision < request.revision) return;
    const ids = untrack(renderedIds);
    const landed = report;
    void (async () => {
      await tick();
      const index = request.order.indexOf(request.id);
      const after = request.order.slice(index + 1);
      const before = request.order.slice(0, Math.max(0, index)).toReversed();
      const target = [request.id, ...after, ...before].find((id) => ids.includes(id));
      const node = target === undefined ? statusLine : findingElement(target);
      node?.focus();
      session.announcement = `${request.message} ${aggregateAnnouncement(landed)}`;
    })();
    pendingFocus = null;
  });
</script>

{#snippet remediation(record: ReportRecord)}
  {#if controller !== undefined}
    <ThemeRemediationControl
      {controller}
      subject={findingSubject(controller, record, ruleById(record.ruleId).title, evaluator, gamut)}
      inputsKey={gamut}
      onfixed={fixed}
    />
  {/if}
{/snippet}

<div
  class="panel"
  data-testid="checks-panel"
  data-readiness={readiness}
  aria-busy={!current}
  bind:this={root}
>
  <p class="status" data-testid="checks-status" tabindex="-1" bind:this={statusLine}>
    {STATUS_LINES[readiness]}
  </p>
  <div class="sr-only" role="status" aria-live="polite" data-testid="checks-announcer">
    {session.announcement}
  </div>
  <div class="tools">
    <Select
      id="checks-fix-gamut"
      label="Evaluation target for fixes"
      options={[
        { value: 'srgb', label: 'sRGB (default)' },
        { value: 'display-p3', label: 'Display P3' },
      ]}
      value={gamut}
      onchange={(event) => (gamut = event.currentTarget.value as OutputGamut)}
    />
    {#if undoable}
      <Button
        label="Undo last fix"
        variant="secondary"
        size="sm"
        aria-label={`Undo last fix: ${controller?.undoLabel ?? ''}`}
        onclick={() => void undoFix()}
      />
    {/if}
  </div>

  {#if report !== null}
    <p class="scope" data-testid="checks-scope">
      Revision {report.stamp.sourceRevision}, {report.stamp.contexts.length} contexts, checked against
      the shared contrast table and the listed reference scenes.
    </p>
    {#if counts !== null}
      <ul class="counts" aria-label="Result counts">
        {#each SEVERITIES as severity (severity)}
          <li data-testid={`count-${severity}`}>
            {#if counts[severity] > 0}
              <Button
                label={`${SEVERITY_TITLES[severity]}: ${counts[severity]}`}
                variant="ghost"
                size="sm"
                aria-label={`Go to the first ${SEVERITY_TITLES[severity].toLowerCase()} finding, ${counts[severity]} in total`}
                onclick={() => void goTo(severity)}
              />
            {:else}
              {SEVERITY_TITLES[severity]}: {counts[severity]}
            {/if}
          </li>
        {/each}
        <li>Passed: {counts.pass}</li>
        <li>Exempt: {counts.exempt}</li>
      </ul>
    {/if}
    {#if report.sourceValidity.status === 'invalid'}
      <section aria-labelledby="checks-invalid-heading">
        <h3 id="checks-invalid-heading" tabindex="-1">{SEVERITY_TITLES['invalid-source']}</h3>
        <ul class="invalid">
          {#each report.sourceValidity.diagnostics as diagnostic (`${diagnostic.context}:${diagnostic.path}:${diagnostic.message}`)}
            <li>
              {diagnostic.path} ({diagnostic.context}): {diagnostic.message}
              {#if controller !== undefined}
                <ThemeRemediationControl
                  {controller}
                  subject={diagnosticSubject(controller, diagnostic, evaluator)}
                  inputsKey="source"
                  onfixed={fixed}
                />
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#each grouped as group (group.severity)}
      <details
        class="group"
        open={opened[group.severity]}
        ontoggle={(event) => (opened[group.severity] = event.currentTarget.open)}
        data-testid={`group-${group.severity}`}
      >
        <summary>
          <h3>{SEVERITY_TITLES[group.severity]} ({group.items.length})</h3>
        </summary>
        <p class="note">{SEVERITY_NOTES[group.severity]}</p>
        {#if opened[group.severity]}
          <ul class="list">
            {#each group.items as record (record.id)}
              <ThemeCheckFinding {record} onshow={show} actions={remediation} />
            {/each}
          </ul>
        {/if}
      </details>
    {/each}

    <details class="group">
      <summary><h3>What these checks do not cover</h3></summary>
      <ul>
        {#each report.untested as area (area)}
          <li>{area}</li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  .panel {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .status {
    font-weight: var(--cinder-font-semibold);
  }
  .status:focus-visible,
  #checks-invalid-heading:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow:
      0 0 0 var(--cinder-ring-offset) var(--cinder-ring-offset-color),
      0 0 0 calc(var(--cinder-ring-offset) + var(--cinder-ring-width)) var(--cinder-ring-color);
  }
  @media (forced-colors: active) {
    .status:focus-visible,
    #checks-invalid-heading:focus-visible {
      outline: var(--cinder-ring-width) solid Highlight;
      outline-offset: 3px;
    }
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px;
  }
  .invalid {
    display: grid;
    gap: 8px;
  }
  .scope,
  .note {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 16px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--cinder-text-sm);
  }
  summary {
    cursor: pointer;
  }
  summary h3 {
    display: inline;
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: var(--cinder-font-semibold);
  }
  .list {
    margin: 0;
    padding: 0;
  }
  .group ul {
    padding-inline-start: 1.25rem;
  }
  .group .list {
    padding-inline-start: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
