const chokidar = require('chokidar');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

const WATCH_DIR = process.env.WATCH_DIR || '/uploads';
const TARGET_BITRATE = process.env.TARGET_BITRATE || '25M';
const MAX_BITRATE = process.env.MAX_BITRATE || '28M';
const BUF_SIZE = process.env.BUF_SIZE || '50M';
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const TMP_SUFFIX = '.transcoding.tmp';

const processing = new Set();

function parseBitrate(value) {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value);
  if (!match) throw new Error(`Invalid bitrate value: ${value}`);
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'k') return num * 1000;
  if (unit === 'm') return num * 1000 * 1000;
  return num;
}

const targetBitrateBps = parseBitrate(TARGET_BITRATE);

async function getVideoBitrate(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=bit_rate:format=bit_rate',
    '-of', 'json',
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const streamBitrate = info.streams && info.streams[0] && info.streams[0].bit_rate;
  const formatBitrate = info.format && info.format.bit_rate;
  const bitrate = streamBitrate || formatBitrate;
  return bitrate ? parseInt(bitrate, 10) : null;
}

async function transcode(filePath) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, path.basename(filePath) + TMP_SUFFIX);

  await execFileAsync('ffmpeg', [
    '-y',
    '-hwaccel', 'vaapi',
    '-hwaccel_device', VAAPI_DEVICE,
    '-hwaccel_output_format', 'vaapi',
    '-i', filePath,
    '-vf', 'scale_vaapi=format=nv12',
    '-c:v', 'h264_vaapi',
    '-b:v', TARGET_BITRATE,
    '-maxrate', MAX_BITRATE,
    '-bufsize', BUF_SIZE,
    '-c:a', 'copy',
    tmpPath,
  ]);

  fs.renameSync(tmpPath, filePath);
}

async function handleFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return;
  if (filePath.endsWith(TMP_SUFFIX)) return;
  if (processing.has(filePath)) return;

  processing.add(filePath);
  try {
    const bitrate = await getVideoBitrate(filePath);
    if (bitrate === null) {
      console.log(`[skip] could not determine bitrate: ${filePath}`);
      return;
    }
    if (bitrate <= targetBitrateBps) {
      console.log(`[skip] already under target (${bitrate} bps): ${filePath}`);
      return;
    }

    const beforeSize = fs.statSync(filePath).size;
    console.log(`[transcode] starting ${filePath} (${bitrate} bps)`);
    await transcode(filePath);
    const afterSize = fs.statSync(filePath).size;
    console.log(`[transcode] done ${filePath}: ${beforeSize}B -> ${afterSize}B`);
  } catch (err) {
    console.error(`[error] ${filePath}: ${err.message}`);
  } finally {
    processing.delete(filePath);
  }
}

const watcher = chokidar.watch(WATCH_DIR, {
  ignored: (filePath) => filePath.endsWith(TMP_SUFFIX),
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 500,
  },
});

watcher.on('add', handleFile);
watcher.on('change', handleFile);

console.log(`Watching ${WATCH_DIR} for videos over ${targetBitrateBps} bps (VAAPI device: ${VAAPI_DEVICE})`);
