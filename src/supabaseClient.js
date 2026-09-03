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

// -- Push this list into Smart Kitchen's shared shopping list -----------------
// Unlike the read-only helpers above, this IS a deliberate write into Smart
// Kitchen's own data -- the person explicitly asked for one comprehensive list
// regardless of which app they build it in. Always merges into whatever's
// already on the Smart Kitchen list (never overwrites), and dedupes using the
// same word-boundary + plural-tolerant matcher Smart Kitchen itself uses, so
// adding "Bacon" here doesn't create a redundant line next to an existing
// "Wright Brand Bacon" entry. No changes needed on the Smart Kitchen side --
// its own cloud-sync already treats "another writer grew the array" as a safe,
// trustworthy update, since that's exactly the array-length-changed case its
// automatic load path is built to catch.
function normalizeWordsForDedup(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w)
}
function alreadyOnList(name, existingItems) {
  const words = normalizeWordsForDedup(name)
  if (!words.length) return false
  return existingItems.some(item => {
    const itemWords = normalizeWordsForDedup(item.name)
    if (!itemWords.length) return false
    const shorter = words.length <= itemWords.length ? words : itemWords
    const longer = words.length <= itemWords.length ? itemWords : words
    return shorter.every(w => longer.includes(w))
  })
}
export async function sendShoppingListToSmartKitchen(userId, swtsItems) {
  // Only unchecked items -- a checked item in SWTS means it's already been
  // decided/acquired, not something still needed on another list.
  const toSend = (swtsItems || []).filter(i => !i.checked && (i.name || '').trim())
  if (toSend.length === 0) return { sent: 0, skipped: 0 }

  const { data, error } = await supabase
    .from('user_data')
    .select('shopping_list')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error

  const existing = data?.shopping_list || []
  const additions = []
  let skipped = 0
  for (const item of toSend) {
    if (alreadyOnList(item.name, existing) || alreadyOnList(item.name, additions)) {
      skipped++
      continue
    }
    additions.push({
      name: item.name.trim(),
      qty: 1,
      unit: '',
      category: 'Pantry',
      checked: false,
      source: 'Smarter Way to Shop',
    })
  }

  if (additions.length > 0) {
    const { error: writeError } = await supabase
      .from('user_data')
      .upsert(
        { user_id: userId, shopping_list: [...existing, ...additions], updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
    if (writeError) throw writeError
  }

  return { sent: additions.length, skipped }
}
