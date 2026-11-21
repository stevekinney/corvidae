<script lang="ts" module>
  export const title = 'More than 200 changes in one level';
  export const description =
    'A level shows its first 200 changed entries and holds the rest behind a control that shows 200 more. Here 450 values changed, so two presses reveal them all.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const before = Object.fromEntries(
    Array.from({ length: 450 }, (_, index) => [`setting-${index}`, index]),
  );
  const after = Object.fromEntries(
    Array.from({ length: 450 }, (_, index) => [`setting-${index}`, index + 1]),
  );
</script>

<JsonDiffViewer {before} {after} label="Settings differences" />
