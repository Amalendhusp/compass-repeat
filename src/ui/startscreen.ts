// vNext Phase 2: the Start screen — one vertically scrolling page for everything that begins or
// reopens work: Choose a frame, the Beginner Guide, and My Artworks. It replaces the separate
// frame-picker and My Artworks sheets (no sheet-on-sheet navigation). Menu → New opens it at
// "Choose a frame"; Menu → Open… opens the same page scrolled to "My Artworks". Saved artworks are
// shown as cards using the small thumbnail each artwork already stores when it is saved — nothing
// new is persisted for this screen.

import type { FrameKind } from '../model/types.ts';
import type { ArtworkSummary } from '../persist/db.ts';
import { onTap } from './tap.ts';
import { FRAME_LABELS, FRAME_ORDER, FRAME_PREVIEWS } from './framepicker.ts';

export interface StartScreenOptions {
  /** Where the page opens: at the frames (New) or at My Artworks (Open…). */
  focus: 'frames' | 'artworks';
  /** With an artwork already open the page can be closed again, returning to it untouched. */
  dismissible: boolean;
  /** The artwork open behind the page, if any (marked "Open now"). */
  currentId: string | null;
  /** The saved artworks, newest first (may still be loading). */
  artworks: Promise<ArtworkSummary[]>;
  /** The Beginner Guide card: `onStart` absent shows it disabled; `note` is a small badge on it. */
  guide: { onStart?: () => void; note?: string };
  onChooseFrame: (kind: FrameKind) => void;
  onOpenArtwork: (id: string) => void;
  onClose?: () => void;
}

function edited(ts: number): string {
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Opens the Start screen over the app and returns a function that closes it. */
export function openStartScreen(root: HTMLElement, opts: StartScreenOptions): () => void {
  document.querySelector('.start-screen')?.remove();
  const page = document.createElement('div');
  page.className = 'start-screen';
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', 'Start');

  const close = () => page.remove();

  // ---- header ----
  const header = document.createElement('div');
  header.className = 'start-header';
  const title = document.createElement('div');
  title.className = 'start-title';
  title.textContent = 'Compass + Repeat';
  header.appendChild(title);
  if (opts.dismissible) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'start-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5 L15 15 M15 5 L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    onTap(closeBtn, () => {
      close();
      opts.onClose?.();
    });
    header.appendChild(closeBtn);
  }
  page.appendChild(header);

  const body = document.createElement('div');
  body.className = 'start-body';
  page.appendChild(body);

  // ---- Choose a frame ----
  const frames = document.createElement('section');
  frames.className = 'start-section';
  frames.id = 'start-frames';
  frames.innerHTML = '<h2>Choose a frame</h2><p class="start-sub">Draw its centre, vertices and edges — they become your first points.</p>';
  const frameGrid = document.createElement('div');
  frameGrid.className = 'start-frame-grid';
  for (const kind of FRAME_ORDER) {
    const btn = document.createElement('button');
    btn.className = 'start-frame';
    btn.innerHTML = `${FRAME_PREVIEWS[kind]}<span class="start-frame-name">${FRAME_LABELS[kind]}</span>`;
    onTap(btn, () => {
      close();
      opts.onChooseFrame(kind);
    });
    frameGrid.appendChild(btn);
  }
  frames.appendChild(frameGrid);
  body.appendChild(frames);

  // ---- Beginner Guide ----
  const guide = document.createElement('button');
  guide.className = 'start-guide';
  guide.innerHTML =
    '<span class="start-guide-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 8.5 L17.5 13 L10.5 17.5 Z" fill="currentColor"/></svg></span><span class="start-guide-text"><span class="start-guide-name">Beginner Guide</span><span class="start-guide-sub">Learn Compass + Repeat</span></span>';
  const start = opts.guide.onStart;
  if (start) {
    onTap(guide, () => {
      close();
      start();
    });
  } else {
    guide.disabled = true;
  }
  if (opts.guide.note) {
    const badge = document.createElement('span');
    badge.className = 'start-guide-badge';
    badge.textContent = opts.guide.note;
    guide.appendChild(badge);
  }
  body.appendChild(guide);

  // ---- My Artworks ----
  const artworks = document.createElement('section');
  artworks.className = 'start-section';
  artworks.id = 'start-artworks';
  artworks.innerHTML = '<h2>My Artworks</h2>';
  const grid = document.createElement('div');
  grid.className = 'start-artwork-grid';
  grid.setAttribute('aria-busy', 'true');
  artworks.appendChild(grid);
  body.appendChild(artworks);

  root.appendChild(page);

  const scrollToFocus = () => {
    if (opts.focus === 'artworks') page.scrollTop = artworks.offsetTop - header.offsetHeight - 8;
    else page.scrollTop = 0;
  };
  scrollToFocus();

  void opts.artworks.then((list) => {
    if (!page.isConnected) return;
    grid.removeAttribute('aria-busy');
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'start-empty';
      empty.textContent = 'No saved artworks yet. Choose a frame above to start one.';
      grid.appendChild(empty);
    }
    for (const a of list) {
      const card = document.createElement('button');
      card.className = 'start-artwork' + (a.id === opts.currentId ? ' current' : '');
      const thumb = document.createElement('div');
      thumb.className = 'start-artwork-thumb';
      if (a.thumbnail) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.src = a.thumbnail;
        thumb.appendChild(img);
      }
      const name = document.createElement('span');
      name.className = 'start-artwork-name';
      name.textContent = a.named ? a.name : 'Untitled';
      const meta = document.createElement('span');
      meta.className = 'start-artwork-meta';
      meta.textContent = a.id === opts.currentId ? `Open now · ${edited(a.updatedAt)}` : edited(a.updatedAt);
      card.appendChild(thumb);
      card.appendChild(name);
      card.appendChild(meta);
      onTap(card, () => {
        close();
        if (a.id === opts.currentId) opts.onClose?.();
        else opts.onOpenArtwork(a.id);
      });
      grid.appendChild(card);
    }
    // The section grew once the list arrived — keep Open… landing on its heading.
    scrollToFocus();
  });

  return close;
}
