<script lang="ts">
  import {
    Button,
    NavigationBar,
    NavigationItem,
    ToastRegion,
    useToast,
  } from '@lostgradient/cinder';
  let undoCount = $state(0);
  let pauseCount = $state(0);

  // COR-2327: a phone's bottom tab bar under the toasts, drawn only behind a query parameter so the
  // default fixture, its baselines and its axe sweep stay as they are.
  const bottomTabBar =
    new URLSearchParams(globalThis.location.search).get('bottom-tab-bar') === '1';
</script>

<ToastRegion>
  {#snippet children()}
    {@const toast = useToast()}
    <div class="example-preview-row">
      <Button
        label="Dismiss-after-action"
        onclick={() =>
          toast.show('Item moved to trash.', {
            variant: 'info',
            duration: 0,
            action: {
              label: 'Undo',
              onAction: () => (undoCount += 1),
            },
          })}
      />
      <Button
        variant="secondary"
        label="Keep open after action"
        onclick={() =>
          toast.show('Syncing in the background…', {
            variant: 'info',
            duration: 0,
            action: {
              label: 'Pause',
              keepOpen: true,
              onAction: () => (pauseCount += 1),
            },
          })}
      />
    </div>
    <p style="margin-top: 0.75rem; font-size: 0.875rem;">
      Undo fired: {undoCount} · Pause fired: {pauseCount}
    </p>
    {#if bottomTabBar}
      <div data-testid="bottom-tab-bar" style="position: fixed; inset-inline: 0; bottom: 0;">
        <NavigationBar placement="bottom" label="Tabs">
          {#snippet items({ variant })}
            <NavigationItem {variant} href="#home" active>Home</NavigationItem>
            <NavigationItem {variant} href="#chat">Chat</NavigationItem>
            <NavigationItem {variant} href="#runs">Runs</NavigationItem>
          {/snippet}
        </NavigationBar>
      </div>
    {/if}
  {/snippet}
</ToastRegion>
