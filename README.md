# Savana

Immersive travel platform: tourists share 360 and VR180 captures that others explore in a browser or a VR headset.

```
savana/
  backend/    TypeScript API + media worker (Fastify, Postgres/PostGIS, pg-boss, S3, FFmpeg)
  frontend/   WebXR viewer (Three.js, hls.js) connected to the API
```

## Run it
```bash
# 1. Backend
cd backend
cp .env.example .env        # set JWT_SECRET to 32+ random characters
docker compose up --build   # db, MinIO, API on :3000, worker

# 2. Frontend (second terminal)
cd frontend
npx serve -l 5173 .         # http://localhost:5173
```

The backend allows the origin `http://localhost:5173` by default (`CORS_ORIGINS` in `.env`). Serve the frontend from that port, or add your origin there. Opening `index.html` straight from disk will not work because browsers send a `null` origin.

To point the page at another API, open it with `?api=https://your-api.example.com`.

## What the frontend does
- Loads the feed and map pins from `GET /experiences` and `GET /map`, with category filters and paging.
- Plays 360 photos, and 360 or VR180 video (HLS) in the browser or in a headset with Enter VR. Stereo captures show the left or top eye on screen.
- Register, sign in, and upload from the page: create draft, direct upload to storage with progress, queue processing, then poll until the experience is ready.
- Falls back to three generated sample scenes with a notice when the API is unreachable.

## Before using real uploads
- Storage CORS: the browser uploads directly to the bucket and loads media from it. MinIO allows this by default; on S3 or R2, add a CORS rule for your frontend origin (POST and GET).
- Set `PUBLIC_MEDIA_URL` and `S3_PUBLIC_ENDPOINT` in `.env` to URLs your browser can reach (the defaults work for local Docker).

See `backend/README.md` for the endpoint list and deployment notes.

## Verified so far
The backend was run end to end against real Postgres 16 with PostGIS, FFmpeg, and an S3-compatible server (moto, standing in for MinIO). `backend/test/e2e.py` passed all checks: accounts, direct upload, queueing, HLS and photo processing, thumbnails, paging, filters, search, map pins, delete, and CORS.

Not verified: `docker compose` and the Dockerfile (no Docker was available), the frontend in a real browser, and playback on an actual headset. Run those first on your machine.
