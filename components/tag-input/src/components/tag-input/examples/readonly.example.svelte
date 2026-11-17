<script lang="ts" module>
  export const title = 'Read-only tags';
  export const description =
    'With `readonly`, the committed tags stay visible but cannot be removed and the pending-tag input rejects new entries — distinct from `disabled`, which also dims the whole control.';
</script>

<script lang="ts">
  import { FormField } from '@lostgradient/form-field';
  import { TagInput } from '@lostgradient/tag-input';
</script>

<FormField
  id="readonly-tag-input"
  label="Applied filters"
  description="These filters are fixed for this report and cannot be edited."
>
  <TagInput readonly value={['Svelte', 'Bun', 'TypeScript']} />
</FormField>
