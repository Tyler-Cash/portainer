'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

interface FilmstripProps {
  duration: number;
  currentTime: number;
  start: number;
  end: number;
  thumbnailUrl: (time: number) => string;
  onSeek: (time: number) => void;
  onChangeStart: (time: number) => void;
  onChangeEnd: (time: number) => void;
  onDeleteClip: () => void;
}

const TILE_COUNT = 12;

// The dedicated clip-trim editor: a filmstrip of thumbnails spanning the
// whole video so you can see roughly what's where without playing it,
// with the clip's start/end handles overlaid directly on it. Kept
// separate from the playback scrubber (playbar.tsx) so scrubbing through
// the video can never accidentally drag a clip boundary — and clicking
// anywhere on the strip (not a handle) previews that moment in the main
// video, so you can find exactly where a boundary should land.
export default function Filmstrip({
  duration,
  currentTime,
  start,
  end,
  thumbnailUrl,
  onSeek,
  onChangeStart,
  onChangeEnd,
  onDeleteClip,
}: FilmstripProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ time: number; x: number } | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  const tileTimes = useMemo(() => {
    if (duration <= 0) return [];
    const step = TILE_COUNT > 1 ? duration / (TILE_COUNT - 1) : 0;
    return Array.from({ length: TILE_COUNT }, (_, i) => Math.min(i * step, duration));
  }, [duration]);

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
    applyDrag(kind, initialClientX, false);

    function onMove(e: PointerEvent) {
      applyDrag(kind, e.clientX, false);
    }
    function onUp(e: PointerEvent) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (kind === 'seek') {
        applyDrag(kind, e.clientX, true);
        setScrubTime(null);
      }
      setPreview(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function applyDrag(kind: 'start' | 'end' | 'seek', clientX: number, commit: boolean) {
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
      setScrubTime(time);
      if (commit) onSeek(time);
    }
  }

  const pct = (t: number) => (duration > 0 ? (Math.min(t, duration) / duration) * 100 : 0);
  const playheadTime = scrubTime ?? currentTime;
  const hasClip = end > start;

  return (
    <div className="filmstrip">
      <div
        className="filmstrip-track"
        ref={trackRef}
        onPointerDown={(e) => beginDrag('seek', e.clientX)}
      >
        <div className="filmstrip-tiles">
          {tileTimes.map((t, i) => (
            <img key={i} src={thumbnailUrl(t)} alt="" className="filmstrip-tile" draggable={false} />
          ))}
        </div>

        {hasClip && (
          <>
            <div className="filmstrip-dim filmstrip-dim-left" style={{ width: `${pct(start)}%` }} />
            <div className="filmstrip-dim filmstrip-dim-right" style={{ width: `${100 - pct(end)}%` }} />
            <div
              className="filmstrip-range"
              style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
            />
            <div
              className="filmstrip-handle"
              style={{ left: `${pct(start)}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                beginDrag('start', e.clientX);
              }}
            />
            <div
              className="filmstrip-handle"
              style={{ left: `${pct(end)}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                beginDrag('end', e.clientX);
              }}
            />
            <button
              type="button"
              className="filmstrip-delete"
              style={{ left: `${pct(end)}%` }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onDeleteClip}
              title="Discard this clip selection"
            >
              &times;
            </button>
          </>
        )}

        <div className="filmstrip-playhead" style={{ left: `${pct(playheadTime)}%` }} />
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
  );
}
