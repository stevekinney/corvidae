<script lang="ts" module>
  export const title = 'Read-only with a description';
  export const description =
    'A switch that shows a setting something else owns, such as a schedule defined in a file. It stays focusable and is announced as read-only, a press changes nothing, and the description names where the value comes from.';
</script>

<script lang="ts">
  import { Toggle } from '@lostgradient/cinder';
</script>

<Toggle
  id="schedule-active"
  label="Active"
  checked
  readonly
  description="Defined in workflows/release-notes.json"
/>
