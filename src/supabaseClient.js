// Smarter Way to Shop — Supabase Client
// Shared Supabase project as Smart Kitchen and Smart Cellar (same project, separate tables/columns via RLS)
// RG Digital Labs, LLC · September 2026

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

// -- localStorage key prefix: sws_ (Smarter Way to Shop) --------------------
// Smart Kitchen uses sk_, Smart Cellar uses sc_ — must not collide in shared
// browser storage if a user has more than one of these apps open.
export const SWS_KEYS = {
  darkMode:      'sws_darkMode',
  shoppingList:  'sws_shoppingList',   // the user's current list
  preferredKeys: 'sws_preferredCache', // lightweight local cache, not the source of truth
}

// -- User profile -------------------------------------------------------------
// Deliberately selects tier/subscription_status too (read-only here) so this
// app can tell whether the user already has an active Smart Kitchen subscription
// and offer the $5 suite-member rate instead of the $10 standalone rate --
// without ever writing back to Smart Kitchen's own columns.
export async function getUserProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('id, email, full_name, tier, subscription_status, sws_trial_ends_at, smarter_way_to_shop_addon, stripe_sws_subscription_id')
    .eq('id', userId)
    .single()
  return data
}

// -- Trial helpers (SWTS-specific column, never touches Smart Kitchen's trial_ends_at) --
export function trialDaysRemaining(trialEndsAt) {
  if (!trialEndsAt) return 0
  const diff = new Date(trialEndsAt) - new Date()
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
}

export async function setSwsTrialStartDate(userId) {
  const trialEnd = new Date()
  trialEnd.setDate(trialEnd.getDate() + 30)
  await supabase
    .from('profiles')
    .update({ sws_trial_ends_at: trialEnd.toISOString() })
    .eq('id', userId)
}

// -- Whether the user already has an active Smart Kitchen subscription --------
// Read-only check against the shared tier column, used only to decide which
// Stripe price to offer -- this app never writes to `tier`.
const SMART_KITCHEN_PAID_TIERS = ['solo', 'couple', 'family', 'medical']
export function hasActiveSmartKitchenTier(profile) {
  return !!profile && SMART_KITCHEN_PAID_TIERS.includes(profile.tier) && profile.subscription_status === 'active'
}
