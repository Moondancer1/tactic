import { VOICE_CHANNEL_META, type VoiceChannel } from '@tactic/shared';
import { useStore } from '../store';
import { ptt, voice } from '../lib/voice';
import { unlockAudio } from '../lib/audio';

export function PttButton() {
  const v = useStore((s) => s.voice);
  const busy = v.rx[v.tx];

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    unlockAudio();
    ptt.down('screen');
  };
  const up = (e: React.PointerEvent) => {
    e.preventDefault();
    ptt.up('screen');
  };

  return (
    <div className="ptt-wrap">
      <div className="ptt-ch">
        {v.channels.map((ch: VoiceChannel) => (
          <button key={ch} className={`${ch === v.tx ? 'on' : ''} ${v.rx[ch] ? 'rx' : ''}`} onClick={() => void voice.setTx(ch)} title={VOICE_CHANNEL_META[ch].label}>
            {VOICE_CHANNEL_META[ch].short}
          </button>
        ))}
      </div>
      <button
        className={`ptt ${v.transmitting ? 'tx' : ''} ${busy ? 'busy' : ''} ${v.status !== 'ready' ? 'off' : ''}`}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Push to talk"
      >
        <span className="ptt-label">{v.transmitting ? 'TX' : 'PTT'}</span>
        <span className="ptt-sub">{v.status === 'ready' ? VOICE_CHANNEL_META[v.tx].short : v.status === 'connecting' ? '…' : 'OFF'}</span>
      </button>
    </div>
  );
}
