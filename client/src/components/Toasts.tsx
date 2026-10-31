import { useEffect } from 'react';
import { useStore } from '../store';
import { sfx } from '../lib/audio';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const last = toasts[toasts.length - 1];
  useEffect(() => {
    if (last?.kind === 'alert') {
      sfx.alert();
      navigator.vibrate?.([60, 40, 60]);
    }
  }, [last?.id, last?.kind]);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
