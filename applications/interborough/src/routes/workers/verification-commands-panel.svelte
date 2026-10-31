<script lang="ts">
  /**
   * Copyable `weft codegen` and `weft worker verify` commands (COR-162),
   * exactly as `src/cli/help-text.ts` documents them, with file names the
   * dashboard can derive substituted in.
   */
  import { CopyButton } from '@lostgradient/cinder';

  import {
    verificationCommands,
    type VerificationCommandContext,
  } from './contract-verification.ts';

  interface VerificationCommandsPanelProps {
    readonly context: VerificationCommandContext;
    readonly headingId: string;
  }

  let { context, headingId }: VerificationCommandsPanelProps = $props();

  const commands = $derived(verificationCommands(context));
</script>

<section class="weft-workers-panel weft-verification-commands" aria-labelledby={headingId}>
  <h3 id={headingId} class="weft-workers-panel__title">Verify from the command line</h3>
  <p class="weft-verification-commands__note">
    Save the registry snapshot as <code>{commands.registryFile}</code> and the worker manifest as
    <code>{commands.manifestFile}</code>, then run either command. <code>weft worker verify</code>
    also checks each activity's contract hash.
  </p>

  <div class="weft-verification-commands__row">
    <span class="weft-verification-commands__label">Generate registry types</span>
    <CopyButton
      value={commands.codegen}
      label="Copy weft codegen command"
      copiedLabel="weft codegen command copied"
    />
  </div>
  <pre class="weft-verification-commands__command"><code>{commands.codegen}</code></pre>

  <div class="weft-verification-commands__row">
    <span class="weft-verification-commands__label">Verify the worker manifest</span>
    <CopyButton
      value={commands.workerVerify}
      label="Copy weft worker verify command"
      copiedLabel="weft worker verify command copied"
    />
  </div>
  <pre class="weft-verification-commands__command"><code>{commands.workerVerify}</code></pre>
</section>

<style>
  .weft-verification-commands {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .weft-verification-commands__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  .weft-verification-commands__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  /* A command wraps instead of scrolling: a long file name would otherwise be a swipe or two past the pane. */
  .weft-verification-commands__command {
    margin: 0;
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    background: var(--cinder-surface-inset);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .weft-verification-commands__label {
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }
</style>
