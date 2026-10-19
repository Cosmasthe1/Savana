CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'creator' CHECK (role IN ('creator','admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE experiences (
  id           uuid PRIMARY KEY,
  creator_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  category     text NOT NULL CHECK (category IN ('wildlife','coast','culture','adventure','city','other')),
  place_name   text NOT NULL,
  location     geography(Point,4326) NOT NULL,
  format       text NOT NULL CHECK (format IN ('photo360','video360','vr180','spatial','splat')),
  stereo       text NOT NULL DEFAULT 'mono' CHECK (stereo IN ('mono','top-bottom','side-by-side')),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','processing','ready','failed','removed')),
  source_key   text NOT NULL,
  playback_key text,
  thumb_key    text,
  width        int,
  height       int,
  duration_s   real,
  error        text,
  view_count   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX experiences_location_gix ON experiences USING gist (location);
CREATE INDEX experiences_feed_idx ON experiences (created_at DESC, id DESC) WHERE status = 'ready';
CREATE INDEX experiences_creator_idx ON experiences (creator_id, created_at DESC);
CREATE INDEX experiences_search_idx ON experiences
  USING gin (to_tsvector('simple', title || ' ' || coalesce(place_name, '')));
