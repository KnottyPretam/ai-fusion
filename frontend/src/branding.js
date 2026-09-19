// frontend/src/branding.js — the product name, in ONE place for the renderer.
//
// "Solomon's Judgement": three models answer, their claims are weighed as R1/R2/R3, and a
// disagreement that will not resolve is reported standing rather than split down the middle.
//
// Only what a user READS was renamed. Internal identifiers keep the `triplex` codename on purpose —
// `window.triplex`, the `triplex.*` localStorage keys, every `data-testid`, and on the Electron side
// the `TRIPLEX_*` environment variables and the userData directory that holds the three logged-in
// sessions. The desktop main process has its own copy of this string in `desktop/main/branding.js`
// (a preload cannot import from the bundle), and the backend has `APP_TITLE` for exported documents.
export const APP_NAME = "Solomon's Judgement"
