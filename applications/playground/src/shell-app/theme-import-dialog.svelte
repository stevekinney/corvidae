<script lang="ts">
  /*
   * The Import dialog (COR-486). Choosing a file or pasting text runs the preflight, which
   * shows exactly one of four outcomes before anything can change. Apply is offered only for
   * a supported outcome whose Cinder base this build ships; every outcome can be downloaded
   * unchanged. Nothing is fetched and nothing is read as code. A failed apply leaves the
   * draft, history and preview as they were.
   */
  import { Button, Callout, FileUpload, Modal, Textarea } from '@lostgradient/cinder';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { downloadChosenFile, downloadFile } from './theme-export-delivery.ts';
  import { applyImport, type ApplyMode } from './theme-import-apply.ts';
  import { preflightImport, preflightOversizeFile } from './theme-import-preflight.ts';
  import { canApply, type PreflightOutcome, type PreflightResult } from './theme-import-types.ts';
  import { THEME_DATA_LIMITS } from './theme-draft-limits.ts';

  type Props = { controller: ThemeBuilderController; open: boolean; onClose: () => void };
  let { controller, open, onClose }: Props = $props();

  let result = $state.raw<PreflightResult | null>(null);
  let pasted = $state('');
  let busy = $state(false);
  let announcement = $state('');
  let failure = $state('');

  const OUTCOME_LABELS: Record<PreflightOutcome, string> = {
    'cinder-envelope': 'Cinder Theme v1 envelope',
    'dtcg-document': 'DTCG token document',
    'unsupported-profile': 'Unsupported profile',
    invalid: 'Invalid input',
  };

  function variantOf(preflight: PreflightResult): 'success' | 'info' | 'warning' | 'danger' {
    if (preflight.outcome === 'invalid') return 'danger';
    if (preflight.outcome === 'unsupported-profile') return 'info';
    return preflight.base !== null && !preflight.base.compatible ? 'warning' : 'success';
  }

  $effect(() => {
    if (!open) {
      result = null;
      pasted = '';
      announcement = '';
      failure = '';
    }
  });

  function show(next: PreflightResult): void {
    result = next;
    failure = '';
    announcement = `${OUTCOME_LABELS[next.outcome]}. ${next.headline}. ${
      canApply(next) ? 'You can apply it.' : 'Your draft is unchanged.'
    }`;
  }

  async function check(text: string, filename: string): Promise<void> {
    const current = controller.draft?.envelope;
    if (current === undefined) return;
    busy = true;
    show(await preflightImport(text, filename, current));
    busy = false;
  }

  async function chooseFile(files: File[]): Promise<void> {
    const file = files[0];
    if (file === undefined) return;
    if (file.size > THEME_DATA_LIMITS.fileBytes) {
      show(preflightOversizeFile(file));
      return;
    }
    await check(await file.text(), file.name);
  }

  async function apply(mode: ApplyMode): Promise<void> {
    if (result === null) return;
    busy = true;
    const outcome = await applyImport(controller, result, mode);
    busy = false;
    if (outcome.ok) {
      controller.announcement = outcome.message;
      onClose();
    } else {
      failure = outcome.message;
      announcement = outcome.message;
    }
  }

  function downloadUnchanged(): void {
    if (result === null) return;
    if ('file' in result.source) downloadChosenFile(result.source.file);
    else downloadFile(result.source);
  }
</script>

<Modal {open} title="Import theme" onDismiss={onClose} describedById="theme-import-intro">
  <div class="import" data-testid="import-dialog">
    <p id="theme-import-intro" class="import__intro">
      Choose a Cinder Theme v1 file or a DTCG token document, or paste JSON. The file is checked
      first and nothing changes until you apply it. Nothing is uploaded or fetched.
    </p>
    <div class="sr-only" role="status" aria-live="polite" data-testid="import-announcer">
      {announcement}
    </div>
    <FileUpload
      id="theme-import-file"
      accept=".json,application/json"
      title="Choose a theme file"
      description="JSON up to 1 MiB"
      onFilesAccepted={(files) => void chooseFile(files)}
    />
    <Textarea
      id="theme-import-paste"
      label="Or paste JSON"
      variant="code"
      rows={5}
      bind:value={pasted}
    />
    <div>
      <Button
        label="Check pasted JSON"
        variant="secondary"
        disabled={busy || pasted.trim() === ''}
        onclick={() => void check(pasted, 'pasted.json')}
      />
    </div>

    {#if result !== null}
      <section
        class="import__result"
        aria-labelledby="theme-import-outcome"
        data-testid="import-result"
        data-outcome={result.outcome}
      >
        <Callout variant={variantOf(result)} title={OUTCOME_LABELS[result.outcome]}>
          <span id="theme-import-outcome" data-testid="import-headline">{result.headline}</span>
        </Callout>
        <p>{result.detail}</p>

        {#if result.base !== null}
          <dl class="import__facts" data-testid="import-base">
            <div>
              <dt>This file's Cinder base</dt>
              <dd>{result.base.packageVersion}</dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd>{result.base.sourceDigest}</dd>
            </div>
            <div>
              <dt>This build</dt>
              <dd>{result.base.currentPackageVersion}</dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd>{result.base.currentSourceDigest}</dd>
            </div>
          </dl>
        {/if}
        {#if result.axes.length > 0}
          <div>
            <h3>Detected axes</h3>
            <ul data-testid="import-axes">
              {#each result.axes as axis (axis)}<li>{axis}</li>{/each}
            </ul>
          </div>
        {/if}
        {#if result.unsupported.length > 0}
          <div>
            <h3>Not imported</h3>
            <ul data-testid="import-unsupported">
              {#each result.unsupported as feature (feature)}<li>{feature}</li>{/each}
            </ul>
          </div>
        {/if}
        {#if result.facts.length > 0}
          <dl class="import__facts" data-testid="import-facts">
            {#each result.facts as fact (fact.label)}
              <div>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            {/each}
          </dl>
        {/if}
        {#if result.findings.length > 0}
          <div>
            <h3>Findings</h3>
            <ul data-testid="import-findings">
              {#each result.findings as finding, index (index)}
                <li><code>{finding.path}</code>: {finding.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
        <div class="import__actions" role="group" aria-label="Import actions">
          <Button label="Download unchanged" variant="secondary" onclick={downloadUnchanged} />
          <Button
            label="Import as a copy"
            variant="secondary"
            disabled={busy || !canApply(result)}
            onclick={() => void apply('copy')}
          />
          <Button
            label="Apply to this theme"
            variant="primary"
            disabled={busy || !canApply(result)}
            onclick={() => void apply('replace')}
          />
        </div>
        {#if failure !== ''}
          <p class="import__failure" role="alert" data-testid="import-failure">{failure}</p>
        {/if}
      </section>
    {/if}
  </div>

  {#snippet footer()}
    <Button label="Cancel" variant="secondary" onclick={onClose} />
  {/snippet}
</Modal>

<style>
  .import {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .import p,
  .import h3,
  .import ul,
  .import dl {
    margin: 0;
  }
  .import__intro {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .import__result {
    display: grid;
    gap: 10px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .import h3 {
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }
  .import ul {
    padding-inline-start: 1.25rem;
  }
  .import__facts {
    display: grid;
    gap: 4px;
  }
  .import__facts div {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .import__facts dt {
    color: var(--cinder-text-muted);
  }
  .import__facts dd {
    margin: 0;
  }
  .import__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .import__failure {
    font-weight: var(--cinder-font-semibold);
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
