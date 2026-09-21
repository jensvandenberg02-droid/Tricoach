// api/ai-coach.js
// AI Coach endpoint — roept Anthropic API aan met app-context van de gebruiker
// Vereist: ANTHROPIC_API_KEY in Vercel environment variables

import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // snel + goedkoop voor chat

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd.' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd.' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Ongeldige sessie.' });

  const { messages, context, isBrief } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Geen berichten.' });

  // Bouw systeem-prompt op basis van app-context die de client meestuurt
  const { profile, events, injuries, health, recentActivities, weekReflections, currentWeekSessions } = context || {};

  const systemPrompt = buildSystemPrompt({ profile, events, injuries, health, recentActivities, weekReflections, currentWeekSessions, isBrief });
  const maxTokens = isBrief ? 2048 : 1200;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Anthropic fout: ${err}` });
    }

    const data = await response.json();
    const rawReply = data.content?.[0]?.text || '';

    // Parseer [PLAN_EDIT]{...}[/PLAN_EDIT] marker uit het antwoord
    let planEdit = null;
    let reply = rawReply;
    const planEditMatch = rawReply.match(/\[PLAN_EDIT\]([\s\S]*?)\[\/PLAN_EDIT\]/);
    if (planEditMatch) {
      try {
        planEdit = JSON.parse(planEditMatch[1].trim());
      } catch(e) { /* ongeldige JSON, negeer */ }
      // Verwijder de marker uit het antwoord dat de gebruiker ziet
      reply = rawReply.replace(/\s*\[PLAN_EDIT\][\s\S]*?\[\/PLAN_EDIT\]\s*/g, '').trim();
    }

    return res.json({ ok: true, reply, planEdit });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function buildSystemPrompt({ profile, events, injuries, health, recentActivities, weekReflections, currentWeekSessions, isBrief }) {
  const p = profile || {};
  const now = new Date().toISOString().slice(0, 10);

  // Alleen aankomende events (datum >= vandaag), gesorteerd
  const futureEvents = (events || [])
    .filter(e => e.date >= now)
    .sort((a, b) => a.date.localeCompare(b.date));
  const evtLines = futureEvents.map(e =>
    `  - ${e.name} (${e.type}) op ${e.date}, prioriteit ${e.priority || '?'}${e.goal_time ? `, streeftijd ${e.goal_time}` : ''}`
  ).join('\n') || '  Geen aankomende events.';

  // Actieve blessures/condities
  const injLines = (injuries || []).filter(i => !i.end_date || i.end_date >= now).map(i =>
    `  - ${i.category || 'injury'}: ${i.body_part || ''} — ${i.notes || ''} (vanaf ${i.start_date})`
  ).join('\n') || '  Geen actieve blessures.';

  // Gezondheidsdata — per metriek de meest recente niet-null waarde
  const hArr = health || [];
  const latestH = (field) => hArr.find(h => h[field] != null);
  const hrv         = latestH('hrv')?.hrv ?? '?';
  const sleepHours  = latestH('sleep_hours')?.sleep_hours ?? '?';
  const sleepScore  = latestH('sleep_score')?.sleep_score ?? '?';
  const bodyBattery = latestH('body_battery')?.body_battery ?? '?';
  const steps       = latestH('steps')?.steps ?? '?';
  const healthStr = hArr.length
    ? `HRV: ${hrv}, Slaap: ${sleepHours}u (score ${sleepScore}), Body battery: ${bodyBattery}, Stappen: ${steps}`
    : 'Geen gezondheidsdata beschikbaar.';

  // Recente activiteiten (Strava gebruikt start_date en moving_time)
  const actLines = (recentActivities || []).slice(0, 10).map(a => {
    const date = (a.start_date || a.date || '').slice(0, 10);
    const km   = a.distance ? (a.distance / 1000).toFixed(1) + ' km' : '';
    const dur  = (a.moving_time || a.duration) ? Math.round((a.moving_time || a.duration) / 60) + 'min' : '';
    return `  - ${date} ${a.sport_type || a.type || ''} "${a.name}" ${km} ${dur}`;
  }).join('\n') || '  Geen recente activiteiten.';

  // Laatste weekreflectie
  const ref = (weekReflections || [])[0];
  const refStr = ref
    ? `RPE ${ref.rpe}/10, energie ${ref.energy}/5, motivatie ${ref.motivation}/5, herstel: ${ref.recovery || '?'}. Notities: ${ref.notes || '—'}`
    : 'Geen weekreflectie beschikbaar.';

  // Huidige week sessies — bewaar de exacte dagcodes voor gebruik in PLAN_EDIT
  const sessLines = (currentWeekSessions || []).map(s =>
    `  - ${s.day} [dagcode="${s.day}"]: [${s.type}] ${s.desc}${s.meta ? ' · ' + s.meta : ''}`
  ).join('\n') || '  Geen huidige week sessies beschikbaar.';

  return `Je bent een persoonlijke triathloncoach in de TriCoach app. Je geeft advies op maat op basis van de data van de atleet. Je antwoordt altijd in het Nederlands, bondig en concreet. Je bent warm maar direct — geen onnodige uitweidingen.

