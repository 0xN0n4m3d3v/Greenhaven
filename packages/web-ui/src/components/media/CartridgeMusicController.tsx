import {Pause, Play, Square} from 'lucide-react';
import {useCartridgeMusic} from '../../hooks/useCartridgeMusic';

export function CartridgeMusicController() {
  const {state, pause, resume, stop} = useCartridgeMusic();
  if (!state.url) return null;
  return (
    <div className="cartridge-music-control" role="group" aria-label="music">
      <span className="cartridge-music-title">
        {state.label ?? 'Cartridge music'}
      </span>
      <button
        type="button"
        onClick={state.playing ? pause : resume}
        aria-label={state.playing ? 'Pause music' : 'Play music'}
      >
        {state.playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button type="button" onClick={stop} aria-label="Stop music">
        <Square size={12} />
      </button>
    </div>
  );
}

