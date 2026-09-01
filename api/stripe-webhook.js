import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Smarter Way to Shop — Stripe webhook. Writes to the SAME profiles.smarter_way_to_shop_addon /
// stripe_sws_subscription_id columns that Smart Kitchen's own webhook manages -- this is
// intentional and correct, not a repeat of the tier-column collision found in Smart Kitchen vs.
// Smart Cellar. There's only one real-world concept here ("does this user have the SWTS addon"),
// and it should read as true regardless of which app's checkout the user actually completed it
// through. Uses the same "check every subscription item, not just the first" pattern already
// proven necessary in Smart Kitchen's webhook.

const SWS_PRICE_IDS = [
  process.env.STRIPE_PRICE_SWS_ADDON_MONTHLY,
  process.env.STRIPE_PRICE_SWS_ADDON_ANNUAL,
  process.env.STRIPE_PRICE_SWS_STANDALONE_MONTHLY,
  process.env.STRIPE_PRICE_SWS_STANDALONE_ANNUAL,
].filter(Boolean);

export const config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.VITE_SUPABASE_URL || 'https://wnlqvmedocpgjawmwivd.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let event;
  try {
    const buf = await buffer(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('SWTS webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const userId = obj.metadata?.supabase_user_id;
        if (!userId || !obj.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(obj.subscription);
        const hasSws = subscription.items.data.some(item => SWS_PRICE_IDS.includes(item.price?.id));
        if (hasSws) {
          await supabase.from('profiles').update({
            smarter_way_to_shop_addon: true,
            stripe_sws_subscription_id: obj.subscription,
          }).eq('id', userId);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const hadSws = (obj.items?.data || []).some(item => SWS_PRICE_IDS.includes(item.price?.id));
        if (hadSws) {
          await supabase.from('profiles')
            .update({ smarter_way_to_shop_addon: false, stripe_sws_subscription_id: null })
            .eq('stripe_sws_subscription_id', obj.id);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('SWTS webhook handling error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
}
