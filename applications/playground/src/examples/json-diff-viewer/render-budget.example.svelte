<script lang="ts" module>
  export const title = 'A comparison too large to open at once';
  export const description =
    'Nested levels add up, so the first render opens a nested level only while the whole render stays small. Here five runs each changed 150 fields: the first run opens, and the rest wait behind a "Show 150 changes" control.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const run = (offset: number) =>
    Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`field-${index}`, offset + index]),
    );

  const before = { runs: [0, 1, 2, 3, 4].map((index) => run(index)) };
  const after = { runs: [0, 1, 2, 3, 4].map((index) => run(index + 1000)) };
</script>

<JsonDiffViewer {before} {after} label="Run differences" />
