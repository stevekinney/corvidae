<script lang="ts">
  import {
    Button,
    DockedActionBar,
    NavigationBar,
    NavigationItem,
    ToastRegion,
    dockedToBottom,
    useToast,
  } from '@lostgradient/cinder';
  let undoCount = $state(0);
  let pauseCount = $state(0);

  // COR-2327: a phone's bottom tab bar under the toasts, drawn only behind a query parameter so the
  // default fixture, its baselines and its axe sweep stay as they are. `docked-stack=1` stacks a
  // docked action bar on the tab bar, as a page's actions sit on a phone shell's tabs.
  // `docked-surface=1` docks a surface of the page's own (a chat's composer, with a reminder row
  // above it) through `dockedToBottom()`, on the tab bar when `bottom-tab-bar=1` asks for one too.
  const parameters = new URLSearchParams(globalThis.location.search);
  const dockedStack = parameters.get('docked-stack') === '1';
  const dockedSurface = parameters.get('docked-surface') === '1';
  const bottomTabBar = dockedStack || parameters.get('bottom-tab-bar') === '1';
  // COR-2426: a phone shell's page as Interborough lays it out: a column the height of the
  // viewport, a scrolling page above the tab bar, and a docked action bar at the end of a page taller
  // than the screen, so its actions stay in view above the tabs before anything is scrolled. The
  // scrolling page keeps its end room as a spacer after the content, not bottom padding, as
  // Interborough's outlet does, so the bar sits flush on the tabs.
  const dockedPage = parameters.get('docked-page') === '1';
</script>

{#snippet tabBar()}
  <NavigationBar placement="bottom" label="Tabs">
    {#snippet items({ variant })}
      <NavigationItem {variant} href="#home" active>Home</NavigationItem>
      <NavigationItem {variant} href="#chat">Chat</NavigationItem>
      <NavigationItem {variant} href="#runs">Runs</NavigationItem>
    {/snippet}
  </NavigationBar>
{/snippet}

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
    <p style="margin-top: var(--cinder-space-3); font-size: var(--cinder-text-base);">
      <strong>Undo fired:</strong>
      {undoCount} <strong>Pause fired:</strong>
      {pauseCount}
    </p>
    {#if dockedPage}
      <div
        data-testid="docked-page"
        style="position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--cinder-surface);"
      >
        <div
          data-testid="docked-page-scroll"
          style="flex: 1; min-block-size: 0; overflow-y: auto; display: flex; flex-direction: column; padding: var(--cinder-space-3) var(--cinder-space-3) 0;"
        >
          <h2 style="margin: 0 0 var(--cinder-space-2);">Release notes for 2.4</h2>
          {#each Array.from({ length: 24 }, (_, index) => index) as line (line)}
            <p style="margin: 0 0 var(--cinder-space-2);">
              Line {line + 1} of the draft the workflow asks about.
            </p>
          {/each}
          <DockedActionBar label="Decision">
            <p style="margin: 0;">The workflow continues as soon as you answer.</p>
            {#snippet actions()}
              <Button variant="secondary" label="Send back" />
              <Button variant="primary" label="Approve" />
            {/snippet}
          </DockedActionBar>
          <div aria-hidden="true" style="flex: none; block-size: var(--cinder-space-3);"></div>
        </div>
        {@render tabBar()}
      </div>
    {/if}
    {#if bottomTabBar || dockedSurface}
      <!-- One column fixed to the bottom, as a phone shell's page sits on its tabs: whatever is
           docked above the tab bar ends where the tab bar starts. -->
      <div
        data-testid="bottom-tab-bar"
        style="position: fixed; inset-inline: 0; bottom: 0; display: flex; flex-direction: column;"
      >
        {#if dockedSurface}
          <div
            data-testid="docked-surface"
            style="display: grid; gap: var(--cinder-space-2); padding: var(--cinder-space-3); border-top: var(--cinder-border-width) solid var(--cinder-border); background: var(--cinder-surface);"
            {@attach dockedToBottom()}
          >
            <p style="margin: 0;">An approval is waiting above.</p>
            <textarea aria-label="Message" rows="3" style="inline-size: 100%;"></textarea>
          </div>
        {/if}
        {#if dockedStack}
          <DockedActionBar label="Run actions">
            {#snippet actions()}
              <Button variant="secondary" label="Send a message" />
              <Button variant="secondary" label="Cancel run" />
            {/snippet}
          </DockedActionBar>
        {/if}
        {#if bottomTabBar}
          {@render tabBar()}
        {/if}
      </div>
    {/if}
  {/snippet}
</ToastRegion>
