// api/strava-sync.js
// Haalt recente Strava activiteiten op en berekent FTP/pace stats
// Wordt aangeroepen door de app na login of via een "Sync" knop

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // Haal profiel op met Strava tokens
  const { data: profile } = await supabase
    .from('profiles')
    .select('strava_access_token, strava_refresh_token, strava_token_expires_at')
    .eq('id', user.id)
    .single();

  if (!profile?.strava_access_token) {
    return res.status(400).json({ error: 'Geen Strava account gekoppeld' });
  }

  // Ververs token als verlopen
  let accessToken = profile.strava_access_token;
  if (Date.now() / 1000 > (profile.strava_token_expires_at - 300)) {
    try {
      const refreshRes = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          grant_type:    'refresh_token',
          refresh_token: profile.strava_refresh_token,
        }),
      });
      const refreshed = await refreshRes.json();
      if (!refreshRes.ok) throw new Error(refreshed.message);
      accessToken = refreshed.access_token;
      await supabase.from('profiles').update({
        strava_access_token:     refreshed.access_token,
        strava_refresh_token:    refreshed.refresh_token,
        strava_token_expires_at: refreshed.expires_at,
      }).eq('id', user.id);
    } catch (e) {
      return res.status(500).json({ error: 'Token refresh mislukt: ' + e.message });
    }
  }

  // Haal atleet op
  const athleteRes = await fetch('https://www.strava.com/api/v3/athlete', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const athlete = await athleteRes.json();

  // Haal laatste 100 activiteiten op
  const activitiesRes = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=100',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const activities = await activitiesRes.json();

  if (!Array.isArray(activities)) {
    return res.status(500).json({ error: 'Strava activities ophalen mislukt', detail: activities });
  }

  // Bereken stats uit activiteiten
  const runs  = activities.filter(a => a.type === 'Run'  && a.distance > 3000);
  const rides = activities.filter(a => a.type === 'Ride' && a.distance > 10000);
  const swims = activities.filter(a => a.type === 'Swim' && a.distance > 200);

  // Beste 5k pace (snelste run >= 5km)
  let runPace = null;
  const fiveKRuns = runs.filter(a => a.distance >= 4800 && a.distance <= 10000);
  if (fiveKRuns.length) {
    const best = fiveKRuns.reduce((a, b) => (a.average_speed > b.average_speed ? a : b));
    const secPerKm = 1000 / best.average_speed;
    runPace = `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}`;
  }

  // Beste 100m zwemtijd (CSS benadering)
  let swimCss = null;
  if (swims.length) {
    const best = swims.reduce((a, b) => (a.average_speed > b.average_speed ? a : b));
    const secPer100 = 100 / best.average_speed;
    swimCss = `${Math.floor(secPer100 / 60)}:${String(Math.round(secPer100 % 60)).padStart(2, '0')}`;
  }

  // FTP benadering via beste 20-min power (als average_watts beschikbaar)
  let ftp = null;
  const powerRides = rides.filter(a => a.average_watts && a.moving_time >= 1200);
  if (powerRides.length) {
    const best = powerRides.reduce((a, b) => {
      const scoreA = a.average_watts * Math.min(1, a.moving_time / 3600);
      const scoreB = b.average_watts * Math.min(1, b.moving_time / 3600);
      return scoreA > scoreB ? a : b;
    });
    ftp = Math.round(best.average_watts * 0.95);
  }

  // Gemiddeld cadence (lopen)
  const cadRuns = runs.filter(a => a.average_cadence);
  const runCad  = cadRuns.length
    ? Math.round(cadRuns.reduce((s, a) => s + a.average_cadence, 0) / cadRuns.length * 2)
    : null;

  // Update profiel
  const updates = { updated_at: new Date().toISOString() };
  if (runPace) updates.run_pace = runPace;
  if (swimCss) updates.swim_css = swimCss;
  if (ftp)     updates.ftp = ftp;
  if (runCad)  updates.run_cad = runCad;
  if (athlete.weight) updates.weight_kg = athlete.weight;

  await supabase.from('profiles').update(updates).eq('id', user.id);

  // Stuur activiteiten terug als JSON (app kan ze renderen)
  const simplified = activities.slice(0, 30).map(a => ({
    id:       a.id,
    name:     a.name,
    type:     a.type,
    date:     a.start_date_local?.slice(0, 10),
    distance: Math.round(a.distance),
    duration: a.moving_time,
    pace:     a.average_speed
      ? `${Math.floor(1000 / a.average_speed / 60)}:${String(Math.round((1000 / a.average_speed) % 60)).padStart(2, '0')}`
      : null,
    watts:    a.average_watts || null,
    hr:       a.average_heartrate || null,
    kudos:    a.kudos_count,
    map:      a.map?.summary_polyline || null,
  }));

  return res.status(200).json({
    ok:           true,
    stats:        updates,
    activities:   simplified,
    activityCount: activities.length,
  });
}
