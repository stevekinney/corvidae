<script lang="ts" module>
  export const title = 'Button with a shortcut hint';
  export const description =
    "The shortcut prop renders a decorative key hint after the label. It is plain glyphs in the button's own color on every variant, and touch devices hide it. The accessible name stays the label.";
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <Button variant="primary" label="New task" shortcut="N" />
  <Button variant="danger" label="Delete" shortcut={['Shift', 'D']} />
  <Button label="Search" shortcut={['Ctrl', 'K']} />
  <Button variant="ghost" label="Close" shortcut="Esc" />
</div>
