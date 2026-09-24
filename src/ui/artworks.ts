// Phase 5.5 items 5–9: the small sheets behind the menu's artwork actions — a one-field name
// prompt (Save / Save as new) and My Artworks, a plain list of saved artworks to open (Phase 5.6:
// swipe a row right to reveal Delete). Every control reacts to a genuine tap on itself
// (ui/tap.ts), like the confirm sheet.

import type { ArtworkSummary } from '../persist/db.ts';
import { onTap } from './tap.ts';
import { openConfirmSheet } from './confirmsheet.ts';

function mountSheet(root: HTMLElement, onDismiss?: () => void): { sheet: HTMLElement; close: () => void } {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet compact';
  const close = () => {
    scrim.remove();
    sheet.remove();
  };
  onTap(scrim, () => {
    close();
    onDismiss?.();
  });
  const handle = document.createElement('div');
  handle.className = 'handle';
  sheet.appendChild(handle);
  root.appendChild(scrim);
  root.appendChild(sheet);
  return { sheet, close };
}

export function openNameSheet(root: HTMLElement, opts: { title: string; initial: string; confirmLabel: string; onConfirm: (name: string) => void }): void {
  const { sheet, close } = mountSheet(root);
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = '<h2></h2>';
  head.querySelector('h2')!.textContent = opts.title;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'name-input';
  input.maxLength = 60;
  input.placeholder = 'Artwork name';
  input.value = opts.initial;
  input.setAttribute('aria-label', 'Artwork name');
  input.setAttribute('autocapitalize', 'words');

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn-secondary';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.className = 'btn-primary';
  confirm.textContent = opts.confirmLabel;
  const refresh = () => (confirm.disabled = input.value.trim().length === 0);
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    close();
    opts.onConfirm(name);
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  onTap(cancel, close);
  onTap(confirm, submit);
  actions.appendChild(cancel);
  actions.appendChild(confirm);
  sheet.appendChild(head);
  sheet.appendChild(input);
  sheet.appendChild(actions);
  refresh();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

function edited(ts: number): string {
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---- Phase 5.6 items 9–16: swipe a row right to reveal Delete ----

const REVEAL_PX = 88; // how far a row slides open — the Delete action's own width
const DECIDE_PX = 14; // travel before a gesture is read as a swipe…
const SCROLL_PX = 10; // …or as a vertical scroll, whichever is clearly first

export function openArtworksSheet(
  root: HTMLElement,
  opts: { currentId: string; artworks: ArtworkSummary[]; onOpen: (id: string) => void; onDelete: (id: string) => Promise<void> },
): void {
  const { sheet, close } = mountSheet(root);
  sheet.classList.add('artworks-sheet');
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = '<h2>My Artworks</h2>';
  sheet.appendChild(head);

  const list = document.createElement('div');
  list.className = 'artwork-list';

  // Only one row is ever open; opening, swiping or tapping anywhere else closes it.
  let openRow: { row: HTMLElement; close: () => void } | null = null;
  const closeOpenRow = () => {
    openRow?.close();
    openRow = null;
  };
  // The press that dismisses an open row does only that — it never also opens another artwork.
  let dismissingPointer: number | null = null;
  sheet.addEventListener(
    'pointerdown',
    (e) => {
      dismissingPointer = null;
      if (openRow && !openRow.row.parentElement!.contains(e.target as Node)) {
        closeOpenRow();
        dismissingPointer = e.pointerId;
      }
    },
    true,
  );

  for (const a of opts.artworks) {
    const item = document.createElement('div');
    item.className = 'artwork-item';

    const del = document.createElement('button');
    del.className = 'artwork-delete';
    del.textContent = 'Delete';
    del.tabIndex = -1;
    del.setAttribute('aria-hidden', 'true');

    const row = document.createElement('button');
    row.className = 'artwork-row' + (a.id === opts.currentId ? ' current' : '');
    const thumb = document.createElement('div');
    thumb.className = 'artwork-thumb';
    if (a.thumbnail) thumb.style.backgroundImage = `url("${a.thumbnail}")`;
    const text = document.createElement('div');
    text.className = 'artwork-text';
    const name = document.createElement('span');
    name.className = 'artwork-name';
    name.textContent = a.named ? a.name : 'Untitled';
    const meta = document.createElement('span');
    meta.className = 'artwork-meta';
    meta.textContent = a.id === opts.currentId ? `Open now · ${edited(a.updatedAt)}` : edited(a.updatedAt);
    text.appendChild(name);
    text.appendChild(meta);
    row.appendChild(thumb);
    row.appendChild(text);

    let offset = 0;
    const place = (px: number, animate: boolean) => {
      offset = px;
      row.classList.toggle('dragging', !animate);
      row.style.transform = px ? `translateX(${px}px)` : '';
      del.style.opacity = String(Math.min(1, px / REVEAL_PX));
      const revealed = px >= REVEAL_PX;
      del.tabIndex = revealed ? 0 : -1;
      del.setAttribute('aria-hidden', String(!revealed));
    };
    const settle = (open: boolean) => {
      place(open ? REVEAL_PX : 0, true);
      if (open) openRow = { row, close: () => place(0, true) };
      else if (openRow?.row === row) openRow = null;
    };

    // Nothing is decided on press: a clearly sideways move becomes a swipe (the row follows the
    // finger), a clearly vertical one is left to the list's own native scrolling.
    let track: { id: number; x: number; y: number; base: number; mode: 'undecided' | 'swipe' | 'scroll' } | null = null;
    row.addEventListener('pointerdown', (e) => {
      track = { id: e.pointerId, x: e.clientX, y: e.clientY, base: offset, mode: 'undecided' };
    });
    row.addEventListener('pointermove', (e) => {
      if (!track || e.pointerId !== track.id) return;
      const dx = e.clientX - track.x;
      const dy = e.clientY - track.y;
      if (track.mode === 'undecided') {
        if (Math.abs(dy) > SCROLL_PX && Math.abs(dy) > Math.abs(dx)) track.mode = 'scroll';
        else if (Math.abs(dx) > DECIDE_PX && Math.abs(dx) > Math.abs(dy) * 1.4 && (dx > 0 || track.base > 0)) {
          track.mode = 'swipe';
          if (openRow && openRow.row !== row) closeOpenRow();
          try {
            row.setPointerCapture(e.pointerId);
          } catch {
            // Capture is a delivery nicety here; the swipe still tracks without it.
          }
        }
      }
      if (track.mode !== 'swipe') return;
      const raw = track.base + dx;
      // A little give past the open position, none past closed.
      const px = raw > REVEAL_PX ? REVEAL_PX + (raw - REVEAL_PX) * 0.25 : Math.max(0, raw);
      place(px, false);
    });
    const finish = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return;
      const wasSwipe = track.mode === 'swipe';
      track = null;
      if (wasSwipe) settle(offset > REVEAL_PX * 0.45);
    };
    row.addEventListener('pointerup', finish);
    row.addEventListener('pointercancel', finish);

    onTap(row, (ev) => {
      if (ev instanceof PointerEvent && ev.pointerId === dismissingPointer) {
        dismissingPointer = null;
        return;
      }
      // A tap on a row that's open only closes its Delete action.
      if (offset > 0 || openRow) {
        closeOpenRow();
        settle(false);
        return;
      }
      close();
      if (a.id !== opts.currentId) opts.onOpen(a.id);
    });

    onTap(del, () => {
      if (offset < REVEAL_PX) return;
      const shown = a.named ? a.name : 'Untitled';
      openConfirmSheet(root, {
        title: `Delete “${shown}”?`,
        body: 'This removes the editable artwork from this device.',
        confirmLabel: 'Delete',
        onCancel: () => settle(false),
        onConfirm: () => {
          if (a.id === opts.currentId) close(); // the app moves on to another artwork (or a new one)
          void opts.onDelete(a.id).then(() => {
            item.remove();
            if (openRow?.row === row) openRow = null;
            if (!list.querySelector('.artwork-item')) close();
          });
        },
      });
    });

    item.appendChild(del);
    item.appendChild(row);
    list.appendChild(item);
  }
  sheet.appendChild(list);
}
