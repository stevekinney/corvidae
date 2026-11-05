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
.revision-status{margin:.25rem 0 .75rem;color:var(--cinder-text-muted)}
.revision-status--applied{color:var(--cinder-status-success-text)}.revision-status--conflict,.revision-status--denied{color:var(--cinder-status-danger-text)}.revision-status--offline,.revision-status--unknown{color:var(--cinder-status-warning-text)}
.revision-comparison{height:min(38vh,360px);min-height:12rem;overflow:auto;border:1px solid var(--cinder-border-muted);border-radius:6px;padding:var(--cinder-space-3)}
.revision-comparison:focus-visible{outline:var(--cinder-ring-width) solid transparent;outline-offset:var(--cinder-ring-offset);box-shadow:0 0 0 var(--cinder-ring-offset) var(--cinder-ring-offset-color),0 0 0 calc(var(--cinder-ring-offset) + var(--cinder-ring-width)) var(--cinder-ring-color)}
.revision-columns,.revision-row{display:grid;grid-template-columns:minmax(7rem,12rem) minmax(5rem,8rem) minmax(0,1fr) minmax(0,1fr);gap:var(--cinder-space-2);align-items:start}
.revision-columns{padding-bottom:var(--cinder-space-2);font-size:var(--cinder-text-xs);font-weight:600;color:var(--cinder-text-muted)}
.revision-row{border-top:1px solid var(--cinder-border-muted);padding:var(--cinder-space-2) 0}.revision-row[data-state=added]{background:var(--cinder-status-success-background)}.revision-row[data-state=removed]{background:var(--cinder-status-danger-background)}.revision-row[data-state=changed]{background:var(--cinder-surface-raised)}
.revision-row__marker{font-size:var(--cinder-text-xs);font-weight:600;color:var(--cinder-text-muted)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.4 ui-monospace,monospace}footer{margin-top:var(--cinder-space-3);display:flex;justify-content:flex-end}
button:focus-visible{outline:var(--cinder-ring-width) solid transparent;outline-offset:var(--cinder-ring-offset);box-shadow:0 0 0 var(--cinder-ring-offset) var(--cinder-ring-offset-color),0 0 0 calc(var(--cinder-ring-offset) + var(--cinder-ring-width)) var(--cinder-ring-color)}
@media (forced-colors:active){button:focus-visible,.revision-comparison:focus-visible{outline:var(--cinder-ring-width) solid ButtonText;box-shadow:none}}
@media (max-width:600px){.revision-columns,.revision-row{grid-template-columns:minmax(7rem,1fr) minmax(6rem,1fr)}.revision-columns span:first-child,.revision-row strong,.revision-row__marker{grid-column:1 / -1}.revision-row pre{min-width:0}.revision-row pre:nth-of-type(2){border-left:1px dashed var(--cinder-border-muted);padding-left:var(--cinder-space-2)}}
`;
