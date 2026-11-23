/**
 * How a failure's category is drawn on a badge: its label and its tone (COR-2533). The category is
 * one of the engine's five (`application`, `timeout`, `cancellation`, `resource`, `system`), `null`
 * for a failure it could not sort, and `undefined` for a run that never failed.
 *
 * Nothing here says why a run failed. The sentence, the cause, the step and what to do next come
 * from `bureau.tasks.explain`, so the Run page, Chat, the CLI and the failure explanation panel give
 * one answer and the browser holds no explanation text per category. `run-failure-explanation.svelte`
 * draws that answer, with this badge beside it, through the one component the failure explanation
 * panel draws it with; the label and the tone are that component's, so the badge reads the same on
 * both.
 */
export {
  failureCategoryLabel,
  failureCategoryTone,
} from '@lostgradient/interborough-plugin/failure-explanation';
