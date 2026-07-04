'use client';

import { useEffect, useRef, useState } from 'react';

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'ready'; id: string; isTs: boolean }
  | { status: 'clipping'; id: string; isTs: boolean }
  | { status: 'done'; url: string }
  | { status: 'error'; message: string; id?: string; isTs?: boolean };

function isTsFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.m2ts');
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Home() {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [removeAudio, setRemoveAudio] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);

  const editingId =
    state.status === 'ready' || state.status === 'clipping'
      ? state.id
      : state.status === 'error'
        ? state.id
        : undefined;
  const editingIsTs =
    state.status === 'ready' || state.status === 'clipping'
      ? state.isTs
      : state.status === 'error'
        ? state.isTs
        : undefined;
  const editing = editingId !== undefined;

  async function handleFile(file: File) {
    setState({ status: 'uploading' });
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: file,
        headers: { 'x-filename': file.name },
      });
      const json = await res.json();
      if (!res.ok) {
        setState({ status: 'error', message: json.error ?? 'Upload failed' });
        return;
      }
      setState({ status: 'ready', id: json.id, isTs: isTsFile(file.name) });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message });
    }
  }

  useEffect(() => {
    if (!editingId || !videoRef.current) return;

    const video = videoRef.current;
    const src = `/api/upload/${editingId}`;

    if (editingIsTs) {
      let cancelled = false;
      import('mpegts.js').then((mod) => {
        if (cancelled) return;
        const mpegts = mod.default;
        const player = mpegts.createPlayer({ type: 'mse', isLive: false, url: src });
        player.attachMediaElement(video);
        player.load();
        playerRef.current = player;
      });
      return () => {
        cancelled = true;
        playerRef.current?.destroy();
        playerRef.current = null;
      };
    }

    video.src = src;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, editingIsTs]);

  function onLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setEnd(video.duration);
  }

  async function handleClip() {
    if (!editingId) return;
    const id = editingId;
    const isTs = editingIsTs ?? false;

    setState({ status: 'clipping', id, isTs });
    try {
      const res = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, start, end, removeAudio }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState({ status: 'error', message: json.error ?? 'Clip failed', id, isTs });
        return;
      }
      setState({ status: 'done', url: json.url });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message, id, isTs });
    }
  }

  function reset() {
    setState({ status: 'idle' });
    setDuration(0);
    setStart(0);
    setEnd(0);
    setRemoveAudio(false);
  }

  return (
    <main className="page">
      <h1>ts-clipper</h1>

      {state.status === 'idle' && (
        <label className="dropzone">
          <input
            type="file"
            accept=".ts,.m2ts,.mp4,.webm,.m4v"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          Drop a video here or click to choose a file
        </label>
      )}

      {state.status === 'uploading' && <p>Uploading&hellip;</p>}

      {editing && (
        <div className="editor">
          <video ref={videoRef} controls onLoadedMetadata={onLoadedMetadata} className="preview" />

          <div className="controls">
            <label>
              In: {formatTime(start)}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={start}
                onChange={(e) => setStart(Math.min(Number(e.target.value), end))}
              />
            </label>
            <label>
              Out: {formatTime(end)}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={end}
                onChange={(e) => setEnd(Math.max(Number(e.target.value), start))}
              />
            </label>
            <button type="button" onClick={() => setStart(videoRef.current?.currentTime ?? 0)}>
              Set in to current time
            </button>
            <button type="button" onClick={() => setEnd(videoRef.current?.currentTime ?? duration)}>
              Set out to current time
            </button>
            <label>
              <input
                type="checkbox"
                checked={removeAudio}
                onChange={(e) => setRemoveAudio(e.target.checked)}
              />
              Remove audio
            </label>
            <button type="button" disabled={state.status === 'clipping'} onClick={handleClip}>
              {state.status === 'clipping' ? 'Clipping…' : 'Clip & Upload'}
            </button>
          </div>
        </div>
      )}

      {state.status === 'error' && <p className="error">{state.message}</p>}

      {state.status === 'done' && (
        <div className="result">
          <p>
            Uploaded: <a href={state.url}>{state.url}</a>
          </p>
          <button type="button" onClick={() => navigator.clipboard.writeText(state.url)}>
            Copy link
          </button>
          <button type="button" onClick={reset}>
            Clip another
          </button>
        </div>
      )}
    </main>
  );
}
