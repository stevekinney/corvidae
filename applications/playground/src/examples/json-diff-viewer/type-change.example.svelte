<script lang="ts" module>
  export const title = 'A value that changes type';
  export const description =
    'Arrays compare by index, so a changed item shows at its position. A value that changes type, here a number that becomes a string, shows as one removed and one added entry rather than one change.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const before = { timeout: 30, tags: ['etl', 'nightly', 'production'] };
  const after = { timeout: '30s', tags: ['etl', 'hourly', 'production'] };
</script>

<JsonDiffViewer {before} {after} label="Run settings differences" />
