declare module 'mgrs' {
  export function forward(lonLat: [number, number], accuracy?: number): string;
  export function toPoint(mgrs: string): [number, number];
}

interface ImportMetaEnv {
  readonly VITE_DEFAULT_SERVER?: string;
}
