// Map symbols drawn on a canvas for MapLibre symbol layers (GPU-rendered, clusterable), replacing one DOM
// element per unit/marker. Same simplified APP-6 look as before. Images are created on demand from their
// id (see MapView 'styleimagemissing'), drawn at 2x so they stay sharp on phone screens.
import { SQUAD_META, type Role, type Squad } from '@tactic/shared';

const SCALE = 2;
const ACC = '#9bd35a';
const WARN = '#ffb000';
const RED = '#ff5a4e';
const TRP = '#5eead4';
export const OBJ_COLORS: Record<string, string> = { active: '#ffb000', captured: '#34d399', lost: '#ff5a4e', cleared: '#9ca3af' };

type Draw = (g: CanvasRenderingContext2D) => void;

function render(w: number, h: number, draw: Draw) {
  const c = document.createElement('canvas');
  c.width = w * SCALE;
  c.height = h * SCALE;
  const g = c.getContext('2d')!;
  g.scale(SCALE, SCALE);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  draw(g);
  return { data: g.getImageData(0, 0, c.width, c.height), pixelRatio: SCALE };
}

const stroke = (g: CanvasRenderingContext2D, d: string, color: string, width: number) => {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke(new Path2D(d));
};
const circle = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
};
/** Dark outline under a path keeps symbols readable on satellite imagery (replaces CSS drop-shadow). */
const outlined = (g: CanvasRenderingContext2D, d: string, color: string, width: number) => {
  stroke(g, d, 'rgba(0,0,0,.75)', width + 2.5);
  stroke(g, d, color, width);
};

/** color mixed 30% over the dark background, like `color-mix(in srgb, c 30%, #0b0f0c)`. */
function dim(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v: number, b: number) => Math.round(v * 0.3 + b * 0.7);
  return `rgb(${mix(n >> 16, 0x0b)},${mix((n >> 8) & 255, 0x0f)},${mix(n & 255, 0x0c)})`;
}

const X = 'M2 2L34 22M34 2L2 22';
function roleGlyph(g: CanvasRenderingContext2D, role: Role) {
  const w = 2.2;
  if (role !== 'medic' && role !== 'recon') stroke(g, X, '#fff', w);
  if (role === 'leader') stroke(g, 'M2 -6H34', '#fff', 3);
  if (role === 'commander') stroke(g, 'M2 -6H34M2 -10H34', '#fff', 2.5);
  if (role === 'medic') stroke(g, 'M18 4V20M10 12H26', '#fff', 4);
  if (role === 'recon') stroke(g, 'M2 22L34 2', '#fff', w);
  if (role === 'marksman') {
    circle(g, 18, 12, 5);
    g.strokeStyle = '#fff';
    g.lineWidth = w;
    g.stroke();
  }
  if (role === 'mg') {
    circle(g, 18, 12, 3);
    g.fillStyle = '#fff';
    g.fill();
  }
}

/** Friendly unit frame. id: `u:<squad>:<role>:<status>[:self]` */
function unit(squad: Squad, role: Role, status: string, self: boolean) {
  const color = SQUAD_META[squad]?.color ?? '#9aa79c';
  return render(42, 40, (g) => {
    g.translate(3, 13);
    const fill = status === 'hit' || status === 'out' ? '#5a0f0b' : status === 'medic' ? '#6b4b00' : dim(color);
    g.fillStyle = fill;
    g.fillRect(0, 0, 36, 24);
    g.strokeStyle = 'rgba(0,0,0,.8)';
    g.lineWidth = 5;
    g.strokeRect(0, 0, 36, 24);
    g.strokeStyle = self ? '#fff' : color;
    g.lineWidth = self ? 3 : 2.5;
    g.strokeRect(0, 0, 36, 24);
    roleGlyph(g, role);
    if (status === 'out') stroke(g, 'M-2 -2L38 26', RED, 3);
  });
}

/** Facing cone, tinted per squad. id: `cone:<squad>` (rotated by heading in the layer). */
function cone(squad: Squad) {
  const color = SQUAD_META[squad]?.color ?? '#9aa79c';
  return render(80, 80, (g) => {
    g.translate(40, 40);
    g.globalAlpha = 0.35;
    g.fillStyle = color;
    g.fill(new Path2D('M0 0L-14 -38A40 40 0 0 1 14 -38Z'));
  });
}

