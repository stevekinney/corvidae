<script lang="ts">
  /*
   * The local theme library: a theme switcher; create, rename (a conflict keeps the dialog
   * open with the error on the field), duplicate; delete, which names the theme and moves it
   * to Trash; the Trash view with Restore; and permanent deletion behind its own
   * confirmation whose copy names the loss of the embedded base, draft and history.
   */
  import { Button, ConfirmDialog, Input, Modal, Select } from '@lostgradient/cinder';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { trashedThemes } from './theme-library.ts';

  type Props = { controller: ThemeBuilderController };
  let { controller }: Props = $props();

  type NameDialog = { mode: 'create' | 'rename'; id: string | null } | null;
  let nameDialog = $state<NameDialog>(null);
  let nameText = $state('');
  let nameError = $state<string | undefined>(undefined);
  let deleting = $state<string | null>(null);
  let trashOpen = $state(false);
  let permanent = $state<string | null>(null);
  let notice = $state('');

  const activeId = $derived(controller.library.activeId);
  const name = $derived(controller.draft?.envelope.name ?? '');
  const options = $derived(
    controller.activeThemes.map((entry) => ({
      value: entry.draft.envelope.id,
      label: entry.draft.envelope.name,
    })),
  );
  const trash = $derived(trashedThemes(controller.library));
  const nameOf = (id: string | null): string =>
    id === null ? '' : (controller.library.entries[id]?.draft.envelope.name ?? '');

  function openName(mode: 'create' | 'rename'): void {
    nameDialog = { mode, id: activeId };
    nameText = mode === 'rename' ? name : '';
    nameError = undefined;
  }

  async function submitName(): Promise<void> {
    if (nameDialog === null) return;
    const result =
      nameDialog.mode === 'create'
        ? await controller.createTheme(nameText)
        : nameDialog.id === null
          ? { ok: false as const, message: 'That theme no longer exists.' }
          : controller.renameTheme(nameDialog.id, nameText);
    if (result.ok) nameDialog = null;
    else nameError = result.message;
  }

  async function confirmDelete(): Promise<void> {
    const id = deleting;
    deleting = null;
    if (id !== null) await controller.deleteTheme(id);
  }

  async function confirmPermanent(): Promise<void> {
    const id = permanent;
    permanent = null;
    if (id !== null) {
      const result = await controller.permanentlyDeleteTheme(id);
      notice = result.ok ? '' : result.message;
    }
  }
</script>

<section class="library" aria-label="Theme library" data-testid="theme-library">
  <div class="library__switcher">
    <Select
      id="theme-builder-theme-switcher"
      label="Theme"
      {options}
      value={activeId ?? ''}
      onchange={(event) => void controller.switchTheme(event.currentTarget.value)}
    />
  </div>
  <div class="library__actions" role="group" aria-label="Theme actions">
    <Button label="New theme" variant="secondary" size="sm" onclick={() => openName('create')} />
    <Button label="Rename" variant="secondary" size="sm" onclick={() => openName('rename')} />
    <Button
      label="Duplicate"
      variant="secondary"
      size="sm"
      onclick={() => activeId !== null && void controller.duplicateTheme(activeId)}
    />
    <Button label="Delete" variant="secondary" size="sm" onclick={() => (deleting = activeId)} />
    <Button
      label={`Trash (${trash.length})`}
      variant="secondary"
      size="sm"
      onclick={() => (trashOpen = true)}
    />
  </div>
  {#if notice !== ''}
    <p class="library__error" role="alert">{notice}</p>
  {/if}
</section>

<Modal
  open={nameDialog !== null}
  title={nameDialog?.mode === 'rename' ? 'Rename theme' : 'New theme'}
  onDismiss={() => (nameDialog = null)}
  describedById="theme-name-description"
>
  <p id="theme-name-description">
    {nameDialog?.mode === 'rename'
      ? `Current name: ${nameOf(nameDialog.id)}. Names are 1 to 80 characters and unique.`
      : 'Names are 1 to 80 characters and unique.'}
  </p>
  <form
    id="theme-name-form"
    onsubmit={(event) => {
      event.preventDefault();
      void submitName();
    }}
  >
    <Input
      id="theme-name-input"
      label="Theme name"
      value={nameText}
      {...nameError === undefined ? {} : { error: nameError }}
      onValueChange={(next) => {
        nameText = next;
        nameError = undefined;
      }}
    />
  </form>
  {#snippet footer()}
    <Button label="Cancel" variant="secondary" onclick={() => (nameDialog = null)} />
    <Button
      label={nameDialog?.mode === 'rename' ? 'Rename' : 'Create'}
      variant="primary"
      type="submit"
      form="theme-name-form"
    />
  {/snippet}
</Modal>

<ConfirmDialog
  open={deleting !== null}
  title={`Move “${nameOf(deleting)}” to Trash?`}
  description={`“${nameOf(deleting)}” moves to Trash. You can restore it from Trash until you delete it permanently.`}
  confirmLabel="Move to Trash"
  destructive
  onConfirm={() => void confirmDelete()}
  onCancel={() => (deleting = null)}
/>

<Modal open={trashOpen} title="Trash" onDismiss={() => (trashOpen = false)}>
  {#if trash.length === 0}
    <p>Trash is empty.</p>
  {:else}
    <ul class="trash" aria-label="Themes in Trash">
      {#each trash as entry (entry.draft.envelope.id)}
        <li>
          <span>{entry.draft.envelope.name}</span>
          <Button
            label="Restore"
            variant="secondary"
            size="sm"
            aria-label={`Restore ${entry.draft.envelope.name}`}
            onclick={async () => {
              await controller.restoreTheme(entry.draft.envelope.id);
              trashOpen = false;
            }}
          />
          <Button
            label="Delete permanently"
            variant="danger"
            size="sm"
            aria-label={`Delete ${entry.draft.envelope.name} permanently`}
            onclick={() => (permanent = entry.draft.envelope.id)}
          />
        </li>
      {/each}
    </ul>
  {/if}
</Modal>

<ConfirmDialog
  open={permanent !== null}
  title={`Permanently delete “${nameOf(permanent)}”?`}
  description={permanent === null ? '' : controller.permanentDeleteCopy(permanent)}
  confirmLabel="Delete permanently"
  destructive
  onConfirm={() => void confirmPermanent()}
  onCancel={() => (permanent = null)}
/>

<style>
  .library {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px 12px;
    min-width: 0;
  }
  .library__switcher {
    flex: 1 1 12rem;
    max-width: 18rem;
    min-width: 0;
  }
  .library__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .library__error {
    flex: 1 1 100%;
    margin: 0;
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
  }
  .trash {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .trash li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .trash span {
    flex: 1 1 8rem;
    overflow-wrap: anywhere;
  }
</style>
