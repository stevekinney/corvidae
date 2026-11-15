<script lang="ts">
  /**
   * The name of a case or of a list of side-by-side steps. It is a key of the step's object, so two
   * cannot share one and none can be empty, and an object holds a key that looks like a whole number
   * ahead of the others: typing "2" would move its case to the front while the person is still
   * typing in the field of another. So the name is written when the person leaves the field or
   * presses Enter, and what is typed is kept until then. A name another case or list holds is said
   * at the field and written nowhere, and the field keeps what was typed, so the person fixes it
   * where they are.
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

  // What is typed, which differs from `name` until it is written, and while it is empty or another's.
  // svelte-ignore state_referenced_locally
  let draft = $state(name);
  // svelte-ignore state_referenced_locally
  let lastName = name;

  // A name the file changed (the JSON tab, a rename that moved the case) replaces what was typed.
  $effect.pre(() => {
    if (name === lastName) return;
    lastName = name;
    draft = name;
  });

  const clash = $derived(draft !== name && taken.includes(draft));

  /** Writes the typed name, when it is a name the step can hold. */
  function commit(): void {
    if (draft === name || draft === '' || taken.includes(draft)) return;
    onRename(draft);
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
  onValueChange={(next) => (draft = next)}
  onblur={commit}
  onkeydown={(event) => {
    if (event.key === 'Enter') commit();
  }}
/>
