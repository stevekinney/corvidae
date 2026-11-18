<script lang="ts">
  import { default as Button } from '@lostgradient/button/components/button/index.ts';
  import { default as ContextMenu } from '@lostgradient/context-menu/components/context-menu/index.ts';
</script>

<ContextMenu>
  <ContextMenu.Trigger>
    <Button variant="ghost">Right-click this region</Button>
  </ContextMenu.Trigger>

  <ContextMenu.Menu>
    <ContextMenu.Item onclick={() => {}}>Cut</ContextMenu.Item>
    <ContextMenu.Item onclick={() => {}}>Copy</ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item variant="danger" onclick={() => {}}>Delete</ContextMenu.Item>
  </ContextMenu.Menu>
</ContextMenu>
