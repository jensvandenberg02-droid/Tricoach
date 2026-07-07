// api/strava-callback.js
// Vercel Serverless Function — handelt de Strava OAuth callback af
// Maakt een Supabase-gebruiker aan (of logt bestaande in), slaat tokens op
// en stuurt de gebruiker terug naar de app via een magic-link sessie.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

  if (error) {
    console.error('Strava OAuth error:', error, error_description);
    return res.redirect(`${SITE_URL}/?error=strava_denied`);
  }
  if (!code) {
    return res.redirect(`${SITE_URL}/?error=no_code`);
  }

  // 1. Wissel code in voor Strava token
  let stravaData;
  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
      }),
    });
    stravaData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Strava token error:', stravaData);
      return res.redirect(`${SITE_URL}/?error=strava_token`);
    }
  } catch (e) {
    console.error('Strava fetch error:', e);
    return res.redirect(`${SITE_URL}/?error=strava_fetch`);
  }

  const { access_token, refresh_token, expires_at, athlete } = stravaData;
  const syntheticEmail = `strava_${athlete.id}@tricoach.app`;

  // 2. Supabase admin client
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 3. Kijk of profiel al bestaat
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('strava_athlete_id', athlete.id)
    .maybeSingle();

  let userId;

  if (existingProfile) {
    // Bestaande gebruiker — update tokens
    userId = existingProfile.id;
    await supabase.from('profiles').update({
      strava_access_token:     access_token,
      strava_refresh_token:    refresh_token,
      strava_token_expires_at: expires_at,
      display_name: `${athlete.firstname} ${athlete.lastname}`,
      avatar_url:   athlete.profile_medium || athlete.profile,
      updated_at:   new Date().toISOString(),
    }).eq('id', userId);
    console.log(`Returning user logged in: ${userId}`);
  } else {
    // Nieuwe gebruiker aanmaken
    const { data: authUser, error: createErr } = await supabase.auth.admin.createUser({
      email:          syntheticEmail,
      email_confirm:  true,
      user_metadata: {
        strava_athlete_id: athlete.id,
        display_name:      `${athlete.firstname} ${athlete.lastname}`,
        avatar_url:        athlete.profile_medium || athlete.profile,
      },
    });

    if (createErr) {
      // Misschien bestaat de auth user al maar niet het profiel
      const { data: existingAuth } = await supabase.auth.admin.listUsers();
      const found = existingAuth?.users?.find(u => u.email === syntheticEmail);
      if (found) {
        userId = found.id;
      } else {
        console.error('Create user error:', createErr);
        return res.redirect(`${SITE_URL}/?error=create_user`);
      }
    } else {
      userId = authUser.user.id;
    }

    // Maak profiel aan
    await supabase.from('profiles').upsert({
      id:                      userId,
      strava_athlete_id:       athlete.id,
      display_name:            `${athlete.firstname} ${athlete.lastname}`,
      avatar_url:              athlete.profile_medium || athlete.profile,
      strava_access_token:     access_token,
      strava_refresh_token:    refresh_token,
      strava_token_expires_at: expires_at,
    });
    console.log(`New user created: ${userId}`);
  }

  // 4. Genereer een magic link zodat de browser een echte sessie krijgt
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type:    'magiclink',
    email:   syntheticEmail,
    options: { redirectTo: SITE_URL },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error('Magic link error:', linkErr);
    return res.redirect(`${SITE_URL}/?error=session`);
  }

  // Redirect naar de Supabase magic link — die logt de gebruiker automatisch in
  // en stuurt hen terug naar SITE_URL
  return res.redirect(linkData.properties.action_link);
}
