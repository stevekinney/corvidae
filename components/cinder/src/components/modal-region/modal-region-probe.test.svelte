<script lang="ts">
  import type { ModalApi } from '@lostgradient/foundation/_internal/modal-context.ts';
  import { useModal } from '@lostgradient/foundation/utilities/use-modal.ts';

  let { onReady }: { onReady: (api: ModalApi) => void } = $props();
  const api = useModal();

  $effect(() => {
    onReady(api);
  });
</script>
