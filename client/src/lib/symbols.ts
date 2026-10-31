// Simplified APP-6 / MIL-STD-2525 style symbols as inline SVG strings for Leaflet divIcons.
import type { Marker, PlayerState, Role } from '@tactic/shared';
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
      ? `<svg class="cone" viewBox="-40 -40 80 80" style="transform:rotate(${Math.round(p.heading)}deg)"><path d="M0 0L-14 -38A40 40 0 0 1 14 -38Z"/></svg>`
      : '';
  return `<div class="unit${opts.self ? ' self' : ''}${opts.stale ? ' stale' : ''}${status}" style="--c:${color}">
${cone}<svg class="frame" viewBox="-3 -12 42 37"><rect x="0" y="0" width="36" height="24" rx="1"/><g class="glyph">${roleGlyph(p.role)}</g></svg>
<span class="cs">${esc(p.callsign)}</span></div>`;
}

const CONTACT_GLYPH: Record<string, string> = {
  infantry: '<path d="M-9 -5L9 5M9 -5L-9 5"/>',
  sniper: '<circle r="5" fill="none"/><path d="M0 -9V9M-9 0H9"/>',
  mg: '<path d="M-9 -5L9 5M9 -5L-9 5"/><circle r="2.5" fill="currentColor" stroke="none"/>',
  vehicle: '<ellipse rx="10" ry="5" fill="none"/>',
  unknown: '<text y="5" text-anchor="middle" font-size="14" font-weight="700" stroke="none" fill="currentColor">?</text>',
};

export function contactHtml(m: Marker, now: number): string {
  const age = Math.max(0, Math.round((now - m.createdAt) / 60000));
  const left = m.expiresAt ? Math.max(0, (m.expiresAt - now) / ((m.ttlSec || 1) * 1000)) : 1;
  const count = m.count && m.count > 1 ? `<span class="cnt">${m.count}</span>` : '';
  return `<div class="contact" style="opacity:${(0.45 + 0.55 * left).toFixed(2)}">
<svg viewBox="-24 -24 48 48"><path class="dia" d="M0 -20L20 0L0 20L-20 0Z"/><g class="glyph">${CONTACT_GLYPH[m.contactType ?? 'unknown'] ?? ''}</g></svg>
${count}<span class="lbl">${esc(m.label || 'ENEMY')} · ${age}m</span></div>`;
}

const OBJ_COLORS: Record<string, string> = {
  active: '#ffb000',
  captured: '#34d399',
  lost: '#ff5a4e',
  cleared: '#9ca3af',
};

export function objectiveHtml(m: Marker): string {
  const c = OBJ_COLORS[m.status] ?? '#ffb000';
  return `<div class="objective" style="--c:${c}">
<svg viewBox="-22 -22 44 44"><circle r="18"/><circle r="4" class="dot"/></svg>
<span class="lbl">OBJ ${esc(m.label || '?')}</span></div>`;
}

const POINT_GLYPH: Record<string, string> = {
  waypoint: '<path d="M0 -14L12 0L0 14L-12 0Z" fill="none"/><circle r="3"/>',
  rally: '<path d="M-10 12V-14M-10 -14H10L5 -8L10 -2H-10"/>',
  medic: '<rect x="-12" y="-12" width="24" height="24" rx="3" fill="#fff" stroke="#ff5a4e"/><path d="M0 -7V7M-7 0H7" stroke="#ff5a4e" stroke-width="4"/>',
  danger: '<path d="M0 -13L13 11H-13Z" fill="none"/><path d="M0 -4V3M0 6V7"/>',
};

export function pointHtml(m: Marker): string {
  return `<div class="point k-${m.kind}"><svg viewBox="-16 -16 32 32">${POINT_GLYPH[m.kind] ?? ''}</svg>
<span class="lbl">${esc(m.label || m.kind.toUpperCase())}</span></div>`;
}

export function arrowHtml(color: string, angle: number): string {
  return `<svg class="arrowhead" viewBox="-10 -10 20 20" style="transform:rotate(${angle}deg);color:${color}"><path d="M0 -9L8 7L0 3L-8 7Z"/></svg>`;
}
