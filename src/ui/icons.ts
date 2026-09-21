// Icon glyphs, 24 grid / 1.6 stroke / round joins, matching the approved design artifact exactly.

const paths: Record<string, string> = {
  select: '<path d="M6 3.5l12.5 7.2-5.6 1.7-2.6 5.4z"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><path d="M12 12l5.3-5.3"/>',
  line: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.8" fill="currentColor"/><circle cx="19" cy="5" r="1.8" fill="currentColor"/>',
  polygon:
    '<path d="M12 4.5l7.5 13.5h-15z"/><circle cx="12" cy="4.5" r="1.6" fill="currentColor"/><circle cx="19.5" cy="18" r="1.6" fill="currentColor"/><circle cx="4.5" cy="18" r="1.6" fill="currentColor"/>',
  divide: '<circle cx="12" cy="12" r="7"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2"/>',
  fair: '<path d="M4 18l6-12 4 8 6-10" stroke-width="1" opacity=".45"/><path d="M4 18l6-12" stroke-width="3.2"/>',
  fill: '<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/><path d="M12 3.5l7.4 4.25v8.5L12 20.5z" fill="currentColor" opacity=".45" stroke="none"/>',
  undo: '<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 7l4 4-4 4"/><path d="M19 11h-9a5 5 0 000 10h3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="3"/>',
  share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  // Phase 3.3 item 1: a geometric point/node plus a small lock badge, so the control reads as
  // "Point Lock" specifically rather than a generic padlock. Closed shackle = ON, open shackle =
  // OFF — the badge is the only thing that changes between the two.
  pointLock: '<circle cx="7" cy="7" r="3" fill="currentColor"/><rect x="12.5" y="13.5" width="8" height="7" rx="1.8"/><path d="M14.5 13.5v-2.2a2.5 2.5 0 015 0v2.2"/>',
  pointLockOpen: '<circle cx="7" cy="7" r="3" fill="currentColor"/><rect x="12.5" y="13.5" width="8" height="7" rx="1.8"/><path d="M14.5 13.5v-2.2a2.5 2.5 0 014.6 -1.4"/>',
  // Phase 3.3 item 2 / Phase 3.5 item 6: the eye is the primary idea — full-size, full-strength —
  // with four small node dots around it only as quiet contextual support (well under the eye's
  // own visual weight, never competing with it), so this reads as "points shown" rather than a
  // generic show/hide-the-whole-drawing eye. Hidden state mutes the same eye shape (lower opacity
  // on the eye, dots nearly gone) rather than slashing it — no X, nothing that reads as
  // Delete/Error — paired with the button itself switching to the muted ink colour in shell.ts.
  pointsEye:
    '<circle cx="4" cy="4" r="1.2" fill="currentColor" opacity=".3"/><circle cx="20" cy="4" r="1.2" fill="currentColor" opacity=".3"/><circle cx="4" cy="20" r="1.2" fill="currentColor" opacity=".3"/><circle cx="20" cy="20" r="1.2" fill="currentColor" opacity=".3"/><path d="M3.5 12S7.5 6.5 12 6.5 20.5 12 20.5 12 16.5 17.5 12 17.5 3.5 12 3.5 12z"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  pointsEyeOff:
    '<circle cx="4" cy="4" r="1.2" fill="currentColor" opacity=".12"/><circle cx="20" cy="4" r="1.2" fill="currentColor" opacity=".12"/><circle cx="4" cy="20" r="1.2" fill="currentColor" opacity=".12"/><circle cx="20" cy="20" r="1.2" fill="currentColor" opacity=".12"/><path d="M3.5 12S7.5 6.5 12 6.5 20.5 12 20.5 12 16.5 17.5 12 17.5 3.5 12 3.5 12z" opacity=".55"/><circle cx="12" cy="12" r="2.6" fill="currentColor" opacity=".55"/>',
};

export type IconName = keyof typeof paths;

export function iconSvg(name: IconName, size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
