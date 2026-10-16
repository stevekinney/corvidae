<script lang="ts">
  /**
   * The canonical `weft codegen` and `weft worker verify` commands, copyable (COR-162). The
   * dashboard computes drift itself, but the CLI is the authority a deploy pipeline runs, so the
   * exact commands sit beside the result with the manifest file named after the deployment and
   * build the dashboard already knows.
   */
  import { CodeBlock } from '@lostgradient/cinder';

  import {
    REGISTRY_SNAPSHOT_FILE,
    manifestFileName,
    verificationCommands,
  } from './contract-verification.ts';

  interface ContractVerificationCommandsProps {
    readonly identity?: Readonly<{ deploymentName: string; buildId: string }> | undefined;
  }

  let { identity = undefined }: ContractVerificationCommandsProps = $props();
  const uid = $props.id();

  const commands = $derived(verificationCommands(identity));
</script>

<section class="weft-verification-commands" aria-labelledby={`${uid}-heading`}>
  <h3 id={`${uid}-heading`}>Verify from the command line</h3>
  <p class="weft-verification-commands__note">
    Save the registry snapshot as <code>{REGISTRY_SNAPSHOT_FILE}</code> and the worker manifest as
    <code>{manifestFileName(identity)}</code>, then run:
  </p>
  <div class="weft-verification-commands__command">
    <span class="weft-verification-commands__label" id={`${uid}-codegen`}
      >Generate typed declarations</span
    >
    <div aria-labelledby={`${uid}-codegen`} role="group">
      <CodeBlock code={commands.codegen} copyable highlight={false} languageLabelVisible={false} />
    </div>
  </div>
  <div class="weft-verification-commands__command">
    <span class="weft-verification-commands__label" id={`${uid}-verify`}
      >Verify the manifest against the registry</span
    >
    <div aria-labelledby={`${uid}-verify`} role="group">
      <CodeBlock code={commands.verify} copyable highlight={false} languageLabelVisible={false} />
    </div>
  </div>
</section>

<style>
  .weft-verification-commands {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .weft-verification-commands h3 {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .weft-verification-commands__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }
  .weft-verification-commands__command {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .weft-verification-commands__label {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
