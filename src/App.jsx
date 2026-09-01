// Smarter Way to Shop — Main App
// RG Digital Labs, LLC · September 2026
//
// Reuses three pieces of logic already proven in Smart Kitchen's own SWTS integration,
// ported here rather than re-invented: the conservative fuzzy item-name matcher, the
// unit-normalization logic (so a price like "$9.95 for a 5lb bag" compares fairly against
// a per-lb list item), and the "read a handwritten list photo" extraction prompt (Smart
// Kitchen's proven Weekly/List Scanner). None of these were tied to Smart Kitchen's
// inventory system underneath -- they only ever compared free-text names -- so they work
// unchanged against a plain shopping-list item instead of an inventory item.

import React, { useState, useEffect, useCallback } from 'react'
import { supabase, SWS_KEYS } from './supabaseClient'

const TEAL = '#0F8A7A'
const GOLD = '#C8963E'
const C = { bg: '#0a0f14', card: '#0f1720', surface: '#16202b', border: '#233240', text: '#e8edf2', muted: '#8a99a8' }
const FB = "'DM Sans', sans-serif"
const FM = "monospace"
const FD = "'Cormorant Garamond', serif"

// ── Ported matching logic (kept behaviorally identical to Smart Kitchen's) ──
function matchItemToAd(listItemName, adItemName) {
  const s = (adItemName || "").toLowerCase().trim()
  const inv = (listItemName || "").toLowerCase().trim()
  if (!s || !inv || inv.length < 3) return false
  if (s.includes(" or ") || (s.match(/,/g) || []).length > 1) return false
  return s.includes(inv) || inv.includes(s)
}
function parseQuantity(text) {
  if (!text) return null
  const t = text.toLowerCase().trim()
  let m
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*lb/))) return { qty: parseFloat(m[1]), family: "lb" }
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*oz/))) return { qty: parseFloat(m[1]) / 16, family: "lb" }
  if (/^lb\.?s?$/.test(t)) return { qty: 1, family: "lb" }
  if (/^oz\.?$/.test(t)) return { qty: 1 / 16, family: "lb" }
  if (/^each$|^ea\.?$/.test(t)) return { qty: 1, family: "each" }
  return null
}
function normalizeAdPrice(adPrice, adUnitSize) {
  if (adPrice == null) return null
  const q = parseQuantity(adUnitSize)
  if (!q || !q.qty) return null
  return +(adPrice / q.qty).toFixed(2)
}

// ── Minimal Claude call, this app's own dedicated key (never Smart Kitchen's) ──
async function callClaude({ system, prompt, imageBase64, imageType, maxTokens = 4000, timeoutMs = 120000 }) {
  const content = []
  if (imageBase64) content.push({ type: "image", source: { type: "base64", media_type: imageType || "image/jpeg", data: imageBase64 } })
  content.push({ type: "text", text: prompt })
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": import.meta.env?.VITE_ANTHROPIC_KEY || "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error("Claude API error " + res.status)
  const data = await res.json()
  return (data.content || []).map(b => b.text || "").join("")
}

function fileToBase64(f) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result.split(",")[1])
    r.onerror = rej
    r.readAsDataURL(f)
  })
}

