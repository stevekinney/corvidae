<script lang="ts">
  import { Alert, Button, Input, Modal } from '@lostgradient/cinder';
  import { revokeContextShare, shareContext } from '../../lib/bureau-client.ts';
  interface Props {
    readonly sessionId: string;
    readonly onClose: () => void;
  }
  let { sessionId, onClose }: Props = $props();
  let member = $state('');
  let sending = $state(false);
  let failure = $state<string | undefined>();
  async function submit(kind: 'grant' | 'revoke'): Promise<void> {
    const granteeOwnerId = member.trim();
    if (granteeOwnerId === '' || sending) return;
    sending = true;
    failure = undefined;
    try {
      if (kind === 'grant') await shareContext({ contextId: sessionId, granteeOwnerId });
      else await revokeContextShare({ contextId: sessionId, granteeOwnerId });
      onClose();
    } catch {
      failure = 'This member could not be updated.';
    } finally {
      sending = false;
    }
  }
</script>

<Modal open title="Share chat" onDismiss={() => !sending && onClose()}>
  <p>Give a workspace member read-only access, or revoke their existing access.</p>
  <Input id="chat-share-member" label="Workspace member" bind:value={member} disabled={sending} />
  {#if failure !== undefined}<Alert variant="danger">{failure}</Alert>{/if}
  {#snippet footer()}
    <Button variant="secondary" disabled={sending} onclick={onClose}>Cancel</Button>
    <Button
      variant="secondary"
      disabled={sending || member.trim() === ''}
      onclick={() => void submit('revoke')}>Revoke access</Button
    >
    <Button
      variant="primary"
      loading={sending}
      disabled={member.trim() === ''}
      onclick={() => void submit('grant')}>Share read-only</Button
    >
  {/snippet}
</Modal>
