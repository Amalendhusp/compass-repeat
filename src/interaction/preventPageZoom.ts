// Phase 3.5 item 1: Safari zoom ownership — the construction canvas should own pinch gestures,
// never the browser page.
//
// The existing defenses (viewport meta's maximum-scale=1/user-scalable=no, and touch-action:none
// on html/body plus the canvas — see style.css and pointer.ts) stop the standard Touch Events
// path, but iOS Safari has a real, still-current gap: on top of Touch Events, WebKit fires its
// own proprietary, older GestureEvent trio — gesturestart/gesturechange/gestureend — for any
// two-finger gesture, and by default responds to those by zooming the WHOLE PAGE. Critically,
// `touch-action` does not govern GestureEvent at all; it only suppresses Touch Events' own
// default actions. That mismatch is exactly the reported bug: a normal two-finger pinch on the
// canvas (fully covered by touch-action:none) can still reach Safari's legacy gesture recognizer
// and zoom the page, leaving the participant stuck in a page-zoomed layout with no way back
// in-app (Fit only ever controlled the drawing's own view, never the browser's).
//
// The fix is the standard one for this exact WebKit behaviour: explicitly preventDefault() the
// GestureEvent trio at the document level. This is additive and narrowly scoped to that one
// mechanism — it takes nothing away from normal browser behaviour outside the app (single-finger
// scrolling, tapping links, form inputs, screen readers, double-tap, Safari's own UI chrome are
// all untouched; VoiceOver/system Zoom are OS-level, outside any web page's reach either way) —
// it only stops the page-zoom response to a two-finger gesture, which the canvas already exists
// to interpret itself.
export function preventSafariPageZoom(): void {
  const stop = (e: Event): void => e.preventDefault();
  // Only WebKit ever dispatches these; adding the listeners is a harmless no-op on other engines.
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
}
