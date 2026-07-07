// api/garmin-push.js
// Vercel Serverless Function — pusht een workout naar Garmin Connect
// Gebruikt de garmin-connect npm package (unofficiële API, email+wachtwoord)
//
// garminSteps format (gestuurd vanuit de client):
//   { kind: 'warmup'|'cooldown'|'interval'|'recovery'|'rest', dist?: meters, secs?: seconds, desc?: string }
//   { kind: 'repeat', sets: number, steps: [...] }

import { GarminConnect } from 'garmin-connect';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('garmin_email, garmin_password')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile?.garmin_email) {
    return res.status(400).json({ error: 'Geen Garmin credentials gevonden. Vul die in via Profiel.' });
  }

  const { name, description, type, durationSeconds, distanceMeters, notes, garminSteps } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const client = new GarminConnect({ username: profile.garmin_email, password: profile.garmin_password });
    await client.login();

    const sportType = mapSportType(type || 'run');
    const builtSteps = garminSteps?.length
      ? buildFromSteps(garminSteps)
      : buildSimple(durationSeconds || 3600);

    const estimatedSecs = durationSeconds
      || estimateDurationFromSteps(garminSteps)
      || 3600;

    const workout = {
      workoutName: name,
      description: notes || description || '',
      sportType,
      estimatedDurationInSecs: estimatedSecs,
      estimatedDistanceInMeters: distanceMeters || estimateDistFromSteps(garminSteps) || 0,
      workoutSegments: [{
        segmentOrder: 1,
        sportType,
        workoutSteps: builtSteps,
      }],
    };

    const result = await client.addWorkout(workout);
    return res.status(200).json({ ok: true, workoutId: result?.workoutId });
  } catch (e) {
    console.error('Garmin push error:', e);
    return res.status(500).json({ error: e?.message || 'Garmin push mislukt' });
  }
}

// ── Step builders ─────────────────────────────────────────────────────────────

// Recursieve builder: zet onze eigen step-objecten om naar Garmin API formaat.
// Garmin gebruikt Jackson polymorphic deserialization — het `type` veld op elk
// object is verplicht, anders gooit de API InvalidTypeIdException.
function buildFromSteps(steps) {
  let order = 0;
  return steps.map(step => toGarminStep(step, ++order));
}

function toGarminStep(step, stepOrder) {
  // Repeat-blok → RepeatGroupDTO
  if (step.kind === 'repeat') {
    let innerOrder = 0;
    return {
      type: 'RepeatGroupDTO',
      stepOrder,
      stepType: { stepTypeId: 6, stepTypeKey: 'repeat' },
      numberOfIterations: step.sets,
      smartRepeat: false,
      workoutSteps: step.steps.map(s => toGarminStep(s, ++innerOrder)),
    };
  }

  // Uitvoerbare stap → ExecutableStepDTO
  const stepTypeMap = {
    warmup:   { stepTypeId: 1, stepTypeKey: 'warmup' },
    cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown' },
    interval: { stepTypeId: 3, stepTypeKey: 'interval' },
    recovery: { stepTypeId: 4, stepTypeKey: 'recovery' },
    rest:     { stepTypeId: 5, stepTypeKey: 'rest' },
  };

  // Eindconditie: afstand in meters heeft voorrang boven tijd in seconden
  const endCondition = step.dist != null
    ? { conditionTypeId: 3, conditionTypeKey: 'distance' }
    : { conditionTypeId: 2, conditionTypeKey: 'time' };
  const endConditionValue = step.dist ?? step.secs;

  return {
    type: 'ExecutableStepDTO',
    stepOrder,
    stepType: stepTypeMap[step.kind] || stepTypeMap.interval,
    description: step.desc || '',
    endCondition,
    endConditionValue,
    targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
  };
}

// Enkelvoudige stap als er geen garminSteps zijn (fallback)
function buildSimple(durationSec) {
  return [{
    type: 'ExecutableStepDTO',
    stepOrder: 1,
    stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
    endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
    endConditionValue: durationSec,
    targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
  }];
}

// ── Duur- en afstandsschattingen ─────────────────────────────────────────────

function estimateDurationFromSteps(steps) {
  if (!steps?.length) return null;
  let total = 0;
  for (const step of steps) {
    if (step.kind === 'repeat') {
      const innerSecs = step.steps.reduce((s, st) => s + (st.secs || 0), 0);
      total += step.sets * innerSecs;
    } else if (step.secs) {
      total += step.secs;
    }
  }
  return total || null;
}

function estimateDistFromSteps(steps) {
  if (!steps?.length) return null;
  let total = 0;
  for (const step of steps) {
    if (step.kind === 'repeat') {
      const innerDist = step.steps.reduce((s, st) => s + (st.dist || 0), 0);
      total += step.sets * innerDist;
    } else if (step.dist) {
      total += step.dist;
    }
  }
  return total || null;
}

// ── Sport type mapping ────────────────────────────────────────────────────────

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
