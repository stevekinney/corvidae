<script lang="ts" module>
  export const title = 'Controls on two levels';
  export const description =
    'The settings level ends in its own "Show 2 unchanged entries" control, and the top level has one directly under it. On a touch screen each keeps its 44px target with room between them, so a tap on one never lands on the other.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const before = {
    settings: { retries: 3, timeout: 30, region: 'us-east-1' },
    name: 'Nightly ETL',
  };
  const after = {
    settings: { retries: 5, timeout: 30, region: 'us-east-1' },
    name: 'Nightly ETL',
  };
</script>

<JsonDiffViewer {before} {after} label="Run differences" />
