// api/strava-activity.js
// GET /api/strava-activity?id={activityId}
// Haalt volledige activiteitsdetails op: activiteit + rondes + streams

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id is required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('strava_access_token, strava_refresh_token, strava_token_expires_at')
    .eq('id', user.id)
    .single();

  if (!profile?.strava_access_token) {
    return res.status(400).json({ error: 'Geen Strava account gekoppeld' });
  }

  // Ververs token als verlopen (zelfde logica als strava-sync.js)
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

  const h = { Authorization: `Bearer ${accessToken}` };

  // Haal activiteitsdetails, rondes en streams parallel op
  const [actRes, lapsRes, streamsRes] = await Promise.all([
    fetch(`https://www.strava.com/api/v3/activities/${id}`, { headers: h }),
    fetch(`https://www.strava.com/api/v3/activities/${id}/laps`, { headers: h }),
    fetch(
      `https://www.strava.com/api/v3/activities/${id}/streams` +
      `?keys=distance,altitude,heartrate,velocity_smooth,latlng&key_by_type=true`,
      { headers: h }
    ),
  ]);

  if (!actRes.ok) {
    return res.status(actRes.status).json({ error: 'Activiteit niet gevonden of geen toegang.' });
  }

  const [activity, laps, streams] = await Promise.all([
    actRes.json(),
    lapsRes.json(),
    streamsRes.json(),
  ]);

  return res.status(200).json({
    ok: true,
    activity,
    laps:    Array.isArray(laps) ? laps : [],
    streams: streams && !streams.errors ? streams : {},
  });
}
