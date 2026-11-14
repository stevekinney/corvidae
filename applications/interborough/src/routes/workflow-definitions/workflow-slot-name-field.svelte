<script lang="ts">
  /**
   * The name of a case or of a list of side-by-side steps. It is a key of the step's object, so two
   * cannot share one and none can be empty: a name another holds is said at the field and written
   * nowhere, and the field keeps what was typed, so the person fixes it where they are.
   */
  import { Input } from '@lostgradient/cinder';

  interface Props {
    id: string;
    /** The visible label, and the accessible name, which says which case or list it is in. */
    label: string;
    accessibleName: string;
    /** The name the file holds. */
    name: string;
    /** The names the step's other cases or lists hold. */
    taken: readonly string[];
    /** What it says when the typed name is another's. */
    takenText: string;
    onRename: (next: string) => void;
    variant?: 'code' | 'default';
  }

  let {
    id,
    label,
    accessibleName,
    name,
    taken,
    takenText,
    onRename,
    variant = 'code',
  }: Props = $props();

  // What is typed, which differs from `name` while it is empty or another's.
  // svelte-ignore state_referenced_locally
  let draft = $state(name);
  // svelte-ignore state_referenced_locally
  let lastName = name;

  // A name the file changed (the JSON tab, a move that renamed it) replaces what was typed.
  $effect.pre(() => {
    if (name === lastName) return;
    lastName = name;
    draft = name;
  });

  const clash = $derived(draft !== name && taken.includes(draft));

  function change(next: string): void {
    draft = next;
    if (next === '' || taken.includes(next)) return;
    onRename(next);
  }
</script>

<Input
  {id}
  {label}
  aria-label={accessibleName}
  {variant}
  size="sm"
  required
  {...clash ? { error: takenText } : {}}
  value={draft}
  onValueChange={change}
/>
