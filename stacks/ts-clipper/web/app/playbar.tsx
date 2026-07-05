'use client';

import { useCallback, useRef, useState } from 'react';

interface PlaybarProps {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  start: number;
  end: number;
  thumbnailUrl: (time: number) => string;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onChangeStart: (time: number) => void;
  onChangeEnd: (time: number) => void;
  onDeleteClip: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Playbar({
  duration,
  currentTime,
  isPlaying,
  start,
  end,
  thumbnailUrl,
  onPlayPause,
  onSeek,
  onChangeStart,
  onChangeEnd,
  onDeleteClip,
}: PlaybarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ time: number; x: number } | null>(null);

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

  function beginDrag(kind: 'start' | 'end' | 'seek', initialClientX: number) {
    applyDrag(kind, initialClientX);

    function onMove(e: PointerEvent) {
      applyDrag(kind, e.clientX);
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPreview(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function applyDrag(kind: 'start' | 'end' | 'seek', clientX: number) {
    const time = timeFromClientX(clientX);
    const track = trackRef.current;
    const relativeX = track ? clientX - track.getBoundingClientRect().left : clientX;
    if (kind === 'start') {
      const clamped = Math.min(time, end - 0.1);
      onChangeStart(clamped);
      setPreview({ time: clamped, x: relativeX });
    } else if (kind === 'end') {
      const clamped = Math.max(time, start + 0.1);
      onChangeEnd(clamped);
      setPreview({ time: clamped, x: relativeX });
    } else {
      onSeek(time);
    }
  }

  const pct = (t: number) => (duration > 0 ? (Math.min(t, duration) / duration) * 100 : 0);

  return (
    <div className="playbar">
      <div className="playbar-controls">
        <button type="button" onClick={onPlayPause} className="playbar-play">
          {isPlaying ? '⏸' : '▶'}
        </button>
        <span className="playbar-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      <div className="timeline">
        <div
          className="timeline-track"
          ref={trackRef}
          onPointerDown={(e) => beginDrag('seek', e.clientX)}
        >
          <div
            className="timeline-range"
            style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
          />
          <div className="timeline-playhead" style={{ left: `${pct(currentTime)}%` }} />
          <div
            className="timeline-handle timeline-handle-start"
            style={{ left: `${pct(start)}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginDrag('start', e.clientX);
            }}
          />
          <div
            className="timeline-handle timeline-handle-end"
            style={{ left: `${pct(end)}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginDrag('end', e.clientX);
            }}
          />
          <button
            type="button"
            className="timeline-delete"
            style={{ left: `${pct(end)}%` }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDeleteClip}
            title="Discard this clip selection"
          >
            &times;
          </button>
        </div>

        {preview && (
          <img
            className="timeline-preview"
            style={{ left: preview.x }}
            src={thumbnailUrl(preview.time)}
            alt=""
          />
        )}
      </div>
    </div>
  );
}
