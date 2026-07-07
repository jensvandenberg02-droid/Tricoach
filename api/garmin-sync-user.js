// api/garmin-sync-user.js
// Synct Garmin data voor de ingelogde gebruiker
// Wordt aangeroepen direct nadat de gebruiker zijn Garmin credentials invult

import { createClient } from '@supabase/supabase-js';
import { GarminConnect } from 'garmin-connect';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verifieer Supabase JWT
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.replace('Bearer ', '');

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Haal ingelogde gebruiker op via JWT
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Ongeldige sessie' });
  }

  // Haal Garmin credentials op
  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('garmin_email, garmin_password, display_name')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile?.garmin_email || !profile?.garmin_password) {
    return res.status(400).json({ error: 'Geen Garmin credentials gevonden' });
  }

  try {
    const client = new GarminConnect({
      username: profile.garmin_email,
      password: profile.garmin_password,
    });
    await client.login();

    const today = new Date().toISOString().slice(0, 10);

    const [userStats, sleepData, hrvData] = await Promise.allSettled([
      client.getUserStats(profile.garmin_email),
      client.getSleepData(today),
      client.getHrvData(today),
    ]);

    const stats = userStats.status === 'fulfilled' ? userStats.value : null;
    const sleep = sleepData.status === 'fulfilled' ? sleepData.value : null;
    const hrv   = hrvData.status   === 'fulfilled' ? hrvData.value   : null;

    const healthLog = {
      user_id:      user.id,
      date:         today,
      readiness:    stats?.bodyBatteryChargedValue     ?? null,
      body_battery: stats?.bodyBatteryMostRecentValue  ?? null,
      sleep_hours:  sleep?.dailySleepDTO?.sleepTimeSeconds
                      ? Math.round(sleep.dailySleepDTO.sleepTimeSeconds / 360) / 10
                      : null,
      sleep_score:  sleep?.dailySleepDTO?.sleepScores?.overall?.value ?? null,
      hrv:          hrv?.hrvSummary?.lastNight          ?? null,
      stress_pct:   stats?.averageStressLevel           ?? null,
      steps:        stats?.totalSteps                   ?? null,
      notes:        'Automatisch gesynchroniseerd via Garmin',
    };

    const { error: upsertErr } = await sb
      .from('health_logs')
      .upsert(healthLog, { onConflict: 'user_id,date' });

    if (upsertErr) {
      return res.status(500).json({ error: upsertErr.message });
    }

    return res.status(200).json({ ok: true, date: today, data: healthLog });
  } catch (e) {
    console.error('Garmin sync mislukt:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
