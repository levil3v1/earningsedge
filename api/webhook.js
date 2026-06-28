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
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const session = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const userId = session.metadata?.user_id;
    const plan = session.metadata?.plan || 'starter';
    if (!userId) return res.status(400).json({ error: 'No user_id' });

    const subscriptionId = session.subscription;
    const credits = plan === 'pro' ? 999999 : 20;

    await supabase.from('profiles').update({
      plan,
      credits,
      stripe_customer_id: session.customer,
      stripe_subscription_id: subscriptionId,
      plan_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }).eq('id', userId);
  }

  if (event.type === 'invoice.paid') {
    // Monthly renewal — only reset credits for paid plans, never for free
    const customerId = session.customer;
    const { data: profile } = await supabase
      .from('profiles').select('plan').eq('stripe_customer_id', customerId).single();
    if (profile && profile.plan !== 'free') {
      const credits = profile.plan === 'pro' ? 999999 : 20;
      await supabase.from('profiles').update({
        credits,
        plan_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }).eq('stripe_customer_id', customerId);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Subscription cancelled — downgrade to free
    const customerId = session.customer;
    await supabase.from('profiles').update({
      plan: 'free',
      credits: 0,
      stripe_subscription_id: null
    }).eq('stripe_customer_id', customerId);
  }

  return res.status(200).json({ received: true });
}
