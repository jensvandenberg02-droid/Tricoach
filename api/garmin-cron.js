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

  const todayDate      = new Date();
  const today          = todayDate.toISOString().slice(0, 10);
  const yesterdayDate  = new Date(Date.now() - 86_400_000);
  const yesterday      = yesterdayDate.toISOString().slice(0, 10);
  const results = [];

  for (const user of users) {
    try {
      const client = new GarminConnect({
        username: user.garmin_email,
        password: user.garmin_password,
      });
      await client.login();

      // Slaap ophalen voor vandaag (= gisternacht — Garmin koppelt slaap aan de ochtend)
      // Stappen ophalen voor gisteren (complete dag — vandaag is nog niet afgerond)
      const [sleepData, stepsData] = await Promise.allSettled([
        client.getSleepData(todayDate),
        client.getSteps(yesterdayDate),
      ]);

      const sleep = sleepData.status === 'fulfilled' ? sleepData.value : null;
      const steps = stepsData.status === 'fulfilled' ? stepsData.value : null;

      // Body battery: laatste waarde uit de slaap array
      const bbArray = sleep?.sleepBodyBattery;
      const bodyBattery = Array.isArray(bbArray) && bbArray.length
        ? bbArray[bbArray.length - 1]?.value ?? null
        : null;

      // Stappen van gisteren
      let totalSteps = null;
      if (typeof steps === 'number') {
        totalSteps = steps || null;
      } else if (Array.isArray(steps)) {
        totalSteps = steps.reduce((s, d) => s + (d.steps || d.totalSteps || 0), 0) || null;
      } else if (steps?.totalSteps != null) {
        totalSteps = steps.totalSteps;
      }

      // ── 1. Slaap/HRV/body battery → opslaan als vandaag ──────────────────────
      const sleepLog = {
        user_id:      user.id,
        date:         today,
        vo2max:       null,
        body_battery: bodyBattery,
        sleep_hours:  sleep?.dailySleepDTO?.sleepTimeSeconds
                        ? Math.round(sleep.dailySleepDTO.sleepTimeSeconds / 360) / 10
                        : null,
        sleep_score:  sleep?.dailySleepDTO?.sleepScores?.overall?.value ?? null,
        hrv:          sleep?.avgOvernightHrv ?? null,
        steps:        null, // stappen komen van gisteren, niet vandaag
        notes:        'Automatisch gesynchroniseerd via Garmin',
      };

      const { error: sleepErr } = await supabase
        .from('health_logs')
        .upsert(sleepLog, { onConflict: 'user_id,date' });

      if (sleepErr) {
        results.push({ user: user.display_name, status: 'error', error: sleepErr.message });
        continue;
      }

      // ── 2. Stappen van gisteren → apart upserten zodat gisteren's slaapdata intact blijft ──
      if (totalSteps !== null) {
        const { data: existing } = await supabase
          .from('health_logs')
          .select('id')
          .eq('user_id', user.id)
          .eq('date', yesterday)
          .maybeSingle();

        if (existing) {
          await supabase.from('health_logs')
            .update({ steps: totalSteps })
            .eq('user_id', user.id)
            .eq('date', yesterday);
        } else {
          await supabase.from('health_logs').insert({
            user_id: user.id,
            date:    yesterday,
            steps:   totalSteps,
            notes:   'Garmin stappen (automatisch)',
          });
        }
      }

      results.push({ user: user.display_name, status: 'ok', date: today, stepsDate: yesterday });
      console.log(`✅ Garmin sync OK: ${user.display_name} — slaap ${today}, stappen ${yesterday}`);
    } catch (e) {
      console.error(`❌ Garmin sync mislukt voor ${user.display_name}:`, e.message);
      results.push({ user: user.display_name, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ ok: true, synced: results.length, results });
}
