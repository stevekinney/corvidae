import type { BestPracticeSection, BestPracticeTopic } from './types.js';

export const bestPracticeSections: Record<
  Exclude<BestPracticeTopic, 'all'>,
  BestPracticeSection
> = {
  imports: {
    topic: 'imports',
    title: 'Imports',
    guidance: [
      'Import named components from @lostgradient/cinder or a default component from its subpath, such as @lostgradient/cinder/button.',
      'Import the aggregate stylesheet from @lostgradient/cinder/styles or a published component stylesheet such as @lostgradient/cinder/button/styles.',
      'Use the kebab-case manifest id when cross-referencing components in tools or generated code.',
    ],
  },
  styles: {
    topic: 'styles',
    title: 'Styles',
    guidance: [
      'The @lostgradient/cinder root entry loads aggregate CSS in Svelte and browser builds. The stylesheet declares cascade layer order, tokens, foundation rules, utilities, and shared internal chrome.',
      'Override public --cinder-* tokens and component root classes; do not redefine private --_cinder-* variables.',
    ],
  },
  metadata: {
    topic: 'metadata',
    title: 'Metadata',
    guidance: [
      'Read @lostgradient/cinder first; it is the authoritative component index for agents.',
      'Use schema and variables artifacts for prop contracts and CSS custom-property names.',
      'Fetch examples only when hasExamples is true and constraints only when hasConstraints is true.',
      'Treat constraints as the source for cross-prop rules that JSON Schema cannot express cleanly.',
    ],
  },
  overlap: {
    topic: 'overlap',
    title: 'Overlap Decisions',
    guidance: [
      'Use overlapFamilies when multiple components solve similar problems.',
      'Prefer each candidate component useWhen and avoidWhen guidance over name similarity.',
      'Compare related components before introducing bespoke UI for overlays, notices, selection controls, hover surfaces, or tabs.',
      'When no Cinder component fits, compose from Cinder primitives before introducing a fully bespoke surface.',
    ],
  },
};
