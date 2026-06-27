import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = `You are EarningsEdge, an elite institutional earnings call analyst.
Every analytical claim MUST be supported by a direct verbatim quote from the transcript.
Format quotes as: "exact words spoken". Never assert anything without a quote.
Respond ONLY with valid raw JSON — no markdown, no backticks.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Auth check
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Please log in to run an analysis.' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Session expired. Please log in again.' });

  // Credits check
  const { data: profile } = await supabase
    .from('profiles').select('credits').eq('id', user.id).single();
  const credits = profile?.credits ?? 0;

  if (credits <= 0) {
    return res.status(402).json({ error: 'no_credits', credits: 0 });
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request.' });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages
    });

    const raw = response.content
      .filter(b => b.type === 'text').map(b => b.text).join('')
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(raw);

    // Deduct 1 credit
    const newCredits = credits - 1;
    await supabase.from('profiles').update({ credits: newCredits }).eq('id', user.id);

    return res.status(200).json({ result: parsed, credits: newCredits });
  } catch(e) {
    console.error('Analysis error:', e);
    return res.status(500).json({ error: e.message });
  }
}
