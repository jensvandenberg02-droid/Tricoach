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
    .select('strava_access_token')
    .eq('id', user.id)
    .single();

  if (!profile?.strava_access_token) {
    return res.status(400).json({ error: 'Geen Strava account gekoppeld' });
  }

  const at = profile.strava_access_token;
  const h  = { Authorization: `Bearer ${at}` };

  // Haal activiteitsdetails, rondes en streams parallel op
  const [actRes, lapsRes, streamsRes] = await Promise.all([
    fetch(`https://www.strava.com/api/v3/activities/${id}`, { headers: h }),
    fetch(`https://www.strava.com/api/v3/activities/${id}/laps`, { headers: h }),
    fetch(
      `https://www.strava.com/api/v3/activities/${id}/streams` +
      `?keys=distance,altitude,heartrate,velocity_smooth&key_by_type=true`,
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
