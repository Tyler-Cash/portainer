'use client';

import { useCallback, useRef } from 'react';

interface TimelineProps {
  duration: number;
  currentTime: number;
  start: number;
  end: number;
  onSeek: (time: number) => void;
  onChangeStart: (time: number) => void;
  onChangeEnd: (time: number) => void;
}

export default function Timeline({
  duration,
  currentTime,
  start,
  end,
  onSeek,
  onChangeStart,
  onChangeEnd,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);

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
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function applyDrag(kind: 'start' | 'end' | 'seek', clientX: number) {
    const time = timeFromClientX(clientX);
    if (kind === 'start') {
      onChangeStart(Math.min(time, end - 0.1));
    } else if (kind === 'end') {
      onChangeEnd(Math.max(time, start + 0.1));
    } else {
      onSeek(time);
    }
  }

  const pct = (t: number) => (duration > 0 ? (Math.min(t, duration) / duration) * 100 : 0);

  return (
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
          className="timeline-handle"
          style={{ left: `${pct(start)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            beginDrag('start', e.clientX);
          }}
        />
        <div
          className="timeline-handle"
          style={{ left: `${pct(end)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            beginDrag('end', e.clientX);
          }}
        />
      </div>
    </div>
  );
}
