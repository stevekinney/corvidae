<script lang="ts" module>
  export const title = 'Nested changes';
  export const description =
    "Two versions of a run's input. Added, removed and changed entries show at every depth, each led by a +, - or ~ symbol; the unchanged entries stay behind a control until asked for.";
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const before = {
    name: 'Nightly ETL',
    schedule: { cron: '0 2 * * *', timezone: 'UTC' },
    steps: [
      { name: 'extract', retries: 3 },
      { name: 'load', retries: 3 },
    ],
    owner: 'data-platform',
  };

  const after = {
    name: 'Nightly ETL',
    schedule: { cron: '0 3 * * *', timezone: 'UTC' },
    steps: [
      { name: 'extract', retries: 5 },
      { name: 'load', retries: 3 },
      { name: 'notify', retries: 0 },
    ],
    region: 'us-east-1',
  };
</script>

<JsonDiffViewer {before} {after} />
