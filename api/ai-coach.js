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

  const { messages, context } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Geen berichten.' });

  // Bouw systeem-prompt op basis van app-context die de client meestuurt
  const { profile, events, injuries, health, recentActivities, weekReflections } = context || {};

  const systemPrompt = buildSystemPrompt({ profile, events, injuries, health, recentActivities, weekReflections });

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
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Anthropic fout: ${err}` });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || '';
    return res.json({ ok: true, reply });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function buildSystemPrompt({ profile, events, injuries, health, recentActivities, weekReflections }) {
  const p = profile || {};
  const now = new Date().toISOString().slice(0, 10);

  // Events samenvatting
  const evtLines = (events || []).map(e =>
    `  - ${e.name} (${e.type}) op ${e.date}, prioriteit ${e.priority || '?'}${e.goal_time ? `, streeftijd ${e.goal_time}` : ''}`
  ).join('\n') || '  Geen events ingepland.';

  // Actieve blessures/condities
  const injLines = (injuries || []).filter(i => !i.end_date || i.end_date >= now).map(i =>
    `  - ${i.category || 'injury'}: ${i.body_part || ''} — ${i.notes || ''} (vanaf ${i.start_date})`
  ).join('\n') || '  Geen actieve blessures.';

  // Laatste gezondheidsdata
  const h = (health || [])[0] || {};
  const healthStr = h.date
    ? `HRV: ${h.hrv ?? '?'}, Slaap: ${h.sleep_hours ?? '?'}u (score ${h.sleep_score ?? '?'}), Body battery: ${h.body_battery ?? '?'}, VO2max: ${h.vo2max ?? '?'} (${h.date})`
    : 'Geen gezondheidsdata beschikbaar.';

  // Recente activiteiten samenvatting (max 10)
  const actLines = (recentActivities || []).slice(0, 10).map(a => {
    const km = a.distance ? (a.distance / 1000).toFixed(1) + ' km' : '';
    return `  - ${a.date} ${a.type} ${a.name} ${km} ${a.duration ? Math.round(a.duration/60) + 'min' : ''}`;
  }).join('\n') || '  Geen recente activiteiten.';

  // Laatste weekreflectie
  const ref = (weekReflections || [])[0];
  const refStr = ref
    ? `RPE ${ref.rpe}/10, energie ${ref.energy}/5, motivatie ${ref.motivation}/5, herstel: ${ref.recovery || '?'}. Notities: ${ref.notes || '—'}`
    : 'Geen weekreflectie beschikbaar.';

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

== INSTRUCTIES ==
- Gebruik bovenstaande data als basis voor je antwoorden.
- Bij vragen over training, voeding, herstel of tactiek: geef specifiek advies op basis van de atleetdata.
- Als je iets niet weet of data ontbreekt, zeg dat eerlijk.
- Houd antwoorden onder 300 woorden tenzij de vraag meer detail vereist.
- Gebruik geen opsommingen tenzij echt nodig.
- Vandaag is het ${now}.`;
}
