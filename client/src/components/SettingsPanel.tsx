import { useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import { useStore } from '../store';
import { clearTileCache, prefetchTiles, tileCacheCount, tileList } from '../lib/tiles';
import { isNative, Tactical } from '../lib/native';

const MAX_PREFETCH = 4000;

export function SettingsPanel({ onLogout }: { onLogout: () => void }) {
  const s = useStore((st) => st.settings);
  const set = useStore((st) => st.setSettings);
  const myPos = useStore((st) => st.myPos);
  const match = useStore((st) => st.match);
  const [cached, setCached] = useState<number | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [batteryOk, setBatteryOk] = useState<boolean | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void tileCacheCount().then(setCached);
    if (isNative()) void Tactical.isIgnoringBatteryOptimizations().then((r) => setBatteryOk(r.value)).catch(() => {});
  }, []);

  async function downloadArea() {
    const map = (window as unknown as { __map?: L.Map }).__map;
    if (!map) return;
    const z = Math.round(map.getZoom());
    let zMax = Math.min(z + 3, 19);
    let urls = tileList(s.baseLayer, map.getBounds(), Math.max(12, z - 2), zMax);
    while (urls.length > MAX_PREFETCH && zMax > z) urls = tileList(s.baseLayer, map.getBounds(), Math.max(12, z - 2), --zMax);
    if (urls.length > MAX_PREFETCH) return setProgress(`Area too large (${urls.length} tiles). Zoom in.`);
    abort.current = new AbortController();
    setProgress(`0 / ${urls.length}`);
    try {
      await prefetchTiles(urls, (d, t) => setProgress(`${d} / ${t}`), abort.current.signal);
      setProgress(`Done: ${urls.length} tiles (z${Math.max(12, z - 2)}–${zMax})`);
    } catch (e) {
      setProgress((e as Error).message);
    }
    setCached(await tileCacheCount());
  }

  const num = (k: 'activeIntervalMs' | 'ecoIntervalMs' | 'idleIntervalMs', min: number, max: number) => (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={s[k] / 1000}
      onChange={(e) => set({ [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) * 1000 })}
    />
  );

  return (
    <div className="settings">
      <h4>POWER</h4>
      <div className="seg">
        <button className={s.mode === 'combat' ? 'on' : ''} onClick={() => set({ mode: 'combat' })}>
          COMBAT
          <small>screen on · fast GPS</small>
        </button>
        <button className={s.mode === 'eco' ? 'on' : ''} onClick={() => set({ mode: 'eco' })}>
          ECO / BACKGROUND
          <small>screen may lock</small>
        </button>
      </div>

      <h4>GPS</h4>
      <label className="check">
        <input type="checkbox" checked={s.shareLocation} onChange={(e) => set({ shareLocation: e.target.checked })} /> Share my position
      </label>
      <div className="kv">
        <span>Combat interval, s</span>
        {num('activeIntervalMs', 1, 10)}
        <span>Eco interval, s</span>
        {num('ecoIntervalMs', 2, 30)}
        <span>Locked / stationary, s</span>
        {num('idleIntervalMs', 5, 60)}
      </div>
      {myPos && (
        <div className="note">
          Current tier: <b>{myPos.tier.toUpperCase()}</b> · ±{Math.round(myPos.acc)} m
        </div>
      )}

      <h4>RADIO</h4>
      <label className="check">
        <input type="checkbox" checked={s.radioSounds} onChange={(e) => set({ radioSounds: e.target.checked })} /> Roger beep & squelch tones
      </label>
      <div className="kv">
        <span>Headset button</span>
        <select value={s.pttKeyMode} onChange={(e) => set({ pttKeyMode: e.target.value as 'hold' | 'toggle' })}>
          <option value="toggle">Press = start / stop TX (BT)</option>
          <option value="hold">Hold to talk (wired)</option>
        </select>
      </div>
      {isNative() && (
        <label className="check">
          <input type="checkbox" checked={s.volumeKeyPtt} onChange={(e) => set({ volumeKeyPtt: e.target.checked })} /> Volume-down = PTT (screen on)
        </label>
      )}
      <div className="note">Desktop: hold SPACE to talk.</div>

      {isNative() && batteryOk === false && (
        <>
          <h4>BACKGROUND</h4>
          <div className="note warn">Battery optimisation is ON — Android may kill radio/GPS when locked.</div>
          <button onClick={() => void Tactical.requestIgnoreBatteryOptimizations().then(() => setBatteryOk(null))}>ALLOW BACKGROUND RUN</button>
        </>
      )}

      <h4>OFFLINE MAP</h4>
      <div className="note">{cached ?? '…'} tiles cached. Download the visible area before the game (field has no signal).</div>
      <div className="row">
        <button onClick={downloadArea}>DOWNLOAD VISIBLE AREA</button>
        {progress && <button onClick={() => abort.current?.abort()}>STOP</button>}
        <button
          onClick={async () => {
            await clearTileCache();
            setCached(0);
            setProgress('');
          }}
        >
          CLEAR
        </button>
      </div>
      {progress && <div className="note">{progress}</div>}

      <h4>SESSION</h4>
      <div className="note">
        Match {match?.name} · code <b>{match?.code}</b>
      </div>
      <button className="danger" onClick={onLogout}>
        LEAVE MATCH
      </button>
    </div>
  );
}
