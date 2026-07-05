import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseDurationOutput(stdout: string): number {
  const duration = parseFloat(stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

export async function getDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return parseDurationOutput(stdout);
}
