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
  import type { Snippet } from 'svelte';
  import { onDestroy, untrack } from 'svelte';

  import {
    countReport,
    exportReadiness,
    isReportCurrent,
    outstandingCount,
    reportFindings,
  } from './theme-check-engine.ts';
  import ThemeCheckFinding from './theme-check-finding.svelte';
  import { ThemeChecksSession } from './theme-check-session.svelte.ts';
  import { SEVERITIES, type ReportRecord, type Severity } from './theme-check-types.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
  import {
    THEME_PREVIEW_COLOR_MODES,
    THEME_PREVIEW_MOTIONS,
    type ThemePreviewColorMode,
    type ThemePreviewMotion,
  } from './theme-preview-message.ts';
  import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    workbench: ThemeWorkbenchState;
    controller?: ThemeBuilderController;
    /** Supplies the evaluations; the real runtime unless a test passes another. */
    evaluator?: ThemeEvaluator;
    /** The seam for COR-487's fix actions, rendered once per finding. */
    actions?: Snippet<[ReportRecord]>;
  };
  let { workbench, controller, evaluator = createRuntimeEvaluator(), actions }: Props = $props();

  const session = new ThemeChecksSession(evaluator);

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
  }
</script>

<div class="panel" data-testid="checks-panel" data-readiness={readiness} aria-busy={!current}>
  <p class="status" data-testid="checks-status">{STATUS_LINES[readiness]}</p>
  <div class="sr-only" role="status" aria-live="polite" data-testid="checks-announcer">
    {session.announcement}
  </div>

  {#if report !== null}
    <p class="scope" data-testid="checks-scope">
      Revision {report.stamp.sourceRevision}, {report.stamp.contexts.length} contexts, checked against
      the shared contrast table and the listed reference scenes.
    </p>
    {#if counts !== null}
      <ul class="counts" aria-label="Result counts">
        {#each SEVERITIES as severity (severity)}
          <li data-testid={`count-${severity}`}>{SEVERITY_TITLES[severity]}: {counts[severity]}</li>
        {/each}
        <li>Passed: {counts.pass}</li>
        <li>Exempt: {counts.exempt}</li>
      </ul>
    {/if}
    {#if report.sourceValidity.status === 'invalid'}
      <section aria-labelledby="checks-invalid-heading">
        <h3 id="checks-invalid-heading">{SEVERITY_TITLES['invalid-source']}</h3>
        <ul>
          {#each report.sourceValidity.diagnostics as diagnostic (`${diagnostic.context}:${diagnostic.path}:${diagnostic.message}`)}
            <li>{diagnostic.path} ({diagnostic.context}): {diagnostic.message}</li>
          {/each}
        </ul>
      </section>
    {/if}

    {#each grouped as group (group.severity)}
      <details
        class="group"
        open={group.severity !== 'advisory'}
        data-testid={`group-${group.severity}`}
      >
        <summary>
          <h3>{SEVERITY_TITLES[group.severity]} ({group.items.length})</h3>
        </summary>
        <p class="note">{SEVERITY_NOTES[group.severity]}</p>
        <ul class="list">
          {#each group.items as record (record.id)}
            <ThemeCheckFinding {record} onshow={show} {actions} />
          {/each}
        </ul>
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
