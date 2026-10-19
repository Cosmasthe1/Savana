# Savana API

TypeScript backend for Savana: accounts, upload intake, a media-processing worker, and geo-aware discovery.
Stack: Fastify 5, Postgres + PostGIS, pg-boss (queue in Postgres), S3-compatible storage, FFmpeg.

## Run locally

```bash
cp .env.example .env          # set JWT_SECRET to 32+ random characters
docker compose up --build     # db, MinIO, api on :3000, worker
```

Migrations run automatically when the API starts. MinIO console: http://localhost:9001 (savana / savanasecret).

## Test it

With the API and worker running and an empty database (needs `ffmpeg` and Python `requests`):

```bash
npm run test:e2e     # or: API_URL=http://localhost:3000 python3 test/e2e.py
```

It registers a user, uploads a 360 photo, a 360 video and a VR180 video, waits for processing, then checks playback files, thumbnails, paging, filters, search, map pins, views, delete, and CORS.

## Upload flow

1. `POST /auth/register` or `/auth/login` returns a JWT.
2. `POST /experiences` with metadata and file info returns `{ id, upload: { url, fields } }`.
3. The client uploads straight to storage with a multipart form POST: all `fields` first, then the `file` field last.
4. `POST /experiences/:id/complete` verifies the object exists and queues processing (status `processing`).
5. The worker transcodes (HLS ladder for video, resized JPEG for photos), writes a thumbnail, and marks the experience `ready` (or `failed` with an error message).
6. Viewers fetch `GET /experiences`, `GET /map`, `GET /experiences/:id` and play `playbackUrl`.

```bash
TOKEN=$(curl -s localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-password","displayName":"Cosmas"}' | jq -r .token)

curl -s localhost:3000/experiences -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "title":"Dawn over the Mara","category":"wildlife","placeName":"Maasai Mara","lat":-1.5,"lon":35.1,
  "format":"photo360","filename":"mara.jpg","contentType":"image/jpeg","sizeBytes":4000000 }'
# then: curl -F key=... (every field from the response) -F file=@mara.jpg <upload.url>
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | /health | DB check |
| POST | /auth/register, /auth/login | Rate limited |
| GET | /me, /me/experiences | Auth |
| POST | /experiences | Create draft and presigned upload |
| POST | /experiences/:id/complete | Queue processing |
| GET | /experiences | Filters: `bbox=minLon,minLat,maxLon,maxLat`, `category`, `q`, `limit`, `cursor` |
| GET | /map | Pins for a bbox (max 500) |
| GET | /experiences/:id | Public if ready; owner can see any status |
| POST | /experiences/:id/view | Increments the view counter |
| DELETE | /experiences/:id | Owner or admin; soft delete |

## Deploying

- Run `api` and `worker` as separate Deployments from the same image. The worker needs FFmpeg (already in the image).
- Scale workers on queue depth (for example KEDA on the `pgboss.job` table), since video transcoding is CPU-bound.
- Use managed Postgres with PostGIS, S3 or R2 for storage, and put a CDN in front of the `pub/` prefix. Set `PUBLIC_MEDIA_URL` to the CDN URL and keep `raw/` private.
- Add a bucket lifecycle rule for `raw/` to control storage cost.
- Set `CORS_ORIGINS` to your web app origin, and allow that origin in the bucket CORS policy for browser uploads.

## Known limits (next steps)

- Uploads are single POST up to `MAX_UPLOAD_BYTES` (5 GB). Add multipart/resumable uploads for flaky mobile networks.
- Inputs must be stitched exports (JPG, PNG, MP4, MOV). Raw `.insv` and `.insp` files are not handled.
- Location comes from the creator, not from file GPS metadata.
- No moderation, face or plate blurring, likes, follows, or comments yet.
- Tests: one end-to-end script (`npm run test:e2e`). There are no unit tests yet.
