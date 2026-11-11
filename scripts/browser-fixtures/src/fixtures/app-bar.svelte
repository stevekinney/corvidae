<script lang="ts">
  import { AppBar } from '@lostgradient/cinder';
</script>

{#snippet shareIcon()}
  <svg class="cinder-icon-md" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
  </svg>
{/snippet}

<AppBar
  title="Death & Co"
  headingLevel={1}
  back={{ href: '/' }}
  actions={[{ label: 'Share', icon: shareIcon, onclick: () => {} }]}
/>
