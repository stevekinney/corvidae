<script lang="ts">
  import { default as Progress } from '@lostgradient/progress/components/progress/index.ts';
</script>

<div class="fixture-stack">
  <Progress value={50} label="Upload progress" ariaLabel="Upload progress" />
  <Progress value={75} label="Processing progress" ariaLabel="Processing progress" />
  <Progress value={100} label="Complete" ariaLabel="Complete" />
</div>
