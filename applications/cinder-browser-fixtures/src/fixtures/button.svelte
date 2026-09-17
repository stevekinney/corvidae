<script lang="ts">
  import { Button } from '@repo/cinder';
</script>

<div class="example-preview-column">
  <div class="example-preview-row">
    <Button iconOnly label="Close" variant="ghost" data-testid="button-ghost-icon-only-rest">
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg
        >{/snippet}
    </Button>
    <Button
      iconOnly
      label="Delete"
      variant="ghost-danger"
      data-testid="button-ghost-danger-icon-only-rest"
    >
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg
        >{/snippet}
    </Button>
    <Button iconOnly label="Search" variant="secondary">
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><circle cx="11" cy="11" r="8" /></svg
        >{/snippet}
    </Button>
    <Button variant="ghost" label="Share" data-testid="button-ghost-text-share">
      {#snippet leadingIcon()}<svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M18 8V6h-2M18 6l-7 7" /></svg
        >{/snippet}
    </Button>
  </div>
  <div class="example-preview-row">
    <Button
      disabled
      iconOnly
      label="Disabled close"
      variant="ghost"
      data-testid="button-ghost-icon-only-disabled"
    >
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg
        >{/snippet}
    </Button>
    <Button
      disabled
      iconOnly
      label="Disabled delete"
      variant="ghost-danger"
      data-testid="button-ghost-danger-icon-only-disabled"
    >
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg
        >{/snippet}
    </Button>
    <Button
      href="#disabled-close"
      aria-disabled="true"
      iconOnly
      label="Unavailable close link"
      variant="ghost"
      data-testid="button-ghost-icon-only-aria-disabled-link"
    >
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg
        >{/snippet}
    </Button>
    <Button
      href="#disabled-delete"
      aria-disabled="true"
      iconOnly
      label="Unavailable delete link"
      variant="ghost-danger"
      data-testid="button-ghost-danger-icon-only-aria-disabled-link"
    >
      {#snippet leadingIcon()}<svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg
        >{/snippet}
    </Button>
  </div>
</div>
