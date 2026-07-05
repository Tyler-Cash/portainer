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

  const videoRef = useRef<HTMLVideoElement>(null);

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
      setDraftStart(0);
      setDraftEnd(Math.min(DEFAULT_CLIP_SECONDS, videoDuration || DEFAULT_CLIP_SECONDS));
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
    if (!sourceId || !videoRef.current) return;
    const video = videoRef.current;
    setStreamOffset(0);
    video.src = `/api/upload/${sourceId}?start=0`;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }, [sourceId]);

  function onTimeUpdate() {
    const video = videoRef.current;
    if (video) setCurrentTime(streamOffset + video.currentTime);
  }

  function seekTo(time: number) {
    if (!Number.isFinite(time) || !sourceId) return;
    const video = videoRef.current;
    setStreamOffset(time);
    setCurrentTime(time);
    if (video) {
      video.src = `/api/upload/${sourceId}?start=${time}`;
      video.load();
      video.play().catch(() => {});
    }
  }

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  function effectiveTime(): number {
    return streamOffset + (videoRef.current?.currentTime ?? 0);
  }

  function startClipHere() {
    const time = effectiveTime();
    setDraftStart(time);
    setDraftEnd(Math.min(time + DEFAULT_CLIP_SECONDS, duration || time + DEFAULT_CLIP_SECONDS));
  }

  function stopClipHere() {
    const time = effectiveTime() || duration;
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
    setDraftStart(0);
    setDraftEnd(0);
    setDraftRemoveAudio(false);
  }

  const hasActiveClips = clips.some((c) => c.status === 'pending' || c.status === 'processing');
  const pendingCount = clips.filter((c) => c.status === 'pending' || c.status === 'error').length;

  return (
    <main className="page">
      <h1>ts-clipper</h1>

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
            <video
              ref={videoRef}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              className="preview"
            />

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
              onSeek={seekTo}
              onChangeStart={setDraftStart}
              onChangeEnd={setDraftEnd}
              onDeleteClip={deleteDraftClip}
            />

            <p>
              Clip: {formatTime(draftStart)}&ndash;{formatTime(draftEnd)} (
              {formatTime(draftEnd - draftStart)})
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
              <button
                type="button"
                disabled={processingQueue || pendingCount === 0}
                onClick={processQueue}
              >
                {processingQueue ? 'Uploading queue…' : `Upload ${pendingCount} queued clip(s)`}
              </button>
              <button type="button" disabled={hasActiveClips} onClick={finish}>
                Finish &amp; clip another video
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
