<script lang="ts">
  import {
    Accordion,
    AccordionItem,
    ActionRow,
    Button,
    Card,
    Input,
    Modal,
    Toggle,
  } from '@repo/cinder';

  let expandedIds = $state<string[]>(['token-accordion']);
  let modalOpen = $state(false);
  let triggerRef = $state<HTMLElement | null>(null);
</script>

<main class="token-fixture">
  <section aria-label="Buttons">
    <Button label="Animated button" />
    <Button
      disabled
      iconOnly
      label="Disabled close"
      variant="ghost"
      data-testid="button-ghost-icon-only-disabled"
    >
      <span aria-hidden="true">×</span>
    </Button>
    <Button
      disabled
      variant="secondary"
      label="Disabled secondary"
      data-testid="button-secondary-disabled"
    />
    <Button
      label="Invite teammate"
      onclick={(event) => {
        triggerRef = event.currentTarget;
        modalOpen = true;
      }}
    />
  </section>

  <Card title="Token card">Card content</Card>
  <Input id="token-input" label="Token input" value="Uses border token" />

  <Accordion bind:expandedIds>
    <AccordionItem id="token-accordion" title="Token accordion">
      <p>Accordion content</p>
    </AccordionItem>
  </Accordion>

  <ActionRow>
    {#snippet title()}Action row{/snippet}
    {#snippet description()}Consume-only row{/snippet}
  </ActionRow>

  <Toggle id="token-toggle" label="Token toggle" />

  <Modal bind:open={modalOpen} title="Invite teammate" {triggerRef}>
    <p>Invite form</p>
  </Modal>
</main>

<style>
  .token-fixture {
    display: grid;
    gap: 1rem;
    max-inline-size: 48rem;
    margin-inline: auto;
  }
  section {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
</style>
