import './source-diff-viewer.css';
import SourceDiffViewer from './source-diff-viewer.svelte';

export default SourceDiffViewer;
export { getSourceDiffFileLabel, getSourceDiffLineLabel } from './source-diff-viewer.labels.ts';
export type {
  SourceDiffAnnotationSelection,
  SourceDiffAnnotationSide,
  SourceDiffChangeCounts,
  SourceDiffFile,
  SourceDiffFileAnnotationContext,
  SourceDiffFileDescriptor,
  SourceDiffHunk,
  SourceDiffLine,
  SourceDiffLineAnnotationContext,
  SourceDiffLineKind,
  SourceDiffParseResult,
  SourceDiffViewerFocusResult,
  SourceDiffViewerProps,
  SourceDiffViewerRef,
  SourceDiffViewerVariant,
} from './source-diff-viewer.types.ts';
export { countPatchChanges, parseUnifiedPatch } from './source-diff-viewer.utilities.ts';
export { SourceDiffViewer };