export default function App({ user, isActive, isSuiteMember, statusLabel, onUpgrade, onAuthAction }) {
  const [view, setView] = useState('list') // 'list' | 'browse' | 'onboarding'
  const [allStores, setAllStores] = useState([])
  const [preferredStoreIds, setPreferredStoreIds] = useState([])
  const [shoppingList, setShoppingList] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SWS_KEYS.shoppingList) || "[]") } catch { return [] }
  })
  const [newItemText, setNewItemText] = useState("")
  const [matches, setMatches] = useState(null)
  const [checkingPrices, setCheckingPrices] = useState(false)
  const [browseAds, setBrowseAds] = useState([])
  const [browsingLoading, setBrowsingLoading] = useState(false)
  const [scanning, setScanning] = useState(false)

  useEffect(() => { localStorage.setItem(SWS_KEYS.shoppingList, JSON.stringify(shoppingList)) }, [shoppingList])

  const loadStores = useCallback(async () => {
    const { data: stores } = await supabase.from('partner_stores').select('id,name').order('name')
    if (stores) setAllStores(stores)
    if (user?.id) {
      const { data: prefs } = await supabase.from('user_preferred_markets').select('partner_store_id').eq('user_id', user.id)
      const ids = (prefs || []).map(p => p.partner_store_id)
      setPreferredStoreIds(ids)
      if (ids.length === 0) setView('onboarding')
    }
  }, [user])

  useEffect(() => { if (user?.id && isActive) loadStores() }, [user, isActive, loadStores])

  async function toggleStore(storeId) {
    if (preferredStoreIds.includes(storeId)) {
      await supabase.from('user_preferred_markets').delete().eq('user_id', user.id).eq('partner_store_id', storeId)
      setPreferredStoreIds(prev => prev.filter(id => id !== storeId))
    } else {
      await supabase.from('user_preferred_markets').insert({ user_id: user.id, partner_store_id: storeId })
      setPreferredStoreIds(prev => [...prev, storeId])
    }
  }

  function addItem() {
    const name = newItemText.trim()
    if (!name) return
    setShoppingList(prev => [...prev, { id: Date.now() + Math.random(), name, checked: false }])
    setNewItemText("")
  }
  function removeItem(id) { setShoppingList(prev => prev.filter(i => i.id !== id)) }
  function toggleChecked(id) { setShoppingList(prev => prev.map(i => i.id === id ? { ...i, checked: !i.checked } : i)) }

  async function scanListPhoto(file) {
    setScanning(true)
    try {
      const b64 = await fileToBase64(file)
      const raw = await callClaude({
        system: "You are reading a handwritten or typed shopping list photo. Extract every item written down, even if handwriting is messy or words are misspelled — use your best judgment to identify the intended grocery item. Return ONLY a valid JSON array of strings, one per item, cleaned up and correctly spelled. Include every item you can identify.",
        prompt: "Read this shopping list photo and extract every item written on it.",
        imageBase64: b64, imageType: file.type || "image/jpeg",
      })
      const s = raw.indexOf("["), e = raw.lastIndexOf("]")
      if (s === -1) throw new Error("Could not read the list")
      const items = JSON.parse(raw.slice(s, e + 1))
      setShoppingList(prev => [...prev, ...items.map(name => ({ id: Date.now() + Math.random(), name, checked: false }))])
    } catch (err) {
      alert("Couldn't read that photo: " + err.message + " — you can add items manually instead.")
    }
    setScanning(false)
  }

  async function checkBestPrices() {
    if (shoppingList.length === 0 || preferredStoreIds.length === 0) return
    setCheckingPrices(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const { data: ads } = await supabase
        .from('partner_ads')
        .select('item_name, regular_price, card_price, mix_match_price, unit_size, partner_stores(name)')
        .in('partner_store_id', preferredStoreIds)
        .or(`sale_start.is.null,sale_start.lte.${today}`)
        .or(`sale_end.is.null,sale_end.gte.${today}`)

      const results = shoppingList.map(item => {
        const found = []
        for (const ad of ads || []) {
          if (!matchItemToAd(item.name, ad.item_name)) continue
          const raw = ad.card_price ?? ad.mix_match_price ?? ad.regular_price
          if (raw == null) continue
          const normalized = normalizeAdPrice(raw, ad.unit_size)
          found.push({ storeName: ad.partner_stores?.name || "Unknown", adItemName: ad.item_name, price: normalized ?? raw, needsUnitCheck: normalized == null, unitSize: ad.unit_size })
        }
        found.sort((a, b) => a.price - b.price)
        return { listItem: item.name, options: found }
      })
      setMatches(results)
    } catch (err) {
      alert("Couldn't check prices: " + err.message)
    }
    setCheckingPrices(false)
  }

  async function loadBrowseDeals() {
    setBrowsingLoading(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const { data: ads } = await supabase
        .from('partner_ads')
        .select('item_name, regular_price, card_price, mix_match_price, unit_size, department, partner_stores(name)')
        .in('partner_store_id', preferredStoreIds)
        .or(`sale_start.is.null,sale_start.lte.${today}`)
        .or(`sale_end.is.null,sale_end.gte.${today}`)
        .order('item_name')
      setBrowseAds(ads || [])
    } catch { setBrowseAds([]) }
    setBrowsingLoading(false)
  }
  useEffect(() => { if (view === 'browse' && preferredStoreIds.length > 0) loadBrowseDeals() }, [view, preferredStoreIds])

  function addFromBrowse(itemName) {
    setShoppingList(prev => [...prev, { id: Date.now() + Math.random(), name: itemName, checked: false }])
  }

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: FB }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🛒</div>
        <div style={{ fontFamily: FD, fontSize: 30, color: TEAL, marginBottom: 4 }}>Smarter Way to Shop</div>
        <div style={{ fontFamily: FM, fontSize: 13, color: C.muted, marginBottom: 28, textAlign: 'center', maxWidth: 360 }}>
          Build your shopping list, then see the best price for every item across your preferred stores.
        </div>
        <button onClick={onAuthAction} style={{ padding: '14px 32px', background: TEAL, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
          Get Started — 30 Days Free
        </button>
      </div>
    )
  }

  if (!isActive) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: FB }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🛒</div>
        <div style={{ fontFamily: FD, fontSize: 24, color: TEAL, marginBottom: 8 }}>Your trial has ended</div>
        <div style={{ fontFamily: FM, fontSize: 13, color: C.muted, marginBottom: 24, textAlign: 'center', maxWidth: 340 }}>
          Subscribe to keep comparing prices across your stores and building smarter shopping lists.
        </div>
        <button onClick={onUpgrade} style={{ padding: '14px 32px', background: TEAL, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
          Choose a Plan
        </button>
      </div>
    )
  }

  if (view === 'onboarding') {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, padding: 24, fontFamily: FB }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ fontFamily: FD, fontSize: 24, color: TEAL, marginBottom: 8 }}>Which stores do you shop at?</div>
          <div style={{ fontFamily: FM, fontSize: 12, color: C.muted, marginBottom: 20 }}>Pick as many as apply — you can change this anytime.</div>
          {allStores.map(s => (
            <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: C.card, border: '1px solid ' + C.border, borderRadius: 10, marginBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={preferredStoreIds.includes(s.id)} onChange={() => toggleStore(s.id)} style={{ width: 18, height: 18, accentColor: TEAL }} />
              <span style={{ color: C.text, fontSize: 14 }}>{s.name}</span>
            </label>
          ))}
          <button onClick={() => setView('list')} disabled={preferredStoreIds.length === 0}
            style={{ width: '100%', marginTop: 16, padding: '12px', background: TEAL, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: preferredStoreIds.length === 0 ? 0.5 : 1 }}>
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: FB, color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid ' + C.border }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🛒</span>
          <span style={{ fontFamily: FD, fontSize: 18, color: TEAL, fontWeight: 700 }}>Smarter Way to Shop</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: FM, fontSize: 11, color: GOLD }}>{statusLabel}</span>
          <button onClick={() => setView('onboarding')} title="Manage stores" style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 8, color: C.muted, cursor: 'pointer', padding: '6px 10px', fontSize: 12 }}>Stores</button>
          <button onClick={onAuthAction} style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 8, color: C.muted, cursor: 'pointer', padding: '6px 10px', fontSize: 12 }}>Sign Out</button>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid ' + C.border }}>
        {[['list', '📝 My List'], ['browse', '🏷 Browse Deals']].map(([k, lb]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ flex: 1, padding: '12px', background: 'none', border: 'none', borderBottom: view === k ? '2px solid ' + TEAL : '2px solid transparent',
              color: view === k ? TEAL : C.muted, fontFamily: FB, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            {lb}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: 20 }}>
        {view === 'list' && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input value={newItemText} onChange={e => setNewItemText(e.target.value)} onKeyDown={e => e.key === 'Enter' && addItem()}
                placeholder="Add an item..." style={{ flex: 1, background: C.card, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 12px', color: C.text, fontSize: 14 }} />
              <button onClick={addItem} style={{ padding: '10px 16px', background: TEAL, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>+</button>
            </div>

            <label style={{ display: 'block', marginBottom: 16 }}>
              <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                onChange={e => e.target.files?.[0] && scanListPhoto(e.target.files[0])} />
              <div style={{ padding: '10px', textAlign: 'center', border: '1px dashed ' + C.border, borderRadius: 8, color: C.muted, fontSize: 13, cursor: 'pointer' }}>
                {scanning ? '⏳ Reading your list...' : '📷 Or photograph a handwritten list'}
              </div>
            </label>

            {shoppingList.length === 0 && <div style={{ textAlign: 'center', color: C.muted, fontSize: 13, padding: 20 }}>Your list is empty — add items above.</div>}

            {shoppingList.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: C.card, border: '1px solid ' + C.border, borderRadius: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={item.checked} onChange={() => toggleChecked(item.id)} style={{ accentColor: TEAL }} />
                <span style={{ flex: 1, fontSize: 14, textDecoration: item.checked ? 'line-through' : 'none', color: item.checked ? C.muted : C.text }}>{item.name}</span>
                <button onClick={() => removeItem(item.id)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
            ))}

            {shoppingList.length > 0 && (
              <button onClick={checkBestPrices} disabled={checkingPrices || preferredStoreIds.length === 0}
                style={{ width: '100%', marginTop: 14, padding: '12px', background: TEAL, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: checkingPrices ? 0.7 : 1 }}>
                {checkingPrices ? '⏳ Checking prices...' : '💰 Check Best Prices'}
              </button>
            )}

            {matches && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontFamily: FD, fontSize: 16, color: TEAL, marginBottom: 10 }}>Results</div>
                {matches.map((m, i) => (
                  <div key={i} style={{ background: C.card, border: '1px solid ' + C.border, borderRadius: 8, padding: 12, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: m.options.length ? 6 : 0 }}>{m.listItem}</div>
                    {m.options.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>No current match at your stores.</div>}
                    {m.options.map((o, j) => (
                      <div key={j} style={{ fontSize: 12, color: j === 0 ? '#22c55e' : C.muted, display: 'flex', justifyContent: 'space-between' }}>
                        <span>{o.storeName}{o.needsUnitCheck ? ' (check unit size)' : ''}</span>
                        <span>${o.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {view === 'browse' && (
          <>
            {browsingLoading && <div style={{ textAlign: 'center', color: C.muted, padding: 20 }}>Loading deals...</div>}
            {!browsingLoading && browseAds.length === 0 && <div style={{ textAlign: 'center', color: C.muted, padding: 20 }}>No active deals found at your stores right now.</div>}
            {browseAds.map((ad, i) => {
              const price = ad.card_price ?? ad.mix_match_price ?? ad.regular_price
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.card, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 12px', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 13, color: C.text }}>{ad.item_name}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{ad.partner_stores?.name} {price != null ? `· $${price.toFixed(2)}` : ''} {ad.unit_size ? `(${ad.unit_size})` : ''}</div>
                  </div>
                  <button onClick={() => addFromBrowse(ad.item_name)} style={{ background: TEAL, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>+ Add</button>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
