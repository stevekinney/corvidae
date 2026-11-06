/** The styles every inspector page shares: system colors, visible focus, and no motion on request. */
export const BASE_STYLES = `
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif}
body{margin:0;padding:12px 16px;background:Canvas;color:CanvasText}
h1{font-size:1.1rem;margin:0 0 .5rem}h2{font-size:.95rem;margin:1rem 0 .25rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem .75rem;margin:0}dt{font-weight:600}dd{margin:0}
ul{margin:.25rem 0;padding-left:1.25rem}
button{font:inherit;padding:.35rem .8rem;border:1px solid ButtonText;border-radius:4px;background:ButtonFace;color:ButtonText;cursor:pointer}
button:disabled{opacity:.6;cursor:not-allowed}
button:focus-visible{outline:3px solid Highlight;outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/** The pending-review page's styles: the shared ones plus its sections, rejection box, and rows. */
export const PENDING_REVIEW_STYLES = `${BASE_STYLES}
section{border-top:1px solid GrayText;margin-top:1rem}
textarea{font:inherit;width:100%;box-sizing:border-box;display:block;margin:.25rem 0;color:FieldText;background:Field}
label{font-weight:600}
li{white-space:pre-wrap;overflow-wrap:anywhere}
button+button{margin-left:.5rem}
`;

export const WORKFLOW_REVISION_STYLES = `${BASE_STYLES}
.revision-status{margin:.25rem 0 .75rem;color:var(--color-text-tertiary)}
.revision-status--applied{color:var(--color-text-success)}.revision-status--conflict,.revision-status--denied{color:var(--color-text-danger)}.revision-status--offline,.revision-status--unknown{color:var(--color-text-warning)}
.revision-comparison{height:min(38vh,360px);min-height:12rem;overflow:auto;border:var(--border-width-regular,1px) solid var(--color-border-secondary);border-radius:var(--border-radius-sm,6px);padding:1rem;background:var(--color-background-primary);color:var(--color-text-primary)}
.revision-comparison:focus-visible{outline:var(--border-width-regular,1px) solid transparent;outline-offset:0;box-shadow:0 0 0 0 var(--color-ring-secondary),0 0 0 var(--border-width-regular,1px) var(--color-ring-primary)}
.revision-columns{display:grid;grid-template-columns:minmax(7rem,12rem) minmax(5rem,8rem) minmax(0,1fr) minmax(0,1fr);gap:.5rem;align-items:start;padding-bottom:.5rem;font-size:var(--font-text-xs-size,.75rem);font-weight:var(--font-weight-semibold,600);color:var(--color-text-tertiary)}
.revision-row{display:grid;grid-template-columns:minmax(7rem,12rem) minmax(5rem,8rem) minmax(0,1fr) minmax(0,1fr);gap:.5rem;align-items:start;border-top:var(--border-width-regular,1px) solid var(--color-border-secondary);padding:.5rem 0}.revision-row[data-state=added]{background:var(--color-background-success)}.revision-row[data-state=removed]{background:var(--color-background-danger)}.revision-row[data-state=changed]{background:var(--color-background-tertiary)}
.revision-row__marker{font-size:var(--font-text-xs-size,.75rem);font-weight:var(--font-weight-semibold,600);color:var(--color-text-tertiary)}
.revision-value{min-width:0;border:var(--border-width-regular,1px) solid var(--color-border-secondary);border-radius:var(--border-radius-sm,6px);padding:.5rem;background:var(--color-background-secondary)}.revision-value__label{display:block;margin-bottom:.25rem;font-size:var(--font-text-xs-size,.75rem);font-weight:var(--font-weight-semibold,600);color:var(--color-text-tertiary)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.4 var(--font-mono,ui-monospace,monospace)}footer{margin-top:1rem;display:flex;justify-content:flex-end}
button:focus-visible{outline:var(--border-width-regular,1px) solid transparent;outline-offset:0;box-shadow:0 0 0 0 var(--color-ring-secondary),0 0 0 var(--border-width-regular,1px) var(--color-ring-primary)}
@media (forced-colors:active){button:focus-visible,.revision-comparison:focus-visible{outline:2px solid ButtonText;box-shadow:none}}
@media (max-width:600px){.revision-columns{display:none}.revision-row{grid-template-columns:1fr;gap:.5rem}.revision-row strong,.revision-row__marker{grid-column:auto}.revision-value{min-width:0}.revision-value--proposed{border-left:2px dashed var(--color-border-secondary)}}
`;