== ATLEET PROFIEL ==
Naam: ${p.display_name || 'Onbekend'}
FTP: ${p.ftp || '?'} W | Gewicht: ${p.weight_kg || '?'} kg | W/kg: ${p.ftp && p.weight_kg ? (p.ftp/p.weight_kg).toFixed(2) : '?'}
Max HR: ${p.max_hr || '?'} | Rust HR: ${p.rest_hr || '?'}
VO2max: ${p.vo2max || '?'}
Looppace (Z2): ${p.run_pace || '?'} /km | Zwem CSS: ${p.swim_css || '?'} /100m

== AANKOMENDE EVENTS ==
${evtLines}

== ACTIEVE BLESSURES / CONDITIES ==
${injLines}

== LAATSTE GEZONDHEIDSDATA ==
${healthStr}

== RECENTE ACTIVITEITEN ==
${actLines}

== LAATSTE WEEKREFLECTIE ==
${refStr}

== HUIDIGE WEEK TRAININGSPLAN ==
${sessLines}

== INSTRUCTIES ==
- Gebruik bovenstaande data als basis voor je antwoorden.
- Bij vragen over training, voeding, herstel of tactiek: geef specifiek advies op basis van de atleetdata.
- Als je iets niet weet of data ontbreekt, zeg dat eerlijk.
${isBrief
  ? `- Dit is een dagelijkse welkomstbrief. Schrijf een uitgebreide, persoonlijke brief (minimaal 400 woorden). Bespreek: de sessie van vandaag en waarom die past in het grotere plaatje, concrete uitvoeringstips, hoe het aansluit op recent herstel en gezondheidsdata, en een motiverende afsluiting. Gebruik alinea's, geen opsommingen.`
  : `- Houd antwoorden onder 300 woorden tenzij de vraag meer detail vereist.\n- Gebruik geen opsommingen tenzij echt nodig.`}
- Vandaag is het ${now}.

== PLAN AANPASSEN ==
Als de gebruiker vraagt om het trainingsplan te wijzigen (bijv. een sessie te verwijderen, te vervangen of te verlichten), MOET je een [PLAN_EDIT] blok toevoegen aan je antwoord. Dit wordt verborgen voor de gebruiker maar door de app verwerkt.

Formaat:
[PLAN_EDIT]
{
  "weekOffset": 0,
  "changes": {
    "Ma": { "remove": true },
    "Wo": { "replace": { "type": "run", "icon": "🏃", "desc": "Korte herstelloop 30 min Z1", "meta": "Z1 · ❤️ 93-111 bpm" } }
  }
}
[/PLAN_EDIT]

Regels:
- weekOffset: 0 = huidige week, 1 = volgende week (gebruik bijna altijd 0)
- Gebruik de EXACTE dagcode uit "HUIDIGE WEEK TRAININGSPLAN" hierboven (bijv. "Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo")
- Bij verwijdering/weghalen van een sessie: { "remove": true } — dag wordt omgezet naar rust
- Bij vervanging/aanpassen van een sessie: { "replace": { "type": "run|bike|swim|str|rest", "icon": "🏃|🚴|🏊|💪|🛌", "desc": "...", "meta": "..." } }
- Pas ALLEEN de sessies aan die de gebruiker expliciet wil wijzigen
- Leg in je antwoord kort uit wat je hebt aangepast en waarom
- Gebruik het [PLAN_EDIT] blok ALLEEN als er echt een aanpassing nodig is`;
}
