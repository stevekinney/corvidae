<script lang="ts">
  /*
   * The Export dialog (COR-486). It takes one snapshot of the committed revision when it
   * opens, checks it, and lists every format with what it is, whether it is available, and
   * why not. Each file can be downloaded or copied; a clipboard that fails downloads the file
   * instead. Opening it changes no draft and writes no history entry.
   */
  import { Button, Callout, Checkbox, Modal } from '@lostgradient/cinder';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { copyOrDownload, downloadFile } from './theme-export-delivery.ts';
  import { planExports, type ExportArtifact } from './theme-export-plan.ts';
  import {
    snapshotIsCurrent,
    takeExportSnapshot,
    type ExportSnapshot,
  } from './theme-export-snapshot.ts';
  import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';

  type Props = { controller: ThemeBuilderController; open: boolean; onClose: () => void };
  let { controller, open, onClose }: Props = $props();

  const evaluator = createRuntimeEvaluator();
  let snapshot = $state.raw<ExportSnapshot | null>(null);
  let acknowledged = $state(false);
  let status = $state('');
  let checking = $state(false);

  const plan = $derived(snapshot === null ? null : planExports(snapshot, acknowledged));
  const current = $derived(snapshot !== null && snapshotIsCurrent(snapshot, controller.draft));

  async function refresh(): Promise<void> {
    const draft = controller.draft;
    if (draft === null) return;
    checking = true;
    status = 'Checking the theme before export.';
    const taken = await takeExportSnapshot(draft, evaluator);
    snapshot = taken;
    checking = false;
    status = `Checked revision ${taken.revision}. Choose a format.`;
  }

  $effect(() => {
    if (open) {
      acknowledged = false;
      void refresh();
    } else {
      snapshot = null;
    }
  });

  async function copy(file: { filename: string; mime: string; text: string }): Promise<void> {
    const delivered = await copyOrDownload(file);
    status = delivered.message;
  }

  function download(file: { filename: string; mime: string; text: string }): void {
    status = downloadFile(file).message;
  }

  function downloadAll(artifact: ExportArtifact): void {
    for (const file of artifact.files) downloadFile(file);
    status = `Downloaded ${artifact.files.length} files.`;
  }

  const baseLine = $derived(
    snapshot === null
      ? ''
      : `Revision ${snapshot.revision} of “${snapshot.envelope.name}”, Cinder ${snapshot.envelope.base.packageVersion}, ${snapshot.envelope.base.sourceDigest}.`,
  );
</script>

<Modal {open} title="Export theme" onDismiss={onClose} describedById="theme-export-intro">
  <div class="export" data-testid="export-dialog">
    <p id="theme-export-intro" class="export__intro">
      Every file is made from the revision checked below. Editing the draft afterwards does not
      change it; reopen Export to check the new revision.
    </p>
    <p class="export__status" role="status" data-testid="export-status">{status}</p>

    {#if checking || plan === null || snapshot === null}
      <p>Checking…</p>
    {:else}
      <p class="export__base" data-testid="export-base">{baseLine}</p>
      {#if !current}
        <Callout variant="warning" title="The draft changed">
          This snapshot is out of date. Close and reopen Export to check the current revision.
        </Callout>
      {/if}
      {#if plan.acknowledgeable > 0 && snapshot.readiness !== 'blocked-accessibility-errors'}
        <Checkbox
          id="theme-export-acknowledge"
          checked={acknowledged}
          label={`I have read the ${plan.acknowledgeable} items that need review or are advisory`}
          description="Acknowledging releases the CSS and DTCG exports. It does not turn a finding into a pass."
          onValueChange={(next) => (acknowledged = next)}
        />
      {/if}

      <ul class="export__list" aria-label="Export formats">
        {#each plan.artifacts as artifact (artifact.kind)}
          <li class="export__item" data-testid={`export-${artifact.kind}`}>
            <h3>
              {artifact.title}
              {#if artifact.caveat !== null}
                <span class="export__caveat" data-testid={`export-${artifact.kind}-caveat`}>
                  {artifact.caveat}
                </span>
              {/if}
            </h3>
            <p>{artifact.description}</p>
            {#if artifact.blockedReason !== null}
              <p class="export__blocked" data-testid={`export-${artifact.kind}-blocked`}>
                Unavailable: {artifact.blockedReason}
              </p>
            {:else}
              {#if artifact.files.length > 1}
                <Button
                  label={`Download all ${artifact.files.length} files`}
                  variant="secondary"
                  size="sm"
                  disabled={!current}
                  onclick={() => downloadAll(artifact)}
                />
              {/if}
              <ul class="export__files" aria-label={`${artifact.title} files`}>
                {#each artifact.files as file (file.filename)}
                  <li>
                    <code>{file.filename}</code>
                    <Button
                      label="Download"
                      variant="secondary"
                      size="sm"
                      disabled={!current}
                      aria-label={`Download ${file.filename}`}
                      onclick={() => download(file)}
                    />
                    <Button
                      label="Copy"
                      variant="secondary"
                      size="sm"
                      disabled={!current}
                      aria-label={`Copy ${file.filename}`}
                      onclick={() => void copy(file)}
                    />
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#snippet footer()}
    <Button label="Close" variant="secondary" onclick={onClose} />
  {/snippet}
</Modal>

<style>
  .export {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .export p,
  .export h3 {
    margin: 0;
  }
  .export__intro,
  .export__base,
  .export__status {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
  .export__list,
  .export__files {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .export__item {
    display: grid;
    gap: 6px;
    padding: 12px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .export__item h3 {
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  .export__caveat {
    margin-inline-start: 8px;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-medium);
    color: var(--cinder-text-muted);
  }
  .export__blocked {
    color: var(--cinder-text-default);
    font-size: var(--cinder-text-sm);
  }
  .export__files {
    gap: 8px;
  }
  .export__files li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .export__files code {
    flex: 1 1 14rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
