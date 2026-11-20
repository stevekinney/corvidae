<script lang="ts">
  import { Textarea } from '@lostgradient/cinder';

  let bio = $state('');
</script>

<Textarea
  id="field"
  bind:value={bio}
  label="Bio"
  description="Tell us a little about yourself."
  placeholder="I'm a designer who…"
/>
{#if bio.length > 0}
  <p class="margin-block-start-2 text-muted">
    {bio.length} characters
  </p>
{/if}
