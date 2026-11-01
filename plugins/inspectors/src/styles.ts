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
