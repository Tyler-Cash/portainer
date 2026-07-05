'use client';

import { useEffect, useRef, useState } from 'react';
import Playbar from './playbar';

type SourceState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'ready'; id: string }
  | { status: 'error'; message: string };

interface QueuedClip {
  clipId: string;
  start: number;
  end: number;
  removeAudio: boolean;
  status: 'pending' | 'processing' | 'fast-ready' | 'done' | 'error';
  url?: string;
  error?: string;
}

const DEFAULT_CLIP_SECONDS = 20;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Home() {
  const [source, setSource] = useState<SourceState>({ status: 'idle' });
  const [dragActive, setDragActive] = useState(false);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(0);
  const [streamOffset, setStreamOffset] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(0);
  const [draftRemoveAudio, setDraftRemoveAudio] = useState(false);
  const [clips, setClips] = useState<QueuedClip[]>([]);
  const [processingQueue, setProcessingQueue] = useState(false);
  const [fastPreviewEnabled, setFastPreviewEnabled] = useState(true);

  // Two <video> elements, swapped like a double-buffer: seeking preloads the
  // new stream into the currently-hidden one and only promotes it to visible
  // once it actually has a frame ready ('loadeddata'), so the old frame stays
  // on screen the whole time instead of flashing black while ffmpeg spins up
  // a fresh remux for the new position.
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const activeIndexRef = useRef<0 | 1>(0);
  const [activeIndex, setActiveIndex] = useState<0 | 1>(0);

  function setVideoRef(index: 0 | 1) {
    return (el: HTMLVideoElement | null) => {
      videoRefs.current[index] = el;
    };
  }

  function activeVideo(): HTMLVideoElement | null {
    return videoRefs.current[activeIndexRef.current];
  }

  const sourceId = source.status === 'ready' ? source.id : undefined;

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((json) => setFastPreviewEnabled(Boolean(json.fastPreviewEnabled)))
      .catch(() => setFastPreviewEnabled(true));
  }, []);

  async function handleFile(file: File) {
    setSource({ status: 'uploading' });
    setClips([]);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: file,
        headers: { 'x-filename': file.name },
      });
      const json = await res.json();
      if (!res.ok) {
        setSource({ status: 'error', message: json.error ?? 'Upload failed' });
        return;
      }
      const videoDuration = typeof json.duration === 'number' ? json.duration : 0;
      setDuration(videoDuration);
      setFps(typeof json.fps === 'number' ? json.fps : 0);
      // No default clip selection — the timeline starts empty until the user
      // explicitly defines a range (Start clip here / dragging a handle).
      setDraftStart(0);
      setDraftEnd(0);
      setSource({ status: 'ready', id: json.id });
    } catch (err) {
      setSource({ status: 'error', message: (err as Error).message });
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // Server-side remux (ffmpeg -c copy to fragmented mp4) plays in a plain
  // <video> regardless of source container/codec — no MSE, no client-side
  // demuxer. The trade-off: a live pipe has no fixed byte length, so seeking
  // restarts the remux from a new point rather than using Range requests —
  // see seekTo below.
  useEffect(() => {
    if (!sourceId) return;
    activeIndexRef.current = 0;
    setActiveIndex(0);
    setStreamOffset(0);
    const video = videoRefs.current[0];
    if (video) {
      video.src = `/api/upload/${sourceId}?start=0`;
      video.load();
    }
    return () => {
      videoRefs.current.forEach((v) => {
        if (v) {
          v.removeAttribute('src');
          v.load();
        }
      });
    };
  }, [sourceId]);

  function onTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (e.currentTarget !== activeVideo()) return;
    setCurrentTime(streamOffset + e.currentTarget.currentTime);
  }

  function handlePlayEvent(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (e.currentTarget !== activeVideo()) return;
    setIsPlaying(true);
  }

  function handlePauseEvent(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (e.currentTarget !== activeVideo()) return;
    setIsPlaying(false);
  }

  function seekTo(time: number) {
    if (!Number.isFinite(time) || !sourceId) return;
    const fromIndex = activeIndexRef.current;
    const toIndex: 0 | 1 = fromIndex === 0 ? 1 : 0;
    const fromVideo = videoRefs.current[fromIndex];
    const toVideo = videoRefs.current[toIndex];
    if (!toVideo) return;

    setStreamOffset(time);
    setCurrentTime(time);

    let settled = false;
    const promote = () => {
      if (settled) return;
      settled = true;
      toVideo.removeEventListener('loadeddata', promote);
      clearTimeout(timeoutId);
      activeIndexRef.current = toIndex;
      setActiveIndex(toIndex);
      toVideo.play().catch(() => {});
      fromVideo?.pause();
    };
    // Safety net: if the new stream never produces a frame (a broken seek
    // target), don't leave the UI stuck showing the old frame forever.
    const timeoutId = setTimeout(promote, 8000);

    toVideo.addEventListener('loadeddata', promote, { once: true });
    toVideo.src = `/api/upload/${sourceId}?start=${time}`;
    toVideo.load();
  }

  function togglePlayPause() {
    const video = activeVideo();
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    setMuted((prev) => !prev);
  }

  function effectiveTime(): number {
    return streamOffset + (activeVideo()?.currentTime ?? 0);
  }

  // The timeline maps pixel position to a raw float time with no relation
  // to the video's actual frame boundaries, so a click/drag can land between
  // frames — the resulting clip cut point is then whatever ffmpeg happens to
  // round to, not something the user actually chose. Snapping every
  // pixel-derived time to the nearest real frame makes selection exact and
  // reproducible instead.
  function snapToFrame(time: number): number {
    return fps > 0 ? Math.round(time * fps) / fps : time;
  }

  function startClipHere() {
    const time = snapToFrame(effectiveTime());
    setDraftStart(time);
    setDraftEnd(Math.min(time + DEFAULT_CLIP_SECONDS, duration || time + DEFAULT_CLIP_SECONDS));
  }

  function stopClipHere() {
    const time = snapToFrame(effectiveTime() || duration);
    setDraftEnd(Math.max(time, draftStart + 0.5));
  }

  function deleteDraftClip() {
    setDraftEnd(draftStart);
  }

  function previewClip(clip: QueuedClip) {
    setDraftStart(clip.start);
    setDraftEnd(clip.end);
    seekTo(clip.start);
  }

  function thumbnailUrl(time: number): string {
    if (!sourceId) return '';
    return `/api/upload/${sourceId}/thumbnail?t=${Math.round(time)}`;
  }

  function addToQueue() {
    if (draftEnd <= draftStart) return;
    setClips((prev) => [
      ...prev,
      {
        clipId: crypto.randomUUID(),
        start: draftStart,
        end: draftEnd,
        removeAudio: draftRemoveAudio,
        status: 'pending',
      },
    ]);
    const nextStart = draftEnd;
    setDraftStart(nextStart);
    setDraftEnd(Math.min(nextStart + DEFAULT_CLIP_SECONDS, duration));
  }

  function removeFromQueue(clipId: string) {
    setClips((prev) => prev.filter((c) => c.clipId !== clipId));
  }

  async function processClip(clip: QueuedClip) {
    if (!sourceId) return;
    setClips((prev) =>
      prev.map((c) => (c.clipId === clip.clipId ? { ...c, status: 'processing', error: undefined } : c)),
    );

    let fastZiplineId: string | undefined;

    if (fastPreviewEnabled) {
      try {
        const res = await fetch('/api/clip', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: sourceId,
            start: clip.start,
            end: clip.end,
            removeAudio: clip.removeAudio,
            mode: 'fast',
          }),
        });
        const json = await res.json();
        if (res.ok) {
          fastZiplineId = json.ziplineId;
          setClips((prev) =>
            prev.map((c) => (c.clipId === clip.clipId ? { ...c, status: 'fast-ready', url: json.url } : c)),
          );
        }
      } catch {
        // Fast preview is a nice-to-have — fall through to the full-quality pass either way.
      }
    }

    try {
      const res = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: sourceId,
          start: clip.start,
          end: clip.end,
          removeAudio: clip.removeAudio,
          mode: 'full',
          supersedesZiplineId: fastZiplineId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setClips((prev) =>
          prev.map((c) => (c.clipId === clip.clipId ? { ...c, status: 'error', error: json.error } : c)),
        );
        return;
      }
      setClips((prev) =>
        prev.map((c) => (c.clipId === clip.clipId ? { ...c, status: 'done', url: json.url } : c)),
      );
    } catch (err) {
      setClips((prev) =>
        prev.map((c) =>
          c.clipId === clip.clipId ? { ...c, status: 'error', error: (err as Error).message } : c,
        ),
      );
    }
  }

  async function processQueue() {
    setProcessingQueue(true);
    const pending = clips.filter((c) => c.status === 'pending' || c.status === 'error');
    for (const clip of pending) {
      await processClip(clip);
    }
    setProcessingQueue(false);
  }

  async function finish() {
    if (sourceId) {
      await fetch(`/api/upload/${sourceId}`, { method: 'DELETE' }).catch(() => {});
    }
    setSource({ status: 'idle' });
    setClips([]);
    setDuration(0);
    setStreamOffset(0);
    setCurrentTime(0);
    setIsPlaying(false);
    activeIndexRef.current = 0;
    setActiveIndex(0);
    setDraftStart(0);
    setDraftEnd(0);
    setDraftRemoveAudio(false);
  }

  async function handlePrimaryAction() {
    if (pendingCount > 0) {
      // Upload only — stay on screen so results (share links) can be
      // reviewed/copied. Finishing immediately after would wipe them out
      // before the user ever sees them.
      await processQueue();
      return;
    }
    await finish();
  }

  const pendingCount = clips.filter((c) => c.status === 'pending' || c.status === 'error').length;

  return (
    <main className="page">
      <header className="app-header">
        <span className={`tally-light${isPlaying ? ' tally-light-live' : ''}`} />
        <h1>ts-clipper</h1>
      </header>

      {source.status === 'idle' && (
        <label
          className={`dropzone${dragActive ? ' dropzone-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept=".ts,.m2ts,.mp4,.m4v,.mov,.mkv,.webm,.avi,.flv,.wmv,.mpg,.mpeg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          Drop a video here or click to choose a file
        </label>
      )}

      {source.status === 'uploading' && <p>Uploading&hellip;</p>}
      {source.status === 'error' && <p className="error">{source.message}</p>}

      {source.status === 'ready' && (
        <div className="editor-layout">
          <div className="editor-main">
            <div className="preview-stack">
              <video
                ref={setVideoRef(0)}
                muted={muted}
                onTimeUpdate={onTimeUpdate}
                onPlay={handlePlayEvent}
                onPause={handlePauseEvent}
                className={`preview${activeIndex === 0 ? ' preview-active' : ''}`}
              />
              <video
                ref={setVideoRef(1)}
                muted={muted}
                onTimeUpdate={onTimeUpdate}
                onPlay={handlePlayEvent}
                onPause={handlePauseEvent}
                className={`preview${activeIndex === 1 ? ' preview-active' : ''}`}
              />
            </div>

            <Playbar
              duration={duration}
              currentTime={currentTime}
              isPlaying={isPlaying}
              muted={muted}
              start={draftStart}
              end={draftEnd}
              thumbnailUrl={thumbnailUrl}
              onPlayPause={togglePlayPause}
              onToggleMute={toggleMute}
              onSeek={(time) => seekTo(snapToFrame(time))}
              onChangeStart={(time) => setDraftStart(snapToFrame(time))}
              onChangeEnd={(time) => setDraftEnd(snapToFrame(time))}
              onDeleteClip={deleteDraftClip}
            />

            <p className="clip-readout">
              Clip <strong>{formatTime(draftStart)}</strong>&ndash;<strong>{formatTime(draftEnd)}</strong>
              <span className="clip-readout-duration">{formatTime(draftEnd - draftStart)}</span>
            </p>

            <div className="controls">
              <button type="button" onClick={startClipHere}>
                Start clip here (~{DEFAULT_CLIP_SECONDS}s)
              </button>
              <button type="button" onClick={stopClipHere}>
                Stop clip here
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={draftRemoveAudio}
                  onChange={(e) => setDraftRemoveAudio(e.target.checked)}
                />
                Remove audio
              </label>
              <button type="button" onClick={addToQueue}>
                Add clip to queue
              </button>
            </div>
          </div>

          <aside className="editor-sidebar">
            <h2>Queue</h2>

            {clips.length === 0 && <p className="sidebar-empty">No clips queued yet.</p>}

            {clips.length > 0 && (
              <ul className="queue">
                {clips.map((clip) => (
                  <li key={clip.clipId} className={`queue-item queue-item-${clip.status}`}>
                    <button
                      type="button"
                      className="queue-thumb"
                      onClick={() => previewClip(clip)}
                      title="Preview this clip"
                    >
                      <img src={thumbnailUrl(clip.start)} alt="" />
                    </button>
                    <div className="queue-info">
                      <span className="queue-time">
                        {formatTime(clip.start)}&ndash;{formatTime(clip.end)}
                        {clip.removeAudio ? ' (no audio)' : ''}
                      </span>
                      {clip.status === 'pending' && (
                        <button type="button" onClick={() => removeFromQueue(clip.clipId)}>
                          Remove
                        </button>
                      )}
                      {clip.status === 'processing' && <span>Uploading&hellip;</span>}
                      {clip.status === 'fast-ready' && clip.url && (
                        <>
                          <a href={clip.url}>{clip.url}</a>
                          <span>(quick preview &mdash; upgrading&hellip;)</span>
                        </>
                      )}
                      {clip.status === 'done' && clip.url && (
                        <>
                          <a href={clip.url}>{clip.url}</a>
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(clip.url!)}
                          >
                            Copy
                          </button>
                        </>
                      )}
                      {clip.status === 'error' && (
                        <>
                          <span className="error">{clip.error}</span>
                          <button type="button" onClick={() => processClip(clip)}>
                            Retry
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="controls">
              <button type="button" disabled={processingQueue} onClick={handlePrimaryAction} className="primary">
                {processingQueue
                  ? 'Uploading queue…'
                  : pendingCount > 0
                    ? `Upload ${pendingCount} clip(s) & finish`
                    : 'Finish & clip another video'}
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
