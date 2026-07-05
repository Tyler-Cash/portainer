'use client';

import { useCallback, useRef, useState } from 'react';

interface PlaybarProps {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  muted: boolean;
  onPlayPause: () => void;
  onToggleMute: () => void;
  onSeek: (time: number) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Pure playback scrubber — no clip-range editing here at all, so scrubbing
// through the video can never accidentally move a clip boundary. See
// filmstrip.tsx for the separate clip-trim timeline.
export default function Playbar({
  duration,
  currentTime,
  isPlaying,
  muted,
  onPlayPause,
  onToggleMute,
  onSeek,
}: PlaybarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track || !Number.isFinite(duration) || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  function beginDrag(initialClientX: number) {
    setScrubTime(timeFromClientX(initialClientX));

    function onMove(e: PointerEvent) {
      setScrubTime(timeFromClientX(e.clientX));
    }
    function onUp(e: PointerEvent) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onSeek(timeFromClientX(e.clientX));
      setScrubTime(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const pct = (t: number) => (duration > 0 ? (Math.min(t, duration) / duration) * 100 : 0);
  const playheadTime = scrubTime ?? currentTime;

  return (
    <div className="playbar">
      <div className="timeline">
        <div className="timeline-track" ref={trackRef} onPointerDown={(e) => beginDrag(e.clientX)}>
          <div className="timeline-playhead" style={{ left: `${pct(playheadTime)}%` }} />
        </div>
      </div>

      <div className="playbar-controls">
        <button type="button" onClick={onPlayPause} className="playbar-play">
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button type="button" onClick={onToggleMute} className="playbar-mute">
          {muted ? '🔇' : '🔊'}
        </button>
        <span className="playbar-time">
          {formatTime(playheadTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
