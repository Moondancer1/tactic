// Small handle so panels outside the map (chat, team, settings) can steer it without importing MapLibre.
export interface MapApi {
  flyTo(lat: number, lon: number, zoom?: number): void;
  resetNorth(): void;
  /** visible area, for offline download */
  bounds(): { west: number; south: number; east: number; north: number; zoom: number };
}

export const mapRef: { current: MapApi | null } = { current: null };
