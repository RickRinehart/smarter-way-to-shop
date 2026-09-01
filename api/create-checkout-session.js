import Stripe from 'stripe';

// Smarter Way to Shop — checkout session. Much simpler than Smart Kitchen's version: no base
// tiers, no add-ons layered on top of a plan — just one of four price keys, resolved to the
// matching Stripe Price ID. The suite-member vs. standalone decision was already made client-side
// (SubscriptionModal checks profiles.tier read-only before this is ever called); this endpoint
// just creates the checkout session for whichever price was actually selected.

const PRICE_MAP = {
  sws_addon_monthly:        process.env.STRIPE_PRICE_SWS_ADDON_MONTHLY,
  sws_addon_annual:         process.env.STRIPE_PRICE_SWS_ADDON_ANNUAL,
  sws_standalone_monthly:   process.env.STRIPE_PRICE_SWS_STANDALONE_MONTHLY,
  sws_standalone_annual:    process.env.STRIPE_PRICE_SWS_STANDALONE_ANNUAL,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { userId, email, priceKey } = req.body;
  if (!userId || !priceKey) return res.status(400).json({ error: 'userId and priceKey required' });

  const priceId = PRICE_MAP[priceKey];
  if (!priceId) return res.status(400).json({ error: 'Unknown priceKey: ' + priceKey });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: { metadata: { supabase_user_id: userId, product: 'smarter_way_to_shop' } },
      metadata: { supabase_user_id: userId, product: 'smarter_way_to_shop' },
      success_url: (process.env.VITE_APP_URL || 'https://smarter-way-to-shop.vercel.app') + '/?subscribed=true',
      cancel_url: (process.env.VITE_APP_URL || 'https://smarter-way-to-shop.vercel.app') + '/',
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('SWTS checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
