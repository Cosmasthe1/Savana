import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { config, CATEGORIES } from './config.js';
import { pool, migrate } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { boss, startQueue, PROCESS_QUEUE } from './queue.js';
import { s3, presignUpload, mediaUrl } from './storage.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: string };
    user: { sub: string; role: string };
  }
}
declare module 'fastify' {
  interface FastifyInstance {
    auth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const ALLOWED_TYPES: Record<string, string[]> = {
  photo360: ['image/jpeg', 'image/png', 'image/webp'],
  video360: ['video/mp4', 'video/quicktime', 'video/webm'],
  vr180: ['video/mp4', 'video/quicktime', 'video/webm'],
};

const createBody = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).optional(),
    category: z.enum(CATEGORIES),
    placeName: z.string().trim().min(2).max(120),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    format: z.enum(['photo360', 'video360', 'vr180']),
    stereo: z.enum(['mono', 'top-bottom', 'side-by-side']).default('mono'),
    filename: z.string().min(1).max(200),
    contentType: z.string(),
    sizeBytes: z.number().int().positive().max(config.MAX_UPLOAD_BYTES),
  })
  .superRefine((b, ctx) => {
    if (!ALLOWED_TYPES[b.format]!.includes(b.contentType)) {
      ctx.addIssue({ code: 'custom', path: ['contentType'], message: `Not allowed for ${b.format}` });
    }
  });

const listQuery = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/).optional(),
  category: z.enum(CATEGORIES).optional(),
  q: z.string().trim().min(2).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const SELECT = `e.*, ST_Y(e.location::geometry) AS lat, ST_X(e.location::geometry) AS lon,
  u.display_name AS creator_name, e.created_at::text AS cursor_ts`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dto = (r: any) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  category: r.category,
  placeName: r.place_name,
  lat: r.lat,
  lon: r.lon,
  format: r.format,
  stereo: r.stereo,
  status: r.status,
  playbackUrl: r.playback_key ? mediaUrl(r.playback_key) : null,
  thumbUrl: r.thumb_key ? mediaUrl(r.thumb_key) : null,
  width: r.width,
  height: r.height,
  durationS: r.duration_s,
  viewCount: r.view_count,
  creator: { id: r.creator_id, name: r.creator_name },
  createdAt: r.created_at,
  error: r.error ?? undefined,
});

function filters(q: z.infer<typeof listQuery>) {
  const where = [`e.status = 'ready'`];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.bbox) {
    const [a, b, c, d] = q.bbox.split(',').map(Number);
    params.push(a, b, c, d);
    const n = params.length;
    where.push(`e.location && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)::geography`);
  }
  if (q.category) add('e.category = ?', q.category);
  if (q.q) {
    add(
      `to_tsvector('simple', e.title || ' ' || coalesce(e.place_name, '')) @@ websearch_to_tsquery('simple', ?)`,
      q.q,
    );
  }
  return { where, params };
}

const app = Fastify({ logger: true, trustProxy: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  return reply.code(status).send({ error: status >= 500 ? 'internal_error' : (err as Error).message });
});

await app.register(cors, { origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',') });
await app.register(rateLimit, { global: false });
await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: '7d' } });
app.decorate('auth', async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

// ---------- auth ----------
const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

app.post('/auth/register', authLimit, async (req, reply) => {
  const b = z
    .object({
      email: z.string().email().transform((s) => s.toLowerCase()),
      password: z.string().min(10).max(200),
      displayName: z.string().trim().min(2).max(60),
    })
    .parse(req.body);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, role',
      [b.email, b.displayName, await hashPassword(b.password)],
    );
    const u = rows[0];
    return reply.code(201).send({ token: app.jwt.sign({ sub: u.id, role: u.role }), user: { id: u.id, displayName: b.displayName } });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email_taken' });
    throw e;
  }
});

app.post('/auth/login', authLimit, async (req, reply) => {
  const b = z.object({ email: z.string().email(), password: z.string().max(200) }).parse(req.body);
  const { rows } = await pool.query('SELECT id, role, display_name, password_hash FROM users WHERE lower(email) = lower($1)', [b.email]);
  const u = rows[0];
  if (!u || !(await verifyPassword(b.password, u.password_hash))) return reply.code(401).send({ error: 'invalid_credentials' });
  return { token: app.jwt.sign({ sub: u.id, role: u.role }), user: { id: u.id, displayName: u.display_name } };
});

app.get('/me', { preHandler: [app.auth] }, async (req) => {
  const { rows } = await pool.query('SELECT id, email, display_name, role FROM users WHERE id = $1', [req.user.sub]);
  return rows[0];
});

