import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, email, password } = req.body;

  try {
    if (action === 'signup') {
      const { data, error } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true
      });
      if (error) throw error;
      return res.status(200).json({ user: data.user });
    }

    if (action === 'login') {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return res.status(200).json({ session: data.session, user: data.user });
    }

    if (action === 'google') {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: process.env.NEXT_PUBLIC_URL }
      });
      if (error) throw error;
      return res.status(200).json({ url: data.url });
    }

    if (action === 'profile') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'No token' });
      const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !user) return res.status(401).json({ error: 'Invalid token' });
      const { data: profile } = await supabase
        .from('profiles').select('*').eq('id', user.id).single();
      return res.status(200).json({ profile });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch(e) {
    return res.status(400).json({ error: e.message });
  }
}
