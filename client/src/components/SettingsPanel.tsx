import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { clearTileCache, prefetchTiles, tileCacheCount, tileList } from '../lib/tiles';
import { isNative, Tactical } from '../lib/native';
import { mapRef } from '../lib/mapRef';
import { socket } from '../lib/socket';
import { speakTts } from '../lib/audio';
import { friendlyError } from '../lib/errors';

const MAX_PREFETCH = 4000;

export function SettingsPanel({ onLogout }: { onLogout: () => void }) {
  const s = useStore((st) => st.settings);
  const set = useStore((st) => st.setSettings);
  const myPos = useStore((st) => st.myPos);
  const match = useStore((st) => st.match);
  const self = useStore((st) => st.self);
  const [cached, setCached] = useState<number | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [batteryOk, setBatteryOk] = useState<boolean | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void tileCacheCount().then(setCached);
    if (isNative()) void Tactical.isIgnoringBatteryOptimizations().then((r) => setBatteryOk(r.value)).catch(() => {});
  }, []);

  async function downloadArea() {
    const b = mapRef.current?.bounds();
    if (!b) return;
    // MapLibre zoom is one level below the equivalent 256-px tile zoom.
    const z = Math.round(b.zoom) + 1;
    let zMax = Math.min(z + 3, 19);
    let urls: string[];
    try {
      urls = await tileList(s.baseLayer, b, Math.max(12, z - 2), zMax);
      while (urls.length > MAX_PREFETCH && zMax > z) urls = await tileList(s.baseLayer, b, Math.max(12, z - 2), --zMax);
    } catch (e) {
      return setProgress(friendlyError(e, 'Не удалось загрузить карту для офлайна. Проверьте интернет.'));
    }
    if (urls.length > MAX_PREFETCH) return setProgress(`Слишком большая область (${urls.length} тайлов). Приблизьте карту.`);
    abort.current = new AbortController();
    setProgress(`0 / ${urls.length}`);
    try {
      await prefetchTiles(urls, (d, t) => setProgress(`${d} / ${t}`), abort.current.signal);
      setProgress(`Готово: ${urls.length} тайлов (z${Math.max(12, z - 2)}–${zMax})`);
    } catch (e) {
      setProgress(friendlyError(e, 'Загрузка прервана. Попробуйте ещё раз.'));
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
      <h4>ПИТАНИЕ</h4>
      <div className="seg">
        <button className={s.mode === 'combat' ? 'on' : ''} onClick={() => set({ mode: 'combat' })}>
          БОЕВОЙ
          <small>экран вкл · частый GPS</small>
        </button>
        <button className={s.mode === 'eco' ? 'on' : ''} onClick={() => set({ mode: 'eco' })}>
          ЭКО / ФОН
          <small>экран можно гасить</small>
        </button>
      </div>

      <h4>GPS</h4>
      <label className="check">
        <input type="checkbox" checked={s.shareLocation} onChange={(e) => set({ shareLocation: e.target.checked })} /> Передавать мою позицию
      </label>
      <div className="kv">
        <span>Боевой интервал, с</span>
        {num('activeIntervalMs', 1, 10)}
        <span>Эко интервал, с</span>
        {num('ecoIntervalMs', 2, 30)}
        <span>На месте / заблокирован, с</span>
        {num('idleIntervalMs', 5, 60)}
      </div>
      {myPos && (
        <div className="note">
          Текущий режим: <b>{myPos.tier.toUpperCase()}</b> · ±{Math.round(myPos.acc)} м
        </div>
      )}

      <h4>РАЦИЯ</h4>
      <label className="check">
        <input type="checkbox" checked={s.radioSounds} onChange={(e) => set({ radioSounds: e.target.checked })} /> Тихие щелчки рации (выкл = только вибрация, без палева)
      </label>
      <label className="check">
        <input type="checkbox" checked={s.tts} onChange={(e) => set({ tts: e.target.checked })} /> Озвучка чата и меток голосом (TTS: Русский + English)
      </label>
      <div className="row">
        <button type="button" onClick={() => speakTts('Проверка голосовой связи. Tactical radio check Alpha one.', true)}>
          ТЕСТ TTS (RU / EN)
        </button>
      </div>
      <div className="kv">
        <span>Кнопка гарнитуры</span>
        <select value={s.pttKeyMode} onChange={(e) => set({ pttKeyMode: e.target.value as 'hold' | 'toggle' })}>
          <option value="toggle">Нажатие = вкл / выкл передачу (BT)</option>
          <option value="hold">Удержание для передачи (проводная)</option>
        </select>
      </div>
      {isNative() && (
        <label className="check">
          <input type="checkbox" checked={s.volumeKeyPtt} onChange={(e) => set({ volumeKeyPtt: e.target.checked })} /> Кнопка громкости вниз = PTT (при вкл. экране)
        </label>
      )}
      <div className="note">ПК: удерживайте ПРОБЕЛ для передачи.</div>

      {isNative() && batteryOk === false && (
        <>
          <h4>ФОНОВАЯ РАБОТА</h4>
          <div className="note warn">Оптимизация батареи ВКЛ — Android может отключить рацию/GPS при блокировке экрана.</div>
          <button onClick={() => void Tactical.requestIgnoreBatteryOptimizations().then(() => setBatteryOk(null))}>РАЗРЕШИТЬ РАБОТУ В ФОНЕ</button>
        </>
      )}

      <h4>ОФЛАЙН-КАРТА</h4>
      <div className="note">
        В кэше: {cached ?? '…'} тайлов. Скачайте видимую область для текущего слоя ({s.baseLayer.toUpperCase()}) до выезда на полигон. Повторите для каждого нужного слоя.
      </div>
      <div className="row">
        <button onClick={downloadArea}>СКАЧАТЬ ВИДИМУЮ ОБЛАСТЬ</button>
        {progress && <button onClick={() => abort.current?.abort()}>СТОП</button>}
        <button
          onClick={async () => {
            await clearTileCache();
            setCached(0);
            setProgress('');
          }}
        >
          ОЧИСТИТЬ
        </button>
      </div>
      {progress && <div className="note">{progress}</div>}

      <h4>СЕССИЯ</h4>
      <div className="note">
        Сеть: {match?.name} · код <b>{match?.code}</b>
      </div>
      <div className="row">
        {self && self.squad !== 'none' && (
          <button onClick={() => socket.send({ t: 'squad.set', squad: 'none', role: 'rifleman' })}>
            ВЫЙТИ ИЗ ОТРЯДА
          </button>
        )}
        <button className="danger" onClick={onLogout}>
          ВЫЙТИ С СЕРВЕРА
        </button>
      </div>
    </div>
  );
}
