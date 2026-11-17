<script lang="ts" module>
  export const title = 'Inline: a patch inside a payload';
  export const description =
    'The first two changed lines as bare rows, a +3 −1 count beside the label, and Show all with the number of lines in the patch.';
</script>

<script lang="ts">
  import { SourceDiffViewer, countPatchChanges } from '@lostgradient/cinder';

  const patch = `--- a/release-notes.md
+++ b/release-notes.md
@@ -12,3 +12,5 @@
 # Release notes
-Refunds are sent at once.
+Refunds now ask for approval before money moves.
+Large refunds go to a person.
+Nothing is sent without a note.
 Thanks for reading.
`;
  const changes = $derived(countPatchChanges(patch));
</script>

<p>Patch +{changes.added} −{changes.removed}</p>
<SourceDiffViewer {patch} variant="inline" maxLines={2} ariaLabel="Patch" />
