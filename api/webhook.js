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

  console.log('Webhook event received:', event.type);

  // ── Payment completed — activate plan ──────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.user_id;
    const plan = session.metadata?.plan || 'starter';

    console.log('checkout.session.completed — userId:', userId, 'plan:', plan);

    if (!userId) {
      console.error('No user_id in metadata');
      return res.status(400).json({ error: 'No user_id in metadata' });
    }

    const credits = plan === 'pro' ? 999999 : 20;

    const { error } = await supabase.from('profiles').update({
      plan,
      credits,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      plan_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }).eq('id', userId);

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('Profile updated — plan:', plan, 'credits:', credits);

    // Log the purchase
    await supabase.from('purchases').insert({
      user_id: userId,
      stripe_session_id: session.id,
      credits_added: credits,
      amount_paid: session.amount_total
    }).catch(e => console.error('Purchase log error:', e));
  }

  // ── Monthly renewal — reset credits ────────────────────────────────────
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    // Only handle subscription renewals, not first payments
    if (invoice.billing_reason !== 'subscription_cycle') {
      return res.status(200).json({ received: true });
    }

    const { data: profile } = await supabase
      .from('profiles').select('plan, id').eq('stripe_customer_id', customerId).single();

    if (profile && profile.plan !== 'free') {
      const credits = profile.plan === 'pro' ? 999999 : 20;
      await supabase.from('profiles').update({
        credits,
        plan_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }).eq('id', profile.id);
      console.log('Monthly renewal — credits reset for plan:', profile.plan);
    }
  }

  // ── Subscription cancelled — downgrade to free ─────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    await supabase.from('profiles').update({
      plan: 'free',
      credits: 0,
      stripe_subscription_id: null
    }).eq('stripe_customer_id', customerId);

    console.log('Subscription cancelled — downgraded to free');
  }

  return res.status(200).json({ received: true });
}
