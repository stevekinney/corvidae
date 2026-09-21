<script lang="ts">
  import { Button, ContextMenu } from '@lostgradient/cinder';
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
