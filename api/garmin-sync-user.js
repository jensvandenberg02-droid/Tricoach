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

    const [sleepData, heartRateData, stepsData] = await Promise.allSettled([
      client.getSleepData(todayDate),
      client.getHeartRate(todayDate),
      client.getSteps(todayDate),
    ]);

    const sleep = sleepData.status     === 'fulfilled' ? sleepData.value     : null;
    const hr    = heartRateData.status === 'fulfilled' ? heartRateData.value : null;
    const steps = stepsData.status     === 'fulfilled' ? stepsData.value     : null;

    // Log ruwe data zodat we de structuur kunnen zien
    console.log('SLEEP RAW:', JSON.stringify(sleep));
    console.log('HR RAW:', JSON.stringify(hr));
    console.log('STEPS RAW:', JSON.stringify(steps));

    // Slaapdata
    const sleepSec = sleep?.dailySleepDTO?.sleepTimeSeconds
                  ?? sleep?.sleepTimeSeconds
                  ?? null;
    const sleepScore = sleep?.dailySleepDTO?.sleepScores?.overall?.value
                    ?? sleep?.averageSpO2Value
                    ?? null;

    // Stappen
    let totalSteps = null;
    if (Array.isArray(steps)) {
      totalSteps = steps.reduce((s, d) => s + (d.steps || d.totalSteps || 0), 0) || null;
    } else if (steps?.totalSteps != null) {
      totalSteps = steps.totalSteps;
    } else if (steps?.stepGoal != null) {
      totalSteps = steps.stepGoal;
    }

    // HRV
    const hrv = hr?.lastNight ?? hr?.hrvSummary?.lastNight ?? hr?.hrvValue ?? null;

    // Body battery: laatste waarde uit de slaap array
    const bbArray = sleep?.sleepBodyBattery;
    const bodyBattery = Array.isArray(bbArray) && bbArray.length
      ? bbArray[bbArray.length - 1]?.value ?? null
      : null;

    const healthLog = {
      user_id:      user.id,
      date:         today,
      readiness:    null,
      body_battery: bodyBattery,
      sleep_hours:  sleepSec ? Math.round(sleepSec / 360) / 10 : null,
      sleep_score:  sleepScore,
      hrv:          sleep?.avgOvernightHrv ?? null,
      stress_pct:   null,
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
