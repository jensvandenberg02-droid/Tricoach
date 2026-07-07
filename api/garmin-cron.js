// api/garmin-cron.js
// Vercel Cron Job — draait elke ochtend om 06:00 UTC (08:00 Belgische tijd)
// Haalt Garmin gezondheidsdata op voor alle gebruikers met gekoppeld Garmin account
// en slaat deze op in de health_logs tabel

import { createClient } from '@supabase/supabase-js';
import { GarminConnect } from 'garmin-connect';

export const config = {
  maxDuration: 60, // max 60 seconden (Vercel Hobby limiet)
};

export default async function handler(req, res) {
  // Vercel stuurt een Authorization header mee bij cron jobs
  // Dit voorkomt dat iemand de endpoint manueel misbruikt
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Haal alle gebruikers op met Garmin credentials
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, garmin_email, garmin_password, display_name')
    .not('garmin_email', 'is', null)
    .not('garmin_password', 'is', null);

  if (error) {
    console.error('Fout bij ophalen gebruikers:', error);
    return res.status(500).json({ error: error.message });
  }

  if (!users?.length) {
    return res.status(200).json({ ok: true, message: 'Geen gebruikers met Garmin account.' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const user of users) {
    try {
      const client = new GarminConnect({
        username: user.garmin_email,
        password: user.garmin_password,
      });
      await client.login();

      // Haal vandaag's data op
      const [userStats, sleepData, hrvData] = await Promise.allSettled([
        client.getUserStats(user.garmin_email),
        client.getSleepData(today),
        client.getHrvData(today),
      ]);

      const stats   = userStats.status   === 'fulfilled' ? userStats.value   : null;
      const sleep   = sleepData.status   === 'fulfilled' ? sleepData.value   : null;
      const hrv     = hrvData.status     === 'fulfilled' ? hrvData.value     : null;

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

      // Upsert — overschrijft bestaande entry voor vandaag
      const { error: upsertErr } = await supabase
        .from('health_logs')
        .upsert(healthLog, { onConflict: 'user_id,date' });

      if (upsertErr) {
        results.push({ user: user.display_name, status: 'error', error: upsertErr.message });
      } else {
        results.push({ user: user.display_name, status: 'ok', date: today });
        console.log(`✅ Garmin sync OK: ${user.display_name} (${today})`);
      }
    } catch (e) {
      console.error(`❌ Garmin sync mislukt voor ${user.display_name}:`, e.message);
      results.push({ user: user.display_name, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ ok: true, synced: results.length, results });
}