/** Enemy contact diamond. id: `c:<contactType>` */
function contact(type: string) {
  return render(44, 44, (g) => {
    g.translate(22, 22);
    const dia = new Path2D('M0 -19L19 0L0 19L-19 0Z');
    g.fillStyle = 'rgba(255,90,78,.35)';
    g.fill(dia);
    g.strokeStyle = 'rgba(0,0,0,.75)';
    g.lineWidth = 5.5;
    g.stroke(dia);
    g.strokeStyle = RED;
    g.lineWidth = 3;
    g.stroke(dia);
    const w = 2.5;
    if (type === 'infantry') stroke(g, 'M-9 -5L9 5M9 -5L-9 5', '#fff', w);
    else if (type === 'sniper') {
      circle(g, 0, 0, 5);
      g.strokeStyle = '#fff';
      g.lineWidth = w;
      g.stroke();
      stroke(g, 'M0 -9V9M-9 0H9', '#fff', w);
    } else if (type === 'mg') {
      stroke(g, 'M-9 -5L9 5M9 -5L-9 5', '#fff', w);
      circle(g, 0, 0, 2.5);
      g.fillStyle = '#fff';
      g.fill();
    } else if (type === 'vehicle') {
      g.beginPath();
      g.ellipse(0, 0, 10, 5, 0, 0, Math.PI * 2);
      g.strokeStyle = '#fff';
      g.lineWidth = w;
      g.stroke();
    } else {
      g.fillStyle = '#fff';
      g.font = 'bold 15px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('?', 0, 1);
    }
  });
}

/** Objective ring. id: `o:<status>` */
function objective(status: string) {
  const color = OBJ_COLORS[status] ?? WARN;
  return render(40, 40, (g) => {
    g.translate(20, 20);
    circle(g, 0, 0, 16);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fill();
    g.setLineDash([6, 3]);
    g.strokeStyle = 'rgba(0,0,0,.75)';
    g.lineWidth = 5.5;
    g.stroke();
    g.strokeStyle = color;
    g.lineWidth = 3.5;
    g.stroke();
    g.setLineDash([]);
    circle(g, 0, 0, 4);
    g.fillStyle = color;
    g.fill();
  });
}

/** Waypoint / rally / medic / danger. id: `p:<kind>` */
function point(kind: string) {
  return render(32, 32, (g) => {
    g.translate(16, 16);
    if (kind === 'medic') {
      g.fillStyle = '#fff';
      g.strokeStyle = RED;
      g.lineWidth = 2.5;
      g.fillRect(-12, -12, 24, 24);
      g.strokeRect(-12, -12, 24, 24);
      stroke(g, 'M0 -7V7M-7 0H7', RED, 4);
    } else if (kind === 'danger') {
      outlined(g, 'M0 -13L13 11H-13Z', WARN, 2.5);
      outlined(g, 'M0 -4V3M0 6V7', WARN, 2.5);
    } else if (kind === 'rally') {
      outlined(g, 'M-10 12V-14M-10 -14H10L5 -8L10 -2H-10', ACC, 2.5);
    } else {
      outlined(g, 'M0 -14L12 0L0 14L-12 0Z', '#fff', 2.5);
      circle(g, 0, 0, 3);
      g.fillStyle = '#fff';
      g.fill();
    }
  });
}

/** Target reference point crosshair. id: `trp` */
function trp() {
  return render(32, 32, (g) => {
    g.translate(16, 16);
    circle(g, 0, 0, 9);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fill();
    outlined(g, 'M9 0A9 9 0 1 1 -9 0A9 9 0 1 1 9 0M0 -15V-5M0 5V15M-15 0H-5M5 0H15', TRP, 2.5);
  });
}

/** Image for a symbol id used in the map layers; null for ids this module does not own. */
export function mapIcon(id: string): { data: ImageData; pixelRatio: number } | null {
  const [kind, a, b, c, d] = id.split(':');
  switch (kind) {
    case 'u':
      return unit(a as Squad, b as Role, c ?? 'ok', d === 'self');
    case 'cone':
      return cone(a as Squad);
    case 'c':
      return contact(a ?? 'unknown');
    case 'o':
      return objective(a ?? 'active');
    case 'p':
      return point(a ?? 'waypoint');
    case 'trp':
      return trp();
    default:
      return null;
  }
}

export const LABEL_COLORS = { contact: '#ffc9c4', trp: TRP, point: '#ffffff', danger: WARN, rally: ACC, medic: '#ffffff' };
