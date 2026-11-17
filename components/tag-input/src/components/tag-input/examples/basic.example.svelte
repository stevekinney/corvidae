<script lang="ts" module>
  export const title = 'Basic tag input';
  export const description = 'Commit free-form tags with Enter or a comma delimiter.';
</script>

<script lang="ts">
  import { FormField } from '@lostgradient/form-field';
  import { TagInput } from '@lostgradient/tag-input';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-field`);
</script>

<FormField
  id={fieldId}
  label="Topics"
  description="Press Enter or comma to turn the current text into a tag."
>
  <TagInput placeholder="Add a topic…" />
</FormField>
