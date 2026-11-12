// Own-position marker (DOM, follows GPS smoothly) as an inline SVG string. Other units and all markers are
// GL symbols drawn in lib/mapIcons.ts.
import type { PlayerState, Role } from '@tactic/shared';
import { SQUAD_META } from '@tactic/shared';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Role glyph drawn inside a 36x24 friendly frame (origin at frame top-left). */
function roleGlyph(role: Role): string {
  const X = '<path d="M2 2L34 22M34 2L2 22" />'; // infantry
  switch (role) {
    case 'rifleman':
      return X;
    case 'leader':
      return `${X}<path d="M2 -6H34" stroke-width="3"/>`;
    case 'commander':
      return `${X}<path d="M2 -6H34M2 -10H34" stroke-width="2.5"/>`;
    case 'medic':
      return '<path d="M18 4V20M10 12H26" stroke-width="4"/>';
    case 'marksman':
      return `${X}<circle cx="18" cy="12" r="5" fill="none"/>`;
    case 'mg':
      return `${X}<circle cx="18" cy="12" r="3" fill="currentColor" stroke="none"/>`;
    case 'recon':
      return '<path d="M2 22L34 2" />';
  }
}

export function playerHtml(p: PlayerState, opts: { self: boolean; stale: boolean; showCone: boolean }): string {
  const color = SQUAD_META[p.squad].color;
  const status = p.status !== 'ok' ? ` st-${p.status}` : '';
  const cone =
    opts.showCone && p.heading != null
      ? `<svg class="cone" viewBox="-40 -40 80 80" style="--h:${Math.round(p.heading)}deg"><path d="M0 0L-14 -38A40 40 0 0 1 14 -38Z"/></svg>`
      : '';
  return `<div class="unit${opts.self ? ' self' : ''}${opts.stale ? ' stale' : ''}${status}" style="--c:${color}">
${cone}<svg class="frame" viewBox="-3 -12 42 37"><rect x="0" y="0" width="36" height="24" rx="1"/><g class="glyph">${roleGlyph(p.role)}</g></svg>
<span class="cs">${esc(p.callsign)}</span></div>`;
}

/** Ruler vertex handle. */
export const vertexHtml = (first: boolean) => `<div class="vtx${first ? ' first' : ''}"></div>`;
