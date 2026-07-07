// api/garmin-push.js
// Vercel Serverless Function — pusht een workout naar Garmin Connect
// Gebruikt de garmin-connect npm package (unofficiële API, email+wachtwoord)

import { GarminConnect } from 'garmin-connect';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: haal Supabase sessie op via Authorization header
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verifieer de sessie
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // Haal Garmin credentials op uit profiel
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('garmin_email, garmin_password')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile?.garmin_email || !profile?.garmin_password) {
    return res.status(400).json({ error: 'Geen Garmin credentials gevonden. Vul die in via Profiel.' });
  }

  // Workout payload uit request body
  const { name, description, type, startTime, durationSeconds, distanceMeters, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const client = new GarminConnect({
      username: profile.garmin_email,
      password: profile.garmin_password,
    });
    await client.login();

    const sportType = mapSportType(type || 'run');
    const durationSec = durationSeconds || 3600;

    // Garmin uses Jackson polymorphic deserialization — the `type` discriminator
    // field on each step is mandatory, otherwise the API throws InvalidTypeIdException.
    const workout = {
      workoutName: name,
      description: notes || description || '',
      sportType,
      estimatedDurationInSecs: durationSec,
      estimatedDistanceInMeters: distanceMeters || 0,
      workoutSegments: [
        {
          segmentOrder: 1,
          sportType,
          workoutSteps: [
            {
              type: 'ExecutableStepDTO',          // ← required Jackson type discriminator
              stepOrder: 1,
              stepType:     { stepTypeId: 3, stepTypeKey: 'interval' },
              endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
              endConditionValue: durationSec,
              targetType:   { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
            },
          ],
        },
      ],
    };

    const result = await client.addWorkout(workout);
    return res.status(200).json({ ok: true, workoutId: result?.workoutId });
  } catch (e) {
    console.error('Garmin push error:', e);
    return res.status(500).json({ error: e?.message || 'Garmin push mislukt' });
  }
}

function mapSportType(type) {
  const map = {
    run:   { sportTypeId: 1, sportTypeKey: 'running' },
    bike:  { sportTypeId: 2, sportTypeKey: 'cycling' },
    swim:  { sportTypeId: 4, sportTypeKey: 'swimming' },
    str:   { sportTypeId: 5, sportTypeKey: 'strength_training' },
    other: { sportTypeId: 0, sportTypeKey: 'other' },
  };
  return map[type] || map.run;
}
