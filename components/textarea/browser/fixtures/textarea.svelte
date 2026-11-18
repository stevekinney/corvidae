<script lang="ts">
  import { default as Textarea } from '@lostgradient/textarea/components/textarea/index.ts';

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
  <p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">{bio.length} characters</p>
{/if}
