import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { pool } from './db.js';
import { boss, startQueue, PROCESS_QUEUE } from './queue.js';
import { s3 } from './storage.js';

const MAX_VIDEO_SECONDS = 20 * 60;
const LADDER = [
  { w: 3840, bitrate: 14000 },
  { w: 2560, bitrate: 8000 },
  { w: 1280, bitrate: 3000 },
];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

interface Probe { width: number; height: number; duration: number; hasAudio: boolean }
async function probe(file: string): Promise<Probe> {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('No video or image stream found');
  return {
    width: v.width,
    height: v.height,
    duration: Number(j.format.duration ?? 0),
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** Crops the left (or top) eye so thumbnails of stereo captures are not double images. */
const eyeCrop = (stereo: string) =>
  stereo === 'top-bottom' ? 'crop=iw:ih/2:0:0,' : stereo === 'side-by-side' ? 'crop=iw/2:ih:0:0,' : '';

async function uploadDir(dir: string, prefix: string) {
  const files = await fs.readdir(dir);
  const type = (f: string) =>
    f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : f.endsWith('.ts') ? 'video/mp2t' : 'image/jpeg';
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files.slice(i, i + 8).map(async (f) =>
        s3.send(new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: `${prefix}/${f}`,
          Body: await fs.readFile(path.join(dir, f)),
          ContentType: type(f),
          CacheControl: 'public, max-age=31536000, immutable',
        })),
      ),
    );
  }
}

async function processExperience(id: string) {
  const { rows } = await pool.query('SELECT source_key, format, stereo FROM experiences WHERE id = $1', [id]);
  const e = rows[0];
  if (!e) return;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'savana-'));
  try {
    const src = path.join(tmp, 'source');
    const obj = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: e.source_key }));
    await pipeline(obj.Body as Readable, createWriteStream(src));
    const info = await probe(src);
    const out = path.join(tmp, 'out');
    await fs.mkdir(out);
    const prefix = `pub/${id}`;
    let playbackKey: string;

    if (e.format === 'photo360') {
      await run('ffmpeg', ['-y', '-i', src, '-vf', `scale='min(iw,8192)':-2`, '-q:v', '3', path.join(out, 'photo.jpg')]);
      playbackKey = `${prefix}/photo.jpg`;
    } else {
      if (info.duration > MAX_VIDEO_SECONDS) throw new Error('Video is longer than 20 minutes');
      const even = (n: number) => n - (n % 2);
      let rungs = LADDER.filter((r) => r.w <= info.width);
      const top = rungs[0]?.w ?? 0;
      // Keep the source resolution when it sits between ladder rungs (e.g. 1920 wide) instead of dropping to a lower rung.
      if (info.width > top && info.width <= LADDER[0]!.w) {
        rungs = [{ w: even(info.width), bitrate: Math.round(3000 * (info.width / 1280) ** 1.7) }, ...rungs];
      }
      const n = rungs.length;
      const split = `[0:v]split=${n}${rungs.map((_, i) => `[v${i}]`).join('')}`;
      const scales = rungs.map((r, i) => `[v${i}]scale=${r.w}:-2[o${i}]`).join(';');
      const args = ['-y', '-i', src, '-filter_complex', `${split};${scales}`];
      rungs.forEach((_, i) => {
        args.push('-map', `[o${i}]`);
        if (info.hasAudio) args.push('-map', '0:a:0');
      });
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0');
      rungs.forEach((r, i) => args.push(`-b:v:${i}`, `${r.bitrate}k`, `-maxrate:v:${i}`, `${Math.round(r.bitrate * 1.1)}k`, `-bufsize:v:${i}`, `${r.bitrate * 2}k`));
      if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      const vsm = rungs.map((_, i) => (info.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' ');
      args.push('-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(out, 'v%v_%03d.ts'), '-master_pl_name', 'master.m3u8', '-var_stream_map', vsm, path.join(out, 'v%v.m3u8'));
      await run('ffmpeg', args);
      playbackKey = `${prefix}/master.m3u8`;
    }

    const thumbSeek = e.format === 'photo360' ? [] : ['-ss', String(Math.min(1, info.duration / 2))];
    await run('ffmpeg', ['-y', ...thumbSeek, '-i', src, '-frames:v', '1', '-vf', `${eyeCrop(e.stereo)}scale=640:-2`, '-q:v', '4', path.join(out, 'thumb.jpg')]);
    await uploadDir(out, prefix);

    await pool.query(
      `UPDATE experiences SET status = 'ready', playback_key = $2, thumb_key = $3, width = $4, height = $5,
         duration_s = $6, error = NULL, updated_at = now() WHERE id = $1`,
      [id, playbackKey, `${prefix}/thumb.jpg`, info.width, info.height, info.duration || null],
    );
  } catch (err) {
    console.error('processing failed', id, err);
    await pool.query(`UPDATE experiences SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [id, String((err as Error).message).slice(0, 500)]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

await startQueue();
await boss.work<{ experienceId: string }>(PROCESS_QUEUE, async (jobs) => {
  for (const job of jobs) await processExperience(job.data.experienceId);
});
console.log('worker ready');
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await boss.stop({ graceful: true, timeout: 30000 });
    await pool.end();
    process.exit(0);
  });
}
