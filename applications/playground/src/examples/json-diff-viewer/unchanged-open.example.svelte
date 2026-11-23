<script lang="ts" module>
  export const title = 'Unchanged entries shown';
  export const description =
    'Pressing "Show N unchanged entries" reveals what did not change, each row led by an = symbol, and the control reads "Hide" with its chevron turned up. The example presses the controls once on mount so the open state is visible.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const before = {
    name: 'Nightly ETL',
    region: 'us-east-1',
    schedule: { cron: '0 2 * * *', timezone: 'UTC' },
    retries: 3,
  };
  const after = {
    name: 'Nightly ETL',
    region: 'us-east-1',
    schedule: { cron: '0 3 * * *', timezone: 'UTC' },
    retries: 5,
  };

  let host: HTMLElement | undefined = $state();

  // The viewer starts with unchanged entries collapsed, so press each closed control once.
  $effect(() => {
    for (const control of host?.querySelectorAll<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    ) ?? []) {
      control.click();
    }
  });
</script>

<div bind:this={host}>
  <JsonDiffViewer {before} {after} label="Run settings differences" />
</div>
