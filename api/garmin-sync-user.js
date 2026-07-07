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

    const todayDate = new Date();
    const today = todayDate.toISOString().slice(0, 10);

    const [sleepData, stepsData, maxMetricsData] = await Promise.allSettled([
      client.getSleepData(todayDate),
      client.getSteps(todayDate),
      client.getMaxMetrics(todayDate),
    ]);

    const sleep      = sleepData.status      === 'fulfilled' ? sleepData.value      : null;
    const steps      = stepsData.status      === 'fulfilled' ? stepsData.value      : null;
    const maxMetrics = maxMetricsData.status === 'fulfilled' ? maxMetricsData.value : null;

    console.log('SLEEP RAW:', JSON.stringify(sleep));
    console.log('STEPS RAW:', JSON.stringify(steps));
    console.log('MAX METRICS RAW:', JSON.stringify(maxMetrics));

    // Slaapdata
    const sleepSec = sleep?.dailySleepDTO?.sleepTimeSeconds
                  ?? sleep?.sleepTimeSeconds
                  ?? null;
    const sleepScore = sleep?.dailySleepDTO?.sleepScores?.overall?.value
                    ?? sleep?.averageSpO2Value
                    ?? null;

    // Stappen
    let totalSteps = null;
    if (typeof steps === 'number') {
      totalSteps = steps || null;
    } else if (Array.isArray(steps)) {
      totalSteps = steps.reduce((s, d) => s + (d.steps || d.totalSteps || 0), 0) || null;
    } else if (steps?.totalSteps != null) {
      totalSteps = steps.totalSteps;
    }

    // HRV
    const hrv = hr?.lastNight ?? hr?.hrvSummary?.lastNight ?? hr?.hrvValue ?? null;

    // Body battery: laatste waarde uit de slaap array
    const bbArray = sleep?.sleepBodyBattery;
    const bodyBattery = Array.isArray(bbArray) && bbArray.length
      ? bbArray[bbArray.length - 1]?.value ?? null
      : null;

    // VO2max
    const vo2max = maxMetrics?.generic?.vo2MaxPreciseValue
                ?? maxMetrics?.[0]?.generic?.vo2MaxPreciseValue
                ?? null;

    const healthLog = {
      user_id:      user.id,
      date:         today,
      vo2max:       vo2max ? Math.round(vo2max * 10) / 10 : null,
      body_battery: bodyBattery,
      sleep_hours:  sleepSec ? Math.round(sleepSec / 360) / 10 : null,
      sleep_score:  sleepScore,
      hrv:          sleep?.avgOvernightHrv ?? null,
      steps:        totalSteps,
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