// ---------- experiences ----------
app.post('/experiences', { preHandler: [app.auth] }, async (req, reply) => {
  const b = createBody.parse(req.body);
  const id = randomUUID();
  const ext = path.extname(b.filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const key = `raw/${req.user.sub}/${id}/source${ext}`;
  await pool.query(
    `INSERT INTO experiences (id, creator_id, title, description, category, place_name, location, format, stereo, source_key)
     VALUES ($1,$2,$3,$4,$5,$6, ST_SetSRID(ST_MakePoint($7,$8),4326)::geography, $9,$10,$11)`,
    [id, req.user.sub, b.title, b.description ?? null, b.category, b.placeName, b.lon, b.lat, b.format, b.stereo, key],
  );
  const upload = await presignUpload(key, b.contentType);
  return reply.code(201).send({ id, upload });
});

app.post('/experiences/:id/complete', { preHandler: [app.auth] }, async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const { rows } = await pool.query('SELECT source_key, status FROM experiences WHERE id = $1 AND creator_id = $2', [id, req.user.sub]);
  const e = rows[0];
  if (!e) return reply.code(404).send({ error: 'not_found' });
  if (e.status !== 'draft') return reply.code(409).send({ error: 'already_submitted' });
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: e.source_key }));
  } catch {
    return reply.code(409).send({ error: 'upload_missing' });
  }
  await pool.query(`UPDATE experiences SET status = 'processing', updated_at = now() WHERE id = $1`, [id]);
  await boss.send(PROCESS_QUEUE, { experienceId: id }, { retryLimit: 0 });
  return reply.code(202).send({ id, status: 'processing' });
});

app.get('/experiences', async (req) => {
  const q = listQuery.parse(req.query);
  const { where, params } = filters(q);
  if (q.cursor) {
    const [ts, cid] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !cid || !z.string().uuid().safeParse(cid).success || Number.isNaN(Date.parse(ts))) {
      throw Object.assign(new Error('bad_cursor'), { statusCode: 400 });
    }
    params.push(ts, cid);
    where.push(`(e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const { rows } = await pool.query(
    `SELECT ${SELECT} FROM experiences e JOIN users u ON u.id = e.creator_id
     WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(dto),
    nextCursor: more && last ? Buffer.from(`${last.cursor_ts}|${last.id}`).toString('base64url') : null,
  };
});

app.get('/map', async (req) => {
  const q = listQuery.parse(req.query);
  const { where, params } = filters(q);
  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.category, e.thumb_key, ST_Y(e.location::geometry) AS lat, ST_X(e.location::geometry) AS lon
     FROM experiences e WHERE ${where.join(' AND ')} ORDER BY e.view_count DESC LIMIT 500`,
    params,
  );
  return {
    pins: rows.map((r) => ({ id: r.id, title: r.title, category: r.category, lat: r.lat, lon: r.lon, thumbUrl: r.thumb_key ? mediaUrl(r.thumb_key) : null })),
  };
});

app.get('/experiences/:id', async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  let userId: string | null = null;
  try {
    await req.jwtVerify();
    userId = req.user.sub;
  } catch {
    /* anonymous */
  }
  const { rows } = await pool.query(
    `SELECT ${SELECT} FROM experiences e JOIN users u ON u.id = e.creator_id WHERE e.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r || r.status === 'removed' || (r.status !== 'ready' && r.creator_id !== userId)) return reply.code(404).send({ error: 'not_found' });
  return dto(r);
});

app.post('/experiences/:id/view', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  await pool.query(`UPDATE experiences SET view_count = view_count + 1 WHERE id = $1 AND status = 'ready'`, [id]);
  return reply.code(204).send();
});

app.delete('/experiences/:id', { preHandler: [app.auth] }, async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const r = await pool.query(
    `UPDATE experiences SET status = 'removed', updated_at = now() WHERE id = $1 AND (creator_id = $2 OR $3 = 'admin') AND status <> 'removed'`,
    [id, req.user.sub, req.user.role],
  );
  return r.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
});

app.get('/me/experiences', { preHandler: [app.auth] }, async (req) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT} FROM experiences e JOIN users u ON u.id = e.creator_id
     WHERE e.creator_id = $1 AND e.status <> 'removed' ORDER BY e.created_at DESC LIMIT 100`,
    [req.user.sub],
  );
  return { items: rows.map(dto) };
});

// ---------- boot ----------
await migrate();
await startQueue();
await app.listen({ port: config.PORT, host: '0.0.0.0' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}
