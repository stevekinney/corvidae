/**
 * The styles every inspector page adds to Cinder's (COR-2218). Colors, type, controls and focus
 * rings come from Cinder through `@lostgradient/cinder/panel`, whose tokens follow the host's theme
 * in light and dark, so what is left here is layout: the page's padding, the gap between sections,
 * and the plain lists. Every value is a Cinder token, never a color or a font of its own.
 */
export const BASE_STYLES = `
body{margin:0;padding:var(--cinder-space-3) var(--cinder-space-4)}
.panel-page{display:flex;flex-direction:column;gap:var(--cinder-space-4)}
.panel-status{margin:0 0 var(--cinder-space-2);color:var(--cinder-text-muted);font-size:var(--cinder-text-sm)}
.panel-status:empty{display:none}
.panel-list{margin:var(--cinder-space-1) 0;padding-inline-start:var(--cinder-space-5)}
`;

/** The pending-review page's styles: the shared ones plus its reviews, their details and their actions. */
export const PENDING_REVIEW_STYLES = `${BASE_STYLES}
.panel-list li{white-space:pre-wrap;overflow-wrap:anywhere}
.panel-actions{display:flex;flex-wrap:wrap;gap:var(--cinder-space-2);margin-top:var(--cinder-space-2)}
.panel-outcome{margin:var(--cinder-space-2) 0 0}
.panel-reject{margin-top:var(--cinder-space-3);display:flex;flex-direction:column;gap:var(--cinder-space-2)}
`;

/**
 * The run timeline's styles: the shared ones plus its step rows and waterfall tracks. A track is as
 * wide as the run, so the rows read as one chart; a bar's color says the step's status, and the
 * words beside it say the same, so color is never the only signal.
 */
export const RUN_TIMELINE_STYLES = `${BASE_STYLES}
.panel-notice{margin:var(--cinder-space-2) 0 0;color:var(--cinder-text-muted)}
.timeline-summary{margin:var(--cinder-space-1) 0 0;color:var(--cinder-text-muted);font-size:var(--cinder-text-sm)}
.timeline-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.timeline-step{display:flex;flex-direction:column;gap:var(--cinder-space-1);padding:var(--cinder-space-2) 0;border-top:1px solid var(--cinder-border-muted)}
.timeline-step:first-child{border-top:0}
.timeline-step__head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--cinder-space-2)}
.timeline-step__name{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--cinder-space-2);min-width:0}
.timeline-step__label{overflow-wrap:anywhere;font-weight:var(--cinder-font-semibold)}
.timeline-step__type{font:var(--cinder-text-xs)/1.4 var(--cinder-font-mono);color:var(--cinder-text-subtle)}
.timeline-step__track{position:relative;display:block;inline-size:100%;block-size:var(--cinder-space-2);border-radius:var(--cinder-radius-sm);background:var(--cinder-surface-inset);overflow:hidden}
.timeline-step__bar{position:absolute;inset-block:0;border-radius:var(--cinder-radius-sm);background:var(--cinder-status-success-solid)}
.timeline-step__bar[data-status=failed],.timeline-step__bar[data-status=timed-out]{background:var(--cinder-status-danger-solid)}
.timeline-step__bar[data-status=running]{background:var(--cinder-accent-solid)}
.timeline-step__bar[data-status=cancelled],.timeline-step__bar[data-status=ended]{background:var(--cinder-text-disabled)}
.timeline-step__bar[data-open]{background:linear-gradient(to right,var(--cinder-accent-solid),transparent)}
.timeline-step__meta{display:flex;gap:var(--cinder-space-3);margin:0;font-size:var(--cinder-text-xs);color:var(--cinder-text-subtle)}
.timeline-step__tries[data-retried]{color:var(--cinder-status-warning-text);font-weight:var(--cinder-font-semibold)}
`;

/** The workflow revision review's styles: the shared ones plus its comparison grid and footer. */
export const WORKFLOW_REVISION_STYLES = `${BASE_STYLES}
.revision-comparison{height:min(38vh,360px);min-height:12rem;overflow:auto;border:1px solid var(--cinder-border);border-radius:var(--cinder-radius-md);padding:var(--cinder-space-3);background:var(--cinder-surface)}
.revision-columns,.revision-row{display:grid;grid-template-columns:minmax(7rem,12rem) minmax(5rem,8rem) minmax(0,1fr) minmax(0,1fr);gap:var(--cinder-space-2);align-items:start}
.revision-columns{padding-bottom:var(--cinder-space-2);font-size:var(--cinder-text-xs);font-weight:var(--cinder-font-semibold);color:var(--cinder-text-subtle)}
.revision-row{border-top:1px solid var(--cinder-border-muted);padding:var(--cinder-space-2) 0}
.revision-row[data-state=added]{background:var(--cinder-status-success-background)}
.revision-row[data-state=removed]{background:var(--cinder-status-danger-background)}
.revision-row[data-state=changed]{background:var(--cinder-surface-raised)}
.revision-value{min-width:0;border:1px solid var(--cinder-border-muted);border-radius:var(--cinder-radius-sm);padding:var(--cinder-space-2);background:var(--cinder-surface)}
.revision-value__label{display:block;margin-bottom:var(--cinder-space-1);font-size:var(--cinder-text-xs);font-weight:var(--cinder-font-semibold);color:var(--cinder-text-subtle)}
.revision-value pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--cinder-text-xs)/1.4 var(--cinder-font-mono)}
.revision-footer{display:flex;justify-content:flex-end;gap:var(--cinder-space-2)}
@media (max-width:600px){.revision-columns{display:none}.revision-row{grid-template-columns:1fr}.revision-value--proposed{border-inline-start:2px dashed var(--cinder-border)}}
`;
