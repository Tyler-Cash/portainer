import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  duration: number;
  fps: number;
}

function parseFrameRate(value: string): number {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (match) {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (denominator <= 0) return 0;
    const fps = numerator / denominator;
    return Number.isFinite(fps) && fps > 0 ? fps : 0;
  }
  const fps = parseFloat(value);
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

export function parseMetadataOutput(stdout: string): VideoMetadata {
  try {
    const json = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { r_frame_rate?: string }[];
    };

    const durationStr = json.format?.duration;
    const parsedDuration = durationStr ? parseFloat(durationStr) : NaN;
    const duration = Number.isFinite(parsedDuration) ? parsedDuration : 0;

    const frameRateStr = json.streams?.[0]?.r_frame_rate;
    const fps = frameRateStr ? parseFrameRate(frameRateStr) : 0;

    return { duration, fps };
  } catch {
    return { duration: 0, fps: 0 };
  }
}

export async function getMetadata(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=r_frame_rate',
    '-of', 'json',
    filePath,
  ]);
  return parseMetadataOutput(stdout);
}
