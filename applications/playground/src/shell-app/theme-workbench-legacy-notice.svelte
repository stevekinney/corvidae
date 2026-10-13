<script lang="ts">
  /*
   * The one-time notice for the old color panel's raw session overrides (COR-490). It never
   * migrates or deletes them on its own: the user downloads the raw JSON, then clears it.
   */
  import { Button, Callout } from '@lostgradient/cinder';
  import { onMount } from 'svelte';

  import {
    clearLegacyColorOverrides,
    detectLegacyColorOverrides,
    LEGACY_OVERRIDE_NOTICE_COPY,
    type LegacyOverrideNotice,
  } from './legacy-color-override-notice.ts';

  let notice = $state.raw<LegacyOverrideNotice | null>(null);
  let failed = $state(false);

  onMount(() => {
    notice = detectLegacyColorOverrides(window.sessionStorage);
  });

  function download(): void {
    if (notice === null) return;
    const url = URL.createObjectURL(
      new Blob([notice.download.text], { type: notice.download.mime }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = notice.download.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function clear(): void {
    failed = !clearLegacyColorOverrides(window.sessionStorage);
    if (!failed) notice = null;
  }
</script>

{#if notice !== null}
  <div data-testid="legacy-override-notice">
    <Callout variant="info" title="Old color panel overrides found">
      <p>{LEGACY_OVERRIDE_NOTICE_COPY}</p>
      {#if failed}
        <p>The overrides could not be cleared. Try again.</p>
      {/if}
      <Button label="Download overrides (JSON)" variant="secondary" onclick={download} />
      <Button label="Clear overrides" variant="secondary" onclick={clear} />
    </Callout>
  </div>
{/if}
