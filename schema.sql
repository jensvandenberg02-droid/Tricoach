-- TriCoach Supabase schema
-- Plak dit in de Supabase SQL Editor en run het

-- Profielen (één per gebruiker, gekoppeld aan Strava)
CREATE TABLE IF NOT EXISTS profiles (
  id                      UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  display_name            TEXT,
  avatar_url              TEXT,
  strava_athlete_id       BIGINT UNIQUE,
  strava_access_token     TEXT,
  strava_refresh_token    TEXT,
  strava_token_expires_at BIGINT,
  garmin_email            TEXT,
  garmin_password         TEXT,   -- bewaar versleuteld in productie
  gh_repo                 TEXT,   -- owner/repo voor Garmin push via GitHub Actions
  gh_token                TEXT,   -- GitHub PAT (fine-grained)
  weight_kg               FLOAT   DEFAULT 70,
  ftp                     INT     DEFAULT 200,
  max_hr                  INT     DEFAULT 190,
  rest_hr                 INT     DEFAULT 50,
  vo2max                  FLOAT   DEFAULT 50,
  run_pace                TEXT    DEFAULT '5:30',
  swim_css                TEXT    DEFAULT '1:40',
  bike_cad                INT     DEFAULT 85,
  run_cad                 INT     DEFAULT 170,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Events (races, wedstrijden)
CREATE TABLE IF NOT EXISTS events (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID    REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name        TEXT    NOT NULL,
  date        DATE    NOT NULL,
  type        TEXT    NOT NULL,
  priority    TEXT    DEFAULT 'A',
  country     TEXT,
  city        TEXT,
  dist_swim   FLOAT,
  dist_bike   FLOAT,
  dist_run    FLOAT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_user_date ON events(user_id, date);

-- Blessures
CREATE TABLE IF NOT EXISTS injuries (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID    REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name        TEXT    NOT NULL,
  body_parts  TEXT[]  DEFAULT '{}',
  severity    TEXT    DEFAULT 'mild',
  start_date  DATE    NOT NULL,
  end_date    DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS injuries_user ON injuries(user_id);

-- Manuele gezondheidsdata (Garmin-waarden handmatig ingevoerd)
CREATE TABLE IF NOT EXISTS health_logs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  date            DATE NOT NULL,
  readiness       INT,
  sleep_hours     FLOAT,
  sleep_score     INT,
  hrv             INT,
  body_battery    INT,
  stress_pct      INT,
  steps           INT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Sessie-voortgang (welke sessies zijn afgevinkt)
CREATE TABLE IF NOT EXISTS session_done (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  done_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, session_key)
);

-- ── RLS policies ──
ALTER TABLE profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE injuries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_done ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own profile"      ON profiles;
DROP POLICY IF EXISTS "Own events"       ON events;
DROP POLICY IF EXISTS "Own injuries"     ON injuries;
DROP POLICY IF EXISTS "Own health logs"  ON health_logs;
DROP POLICY IF EXISTS "Own session done" ON session_done;

CREATE POLICY "Own profile"      ON profiles     FOR ALL USING (auth.uid() = id);
CREATE POLICY "Own events"       ON events       FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own injuries"     ON injuries     FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own health logs"  ON health_logs  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Own session done" ON session_done FOR ALL USING (auth.uid() = user_id);
