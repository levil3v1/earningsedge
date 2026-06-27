import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.user_id;
    if (!userId) return res.status(400).json({ error: 'No user_id in metadata' });

    // Add 20 credits to user
    const { data: profile } = await supabase
      .from('profiles').select('credits').eq('id', userId).single();
    const newCredits = (profile?.credits || 0) + 20;
    await supabase.from('profiles').update({ credits: newCredits }).eq('id', userId);

    // Log the purchase
    await supabase.from('purchases').insert({
      user_id: userId,
      stripe_session_id: session.id,
      credits_added: 20,
      amount_paid: session.amount_total
    });
  }

  return res.status(200).json({ received: true });
}
