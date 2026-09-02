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
import * as pdfjsLib from 'pdfjs-dist'

// Worker version must exactly match the imported pdfjs-dist version -- using
// pdfjsLib.version at runtime avoids hardcoding it in two places and having
// them drift apart after a future dependency bump.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`

export const THEMES = {
  dark: {
    bg: '#12182b', card: '#1A2344', surface: '#232d52', border: '#334073',
    text: '#f0ede4', muted: '#9aa5c7', teal: '#0F8A7A', gold: '#C8963E',
  },
  light: {
    bg: '#ffffff', card: '#ffffff', surface: '#F7EFDF', border: '#e2d9c3',
    text: '#1A2344', muted: '#5b6472', teal: '#0b6a5d', gold: '#8a6420',
  },
}
const FB = "'DM Sans', sans-serif"
const FM = "monospace"
const FD = "'Cormorant Garamond', serif"

// ── Ported matching logic (kept behaviorally identical to Smart Kitchen's) ──
// Normalizes common meat/product-form word variants that describe the same
// underlying cut/form (e.g. "tenderloins" vs "tenders") so the substring
// matcher below treats them as equivalent. This is deliberately a small,
// curated list rather than general stemming/fuzzy matching -- broadening it
// further risks the same false-positive problems fixed earlier (e.g. a
// "Patties" variant beating a canonical match). Add pairs here only when a
// real near-miss like this comes up, not preemptively.
function normalizeForMatch(text) {
  return text
    .replace(/tenderloins?\b/g, 'tenders')
    .replace(/breasts?\b/g, 'breast')
    .replace(/thighs?\b/g, 'thigh')
    .replace(/drumsticks?\b/g, 'drumstick')
    .replace(/patties\b/g, 'patty')
    .replace(/fillets?\b/g, 'fillet')
    .replace(/wings?\b/g, 'wing')
}
function matchItemToAd(listItemName, adItemName) {
  const s = normalizeForMatch((adItemName || "").toLowerCase().trim())
  const inv = normalizeForMatch((listItemName || "").toLowerCase().trim())
  if (!s || !inv || inv.length < 3) return false
  if (s.includes(" or ")) return false
  return s.includes(inv) || inv.includes(s)
}
function parseQuantity(text) {
  if (!text) return null
  const t = text.toLowerCase().trim()
  let m
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*lb/))) return { qty: parseFloat(m[1]), family: "lb" }
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*oz/))) return { qty: parseFloat(m[1]) / 16, family: "lb" }
  if (/^(lb\.?s?|pounds?)$/.test(t)) return { qty: 1, family: "lb" }
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
async function callClaude({ system, prompt, imageBase64, imageType, images, pdfBase64, maxTokens = 4000, timeoutMs = 120000 }) {
  const content = []
  if (imageBase64) content.push({ type: "image", source: { type: "base64", media_type: imageType || "image/jpeg", data: imageBase64 } })
  if (images) for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } })
  if (pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } })
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
  if (!res.ok) {
    let detail = ''
    try { const errBody = await res.json(); detail = errBody?.error?.message || JSON.stringify(errBody) } catch { detail = await res.text().catch(() => '') }
    throw new Error("Claude API error " + res.status + (detail ? ": " + detail : ""))
  }
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

// Claude's API caps images at 5MB base64-encoded and 2000px per dimension
// (platform.claude.com/docs/en/build-with-claude/vision). Phone photos of a
// flyer routinely exceed both, causing a 413 the browser often misreports as
// a CORS failure. Downscale + recompress via canvas until it fits, rather
// than sending the raw file and letting the API reject it.
function compressImageToLimit(file, maxDim = 2000, maxBase64Bytes = 4.5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)

      let quality = 0.9
      const tryEncode = () => {
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const base64 = dataUrl.split(',')[1]
        const approxBytes = base64.length * 0.75
        if (approxBytes <= maxBase64Bytes || quality <= 0.4) {
          URL.revokeObjectURL(url)
          resolve(base64)
        } else {
          quality -= 0.1
          tryEncode()
        }
      }
      tryEncode()
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')) }
    img.src = url
  })
}

// Renders each page of a PDF to a compressed JPEG, client-side, using
// pdf.js. This lets a large multi-page circular be processed as several
// smaller Claude requests instead of one huge request that risks hitting
// size/token/timeout limits. Returns an array of base64 JPEG strings, one
// per page, each already under the per-image size/dimension limits.
async function splitPdfIntoPageImages(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const maxPages = 60
  const pageCount = Math.min(pdf.numPages, maxPages)
  const pages = []
  for (let i = 1; i <= pageCount; i++) {
    onProgress?.(`Rendering page ${i} of ${pageCount}...`)
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(2000 / Math.max(viewport.width, viewport.height), 2)
    const scaledViewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = scaledViewport.width
    canvas.height = scaledViewport.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise

    let quality = 0.85
    let base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1]
    while (base64.length * 0.75 > 4.5 * 1024 * 1024 && quality > 0.4) {
      quality -= 0.1
      base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1]
    }
    pages.push(base64)
  }
  return { pages, truncatedPageCount: pdf.numPages > maxPages ? pdf.numPages : null }
}

export default function App({ user, isActive, isSuiteMember, isAdmin, statusLabel, onUpgrade, onAuthAction, theme, setTheme, largeText, setLargeText }) {
  const T = THEMES[theme]
  const scale = largeText ? 1.3 : 1
  const px = n => Math.round(n * scale)

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
  const [browseSearch, setBrowseSearch] = useState("")
  const [scanning, setScanning] = useState(false)

  // -- Admin: Ad Upload form state ------------------------------------------
  const emptyAdForm = {
    partner_store_id: '', item_name: '', canonical_key: '', department: '',
    regular_price: '', card_price: '', mix_match_price: '', compare_at_price: '',
    unit_size: '', sale_start: '', sale_end: '', notes: '',
  }
  const [adForm, setAdForm] = useState(emptyAdForm)
  const [adSubmitting, setAdSubmitting] = useState(false)
  const [adMessage, setAdMessage] = useState('')
  const [recentAds, setRecentAds] = useState([])
  const [flyerScanning, setFlyerScanning] = useState(false)
  const [flyerProgress, setFlyerProgress] = useState('')
  const [flyerStoreId, setFlyerStoreId] = useState('')
  const [flyerSaleStart, setFlyerSaleStart] = useState('')
  const [flyerSaleEnd, setFlyerSaleEnd] = useState('')
  const [parsedAds, setParsedAds] = useState(null) // array of editable rows, or null if none pending review
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [bulkMessage, setBulkMessage] = useState('')

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
        .select('item_name, regular_price, card_price, mix_match_price, unit_size, canonical_key, partner_store_id, partner_stores(name)')
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
          found.push({
            storeId: ad.partner_store_id,
            storeName: ad.partner_stores?.name || "Unknown",
            adItemName: ad.item_name,
            price: normalized ?? raw,
            needsUnitCheck: normalized == null,
            unitSize: ad.unit_size,
            hasCanonicalKey: ad.canonical_key != null,
          })
        }
        const canonicalStores = new Set(found.filter(o => o.hasCanonicalKey).map(o => o.storeId))
        const deduped = found.filter(o => o.hasCanonicalKey || !canonicalStores.has(o.storeId))
        deduped.sort((a, b) => a.price - b.price)
        return { listItem: item.name, options: deduped }
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

  // -- Admin: submit a new ad row. RLS enforces admin-only writes server-side
  // (see is_sws_admin() policy) -- this client-side isAdmin check only
  // controls whether the tab is shown, it isn't the real security boundary. --
  async function submitAd() {
    if (!adForm.partner_store_id || !adForm.item_name.trim()) {
      setAdMessage('Store and item name are required.')
      return
    }
    setAdSubmitting(true)
    setAdMessage('')
    const numOrNull = v => v === '' ? null : parseFloat(v)
    const payload = {
      partner_store_id: adForm.partner_store_id,
      item_name: adForm.item_name.trim(),
      canonical_key: adForm.canonical_key.trim() || null,
      department: adForm.department.trim() || null,
      regular_price: numOrNull(adForm.regular_price),
      card_price: numOrNull(adForm.card_price),
      mix_match_price: numOrNull(adForm.mix_match_price),
      compare_at_price: numOrNull(adForm.compare_at_price),
      unit_size: adForm.unit_size.trim() || null,
      sale_start: adForm.sale_start || null,
      sale_end: adForm.sale_end || null,
      notes: adForm.notes.trim() || null,
      source: 'manual',
      entered_by: user?.email || 'admin',
    }
    const { data, error } = await supabase.from('partner_ads').insert(payload).select().single()
    if (error) {
      setAdMessage('Error: ' + error.message)
    } else {
      const storeName = allStores.find(s => s.id === adForm.partner_store_id)?.name || ''
      setRecentAds(prev => [{ ...data, storeName }, ...prev].slice(0, 10))
      setAdMessage('Added: ' + payload.item_name)
      // Keep the store selected (fast repeat entry for the same flyer) but
      // clear everything else for the next item.
      setAdForm({ ...emptyAdForm, partner_store_id: adForm.partner_store_id })
    }
    setAdSubmitting(false)
  }

  // -- Admin: scan a photographed or PDF flyer, extract items via Claude vision,
  // and stage them for review before any writes happen. Nothing is inserted
  // until the admin reviews and clicks "Add All Selected". --
  const FLYER_SYSTEM_PROMPT = `You are reading a grocery store weekly ad flyer (photo or PDF page) to extract every advertised item as structured data.
For each item, extract:
- item_name: the full product name/description as printed (e.g. "80% Lean Ground Beef, Family Pack")
- regular_price: the everyday/shelf price if shown, as a plain number, else null
- card_price: the loyalty-card / member price if shown, as a plain number, else null
- mix_match_price: if priced as "2/$5" or similar mix-and-match style, the per-unit price (e.g. "2/$5" -> 2.50), else null
- unit_size: the unit the price applies to, e.g. "lb", "16 oz", "each", "2/$5" style notation if that's how it's shown
- department: your best guess at department (Meat, Produce, Dairy, Frozen, Grocery, Bakery, Beverages, etc.)
Include every item you can identify, even if some fields are uncertain -- use null for anything not shown or not determinable.
Return ONLY a valid JSON array of objects with exactly these keys: item_name, regular_price, card_price, mix_match_price, unit_size, department. No other text.`

  function parseFlyerItems(raw) {
    const s = raw.indexOf("["), e = raw.lastIndexOf("]")
    if (s === -1) return []
    try {
      return JSON.parse(raw.slice(s, e + 1))
    } catch {
      // Cut off mid-array -- salvage whatever complete {...} objects came
      // through rather than losing the whole batch.
      const body = raw.slice(s + 1)
      const objectMatches = body.match(/\{[^{}]*\}/g) || []
      const items = []
      for (const chunk of objectMatches) {
        try { items.push(JSON.parse(chunk)) } catch { /* skip incomplete tail object */ }
      }
      return items
    }
  }

  function toParsedAdRow(it) {
    return {
      include: true,
      item_name: it.item_name || '',
      canonical_key: '',
      department: it.department || '',
      regular_price: it.regular_price ?? '',
      card_price: it.card_price ?? '',
      mix_match_price: it.mix_match_price ?? '',
      compare_at_price: '',
      unit_size: it.unit_size || '',
      notes: '',
    }
  }

  async function scanFlyer(file) {
    if (!flyerStoreId) {
      setBulkMessage('Pick a store before scanning a flyer.')
      return
    }
    setFlyerScanning(true)
    setBulkMessage('')
    setFlyerProgress('')
    try {
      const isPdf = file.type === 'application/pdf'

      if (!isPdf) {
        // Single image: unchanged, one request, no page-splitting needed.
        setFlyerProgress('Reading the flyer...')
        const b64 = await compressImageToLimit(file)
        const raw = await callClaude({
          system: FLYER_SYSTEM_PROMPT,
          prompt: "Extract every advertised item from this flyer.",
          imageBase64: b64,
          imageType: "image/jpeg",
          maxTokens: 32000,
          timeoutMs: 180000,
        })
        const items = parseFlyerItems(raw)
        if (items.length === 0) throw new Error("Could not read the flyer")
        setParsedAds(items.map(toParsedAdRow))
        return
      }

      // PDF: split into per-page images client-side, then process a few
      // pages at a time. This keeps each individual request small and fast
      // (avoiding the size/token/timeout limits a whole 20-40 page circular
      // hits in one shot) and shows real progress instead of one long
      // silent wait.
      const maxPdfBytes = 60 * 1024 * 1024 // raw file, before we split it
      if (file.size > maxPdfBytes) {
        throw new Error(`That PDF is ${(file.size / 1024 / 1024).toFixed(1)}MB, too large to process. Try exporting a smaller/lower-resolution PDF.`)
      }

      setFlyerProgress('Opening the PDF...')
      const { pages, truncatedPageCount } = await splitPdfIntoPageImages(file, setFlyerProgress)

      const sleep = ms => new Promise(r => setTimeout(r, ms))
      async function callClaudeWithRetry(args, label, retries = 2, delayMs = 1500) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await callClaude(args)
          } catch (err) {
            if (attempt >= retries) throw err
            // Transient network blips (dropped connection, SSL handshake
            // hiccup, etc.) are common over a long multi-batch scan -- a
            // short retry usually succeeds on the next attempt rather than
            // losing that batch's items entirely.
            setFlyerProgress(`${label} — connection hiccup, retrying (attempt ${attempt + 2} of ${retries + 1})...`)
            await sleep(delayMs * (attempt + 1))
          }
        }
      }

      const BATCH_SIZE = 3
      const allItems = []
      let anyBatchFailed = false
      for (let i = 0; i < pages.length; i += BATCH_SIZE) {
        const batch = pages.slice(i, i + BATCH_SIZE)
        const batchNum = Math.floor(i / BATCH_SIZE) + 1
        const totalBatches = Math.ceil(pages.length / BATCH_SIZE)
        const label = `Reading pages ${i + 1}-${Math.min(i + BATCH_SIZE, pages.length)} of ${pages.length} (batch ${batchNum} of ${totalBatches})`
        setFlyerProgress(`${label}...`)
        try {
          const raw = await callClaudeWithRetry({
            system: FLYER_SYSTEM_PROMPT,
            prompt: "Extract every advertised item from these flyer pages.",
            images: batch,
            maxTokens: 16000,
            timeoutMs: 120000,
          }, label)
          allItems.push(...parseFlyerItems(raw))
        } catch (batchErr) {
          anyBatchFailed = true
          // Keep going -- one failed batch shouldn't lose everything already
          // read from the other pages.
        }
      }

      if (allItems.length === 0) throw new Error("Could not read any pages of this flyer")
      setParsedAds(allItems.map(toParsedAdRow))

      const notes = []
      if (anyBatchFailed) notes.push("some pages couldn't be read and were skipped")
      if (truncatedPageCount) notes.push(`only the first ${pages.length} of ${truncatedPageCount} pages were processed`)
      setBulkMessage(
        notes.length > 0
          ? `Got ${allItems.length} items from ${pages.length} pages, but ${notes.join(' and ')} — review carefully, and re-scan any missed sections separately.`
          : `Read ${allItems.length} items from ${pages.length} pages.`
      )
    } catch (err) {
      setBulkMessage("Couldn't read that flyer: " + err.message + " — you can add items manually instead.")
    }
    setFlyerScanning(false)
    setFlyerProgress('')
  }

  function updateParsedAd(i, field, value) {
    setParsedAds(prev => prev.map((row, idx) => idx === i ? { ...row, [field]: value } : row))
  }

  async function submitParsedAds() {
    const rows = (parsedAds || []).filter(r => r.include && r.item_name.trim())
    if (rows.length === 0) { setBulkMessage('No items selected.'); return }
    if (!flyerStoreId) { setBulkMessage('Pick a store first.'); return }
    setBulkSubmitting(true)
    setBulkMessage('')
    const numOrNull = v => v === '' || v == null ? null : parseFloat(v)
    const payloads = rows.map(r => ({
      partner_store_id: flyerStoreId,
      item_name: r.item_name.trim(),
      canonical_key: r.canonical_key.trim() || null,
      department: r.department.trim() || null,
      regular_price: numOrNull(r.regular_price),
      card_price: numOrNull(r.card_price),
      mix_match_price: numOrNull(r.mix_match_price),
      compare_at_price: numOrNull(r.compare_at_price),
      unit_size: r.unit_size.trim() || null,
      sale_start: flyerSaleStart || null,
      sale_end: flyerSaleEnd || null,
      notes: r.notes.trim() || null,
      source: 'manual',
      entered_by: user?.email || 'admin',
    }))
    const { data, error } = await supabase.from('partner_ads').insert(payloads).select()
    if (error) {
      setBulkMessage('Error: ' + error.message)
    } else {
      const storeName = allStores.find(s => s.id === flyerStoreId)?.name || ''
      setRecentAds(prev => [...(data || []).map(d => ({ ...d, storeName })), ...prev].slice(0, 10))
      setBulkMessage(`Added ${data.length} item${data.length === 1 ? '' : 's'} from the flyer.`)
      setParsedAds(null)
    }
    setBulkSubmitting(false)
  }

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: FB }}>
        <div style={{ position: 'fixed', top: 16, right: 16, display: 'flex', gap: 8 }}>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={theme === 'light'}
            style={{ background: 'none', border: '1px solid ' + T.border, borderRadius: 8, color: T.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(14), lineHeight: 1 }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button onClick={() => setLargeText(!largeText)}
            title={largeText ? 'Switch to normal text size' : 'Switch to large text'}
            aria-pressed={largeText}
            style={{ background: 'none', border: '1px solid ' + (largeText ? T.teal : T.border), borderRadius: 8,
              color: largeText ? T.teal : T.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(12), fontWeight: 700 }}>
            Aa
          </button>
        </div>
        <img src="/logo-icon.png" alt="Smarter Way to Shop" style={{ width: px(72), height: px(72), marginBottom: 12 }} />
        <div style={{ fontFamily: FD, fontSize: px(30), color: T.teal, marginBottom: 4 }}>Smarter Way to Shop</div>
        <div style={{ fontFamily: FM, fontSize: px(13), color: T.muted, marginBottom: 28, textAlign: 'center', maxWidth: 360 }}>
          Build your shopping list, then see the best price for every item across your preferred stores.
        </div>
        <button onClick={onAuthAction} style={{ padding: '14px 32px', background: T.teal, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: px(15), cursor: 'pointer' }}>
          Get Started — 30 Days Free
        </button>
      </div>
    )
  }

  if (!isActive) {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: FB }}>
        <img src="/logo-icon.png" alt="Smarter Way to Shop" style={{ width: px(60), height: px(60), marginBottom: 12 }} />
        <div style={{ fontFamily: FD, fontSize: px(24), color: T.teal, marginBottom: 8 }}>Your trial has ended</div>
        <div style={{ fontFamily: FM, fontSize: px(13), color: T.muted, marginBottom: 24, textAlign: 'center', maxWidth: 340 }}>
          Subscribe to keep comparing prices across your stores and building smarter shopping lists.
        </div>
        <button onClick={onUpgrade} style={{ padding: '14px 32px', background: T.teal, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: px(15), cursor: 'pointer' }}>
          Choose a Plan
        </button>
      </div>
    )
  }

  if (view === 'onboarding') {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, padding: 24, fontFamily: FB }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ fontFamily: FD, fontSize: px(24), color: T.teal, marginBottom: 8 }}>Which stores do you shop at?</div>
          <div style={{ fontFamily: FM, fontSize: px(12), color: T.muted, marginBottom: 20 }}>Pick as many as apply — you can change this anytime.</div>
          {allStores.map(s => (
            <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: T.card, border: '1px solid ' + T.border, borderRadius: 10, marginBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={preferredStoreIds.includes(s.id)} onChange={() => toggleStore(s.id)} style={{ width: 18, height: 18, accentColor: T.teal }} />
              <span style={{ color: T.text, fontSize: px(14) }}>{s.name}</span>
            </label>
          ))}
          <button onClick={() => setView('list')} disabled={preferredStoreIds.length === 0}
            style={{ width: '100%', marginTop: 16, padding: '12px', background: T.teal, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: px(14), cursor: 'pointer', opacity: preferredStoreIds.length === 0 ? 0.5 : 1 }}>
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, fontFamily: FB, color: T.text }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid ' + T.border }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/logo-icon.png" alt="" style={{ width: px(28), height: px(28) }} />
          <span style={{ fontFamily: FD, fontSize: px(18), color: T.teal, fontWeight: 700 }}>Smarter Way to Shop</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: FM, fontSize: px(11), color: T.gold }}>{statusLabel}</span>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={theme === 'light'}
            style={{ background: 'none', border: '1px solid ' + T.border, borderRadius: 8, color: T.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(14), lineHeight: 1 }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button onClick={() => setLargeText(!largeText)}
            title={largeText ? 'Switch to normal text size' : 'Switch to large text'}
            aria-pressed={largeText}
            style={{ background: 'none', border: '1px solid ' + (largeText ? T.teal : T.border), borderRadius: 8,
              color: largeText ? T.teal : T.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(12), fontWeight: 700 }}>
            Aa
          </button>
          <button onClick={() => setView('onboarding')} title="Manage stores" style={{ background: 'none', border: '1px solid ' + T.border, borderRadius: 8, color: T.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(12) }}>Stores</button>
          <button onClick={onAuthAction} style={{ background: 'none', border: '1px solid ' + T.border, borderRadius: 8, color: T.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(12) }}>Sign Out</button>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid ' + T.border }}>
        {[['list', '📝 My List'], ['browse', '🏷 Browse Deals'], ...(isAdmin ? [['adupload', '📤 Ad Upload']] : [])].map(([k, lb]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ flex: 1, padding: '12px', background: 'none', border: 'none', borderBottom: view === k ? '2px solid ' + T.teal : '2px solid transparent',
              color: view === k ? T.teal : T.muted, fontFamily: FB, fontWeight: 700, fontSize: px(13), cursor: 'pointer' }}>
            {lb}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: 20 }}>
        {view === 'list' && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input value={newItemText} onChange={e => setNewItemText(e.target.value)} onKeyDown={e => e.key === 'Enter' && addItem()}
                placeholder="Add an item..." style={{ flex: 1, background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(14) }} />
              <button onClick={addItem} style={{ padding: '10px 16px', background: T.teal, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>+</button>
            </div>

            <label style={{ display: 'block', marginBottom: 16 }}>
              <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                onChange={e => e.target.files?.[0] && scanListPhoto(e.target.files[0])} />
              <div style={{ padding: '10px', textAlign: 'center', border: '1px dashed ' + T.border, borderRadius: 8, color: T.muted, fontSize: px(13), cursor: 'pointer' }}>
                {scanning ? '⏳ Reading your list...' : '📷 Or photograph a handwritten list'}
              </div>
            </label>

            {shoppingList.length === 0 && <div style={{ textAlign: 'center', color: T.muted, fontSize: px(13), padding: 20 }}>Your list is empty — add items above.</div>}

            {shoppingList.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={item.checked} onChange={() => toggleChecked(item.id)} style={{ accentColor: T.teal }} />
                <span style={{ flex: 1, fontSize: px(14), textDecoration: item.checked ? 'line-through' : 'none', color: item.checked ? T.muted : T.text }}>{item.name}</span>
                <button onClick={() => removeItem(item.id)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: px(16) }}>×</button>
              </div>
            ))}

            {shoppingList.length > 0 && (
              <button onClick={checkBestPrices} disabled={checkingPrices || preferredStoreIds.length === 0}
                style={{ width: '100%', marginTop: 14, padding: '12px', background: T.teal, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: px(14), cursor: 'pointer', opacity: checkingPrices ? 0.7 : 1 }}>
                {checkingPrices ? '⏳ Checking prices...' : '💰 Check Best Prices'}
              </button>
            )}

            {matches && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontFamily: FD, fontSize: px(16), color: T.teal, marginBottom: 10 }}>Results</div>
                {matches.map((m, i) => (
                  <div key={i} style={{ background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: 12, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: px(13), marginBottom: m.options.length ? 6 : 0 }}>{m.listItem}</div>
                    {m.options.length === 0 && <div style={{ fontSize: px(12), color: T.muted }}>No current match at your stores.</div>}
                    {m.options.map((o, j) => (
                      <div key={j} style={{ fontSize: px(12), color: j === 0 ? '#22c55e' : T.muted, display: 'flex', justifyContent: 'space-between' }}>
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
            <input value={browseSearch} onChange={e => setBrowseSearch(e.target.value)}
              placeholder="Search deals..."
              style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(14), marginBottom: 12 }} />
            {browsingLoading && <div style={{ textAlign: 'center', color: T.muted, padding: 20 }}>Loading deals...</div>}
            {!browsingLoading && browseAds.length === 0 && <div style={{ textAlign: 'center', color: T.muted, padding: 20 }}>No active deals found at your stores right now.</div>}
            {(() => {
              const q = browseSearch.trim().toLowerCase()
              const filtered = q ? browseAds.filter(ad => (ad.item_name || "").toLowerCase().includes(q)) : browseAds
              if (!browsingLoading && browseAds.length > 0 && filtered.length === 0) {
                return <div style={{ textAlign: 'center', color: T.muted, padding: 20 }}>No deals match "{browseSearch}".</div>
              }
              return filtered.map((ad, i) => {
                const price = ad.card_price ?? ad.mix_match_price ?? ad.regular_price
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', marginBottom: 6 }}>
                    <div>
                      <div style={{ fontSize: px(13), color: T.text }}>{ad.item_name}</div>
                      <div style={{ fontSize: px(11), color: T.muted }}>{ad.partner_stores?.name} {price != null ? `· $${price.toFixed(2)}` : ''} {ad.unit_size ? `(${ad.unit_size})` : ''}</div>
                    </div>
                    <button onClick={() => addFromBrowse(ad.item_name)} style={{ background: T.teal, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: px(12), cursor: 'pointer' }}>+ Add</button>
                  </div>
                )
              })
            })()}
          </>
        )}

        {view === 'adupload' && isAdmin && (
          <>
            <div style={{ fontFamily: FD, fontSize: px(18), color: T.teal, marginBottom: 4 }}>Scan a Flyer</div>
            <div style={{ fontSize: px(11), color: T.muted, marginBottom: 16 }}>Upload a photo or PDF of a weekly ad. Claude reads it, you review before anything is saved.</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Store *</label>
                <select value={flyerStoreId} onChange={e => setFlyerStoreId(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(14) }}>
                  <option value="">Select a store...</option>
                  {allStores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Sale start</label>
                <input type="date" value={flyerSaleStart} onChange={e => setFlyerSaleStart(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Sale end</label>
                <input type="date" value={flyerSaleEnd} onChange={e => setFlyerSaleEnd(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
            </div>

            <label style={{ display: 'block', marginBottom: 16 }}>
              <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
                onChange={e => e.target.files?.[0] && scanFlyer(e.target.files[0])} />
              <div style={{ padding: '14px', textAlign: 'center', border: '1px dashed ' + T.border, borderRadius: 8, color: T.muted, fontSize: px(13), cursor: 'pointer' }}>
                {flyerScanning ? `⏳ ${flyerProgress || 'Reading the flyer...'}` : '📄 Upload a flyer photo or PDF'}
              </div>
            </label>

            {bulkMessage && (
              <div style={{ fontSize: px(12), color: bulkMessage.startsWith('Error') || bulkMessage.startsWith("Couldn't") ? '#dc2626' : T.teal, marginBottom: 16 }}>{bulkMessage}</div>
            )}

            {parsedAds && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontFamily: FD, fontSize: px(15), color: T.teal, marginBottom: 8 }}>
                  Review {parsedAds.length} Item{parsedAds.length === 1 ? '' : 's'}
                </div>
                {(() => {
                  const hasAnyPrice = r => r.regular_price !== '' || r.card_price !== '' || r.mix_match_price !== '' || r.compare_at_price !== ''
                  const withPriceCount = parsedAds.filter(hasAnyPrice).length
                  const noPriceCount = parsedAds.length - withPriceCount
                  return (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                      <button onClick={() => setParsedAds(prev => prev.map(r => ({ ...r, include: hasAnyPrice(r) })))}
                        style={{ background: T.surface, color: T.text, border: '1px solid ' + T.border, borderRadius: 6, padding: '6px 10px', fontSize: px(12), cursor: 'pointer' }}>
                        Select only items with a price ({withPriceCount})
                      </button>
                      <button onClick={() => setParsedAds(prev => prev.map(r => ({ ...r, include: true })))}
                        style={{ background: 'none', color: T.muted, border: '1px solid ' + T.border, borderRadius: 6, padding: '6px 10px', fontSize: px(12), cursor: 'pointer' }}>
                        Select all
                      </button>
                      {noPriceCount > 0 && (
                        <span style={{ fontSize: px(11), color: T.muted }}>{noPriceCount} item{noPriceCount === 1 ? '' : 's'} have no price captured</span>
                      )}
                    </div>
                  )
                })()}
                {parsedAds.map((row, i) => (
                  <div key={i} style={{ background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: 10, marginBottom: 8, opacity: row.include ? 1 : 0.5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <input type="checkbox" checked={row.include} onChange={e => updateParsedAd(i, 'include', e.target.checked)} style={{ accentColor: T.teal }} />
                      <input value={row.item_name} onChange={e => updateParsedAd(i, 'item_name', e.target.value)}
                        style={{ flex: 1, background: T.surface, border: '1px solid ' + T.border, borderRadius: 6, padding: '6px 8px', color: T.text, fontSize: px(13) }} />
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginLeft: 26 }}>
                      {[['regular_price', 'Reg $'], ['card_price', 'Card $'], ['mix_match_price', 'Mix $'], ['unit_size', 'Unit'], ['department', 'Dept']].map(([key, label]) => (
                        <input key={key} value={row[key]} onChange={e => updateParsedAd(i, key, e.target.value)}
                          placeholder={label}
                          style={{ flex: 1, background: T.surface, border: '1px solid ' + T.border, borderRadius: 6, padding: '6px 8px', color: T.text, fontSize: px(12) }} />
                      ))}
                    </div>
                  </div>
                ))}
                <button onClick={submitParsedAds} disabled={bulkSubmitting}
                  style={{ width: '100%', padding: '12px', background: T.teal, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: px(14), cursor: 'pointer', opacity: bulkSubmitting ? 0.7 : 1, marginTop: 8 }}>
                  {bulkSubmitting ? 'Adding...' : `Add All Selected (${parsedAds.filter(r => r.include).length})`}
                </button>
              </div>
            )}

            <div style={{ height: 1, background: T.border, margin: '8px 0 24px' }} />

            <div style={{ fontFamily: FD, fontSize: px(18), color: T.teal, marginBottom: 4 }}>Add a Deal Manually</div>
            <div style={{ fontSize: px(11), color: T.muted, marginBottom: 16 }}>Admin only. Writes are also enforced server-side.</div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Store *</label>
              <select value={adForm.partner_store_id} onChange={e => setAdForm({ ...adForm, partner_store_id: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(14) }}>
                <option value="">Select a store...</option>
                {allStores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Item name *</label>
              <input value={adForm.item_name} onChange={e => setAdForm({ ...adForm, item_name: e.target.value })}
                placeholder='e.g. "80% Lean Ground Beef, Family Pack"'
                style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(14) }} />
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Canonical key</label>
                <input value={adForm.canonical_key} onChange={e => setAdForm({ ...adForm, canonical_key: e.target.value })}
                  placeholder="ground_beef_approx_80lean"
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Department</label>
                <input value={adForm.department} onChange={e => setAdForm({ ...adForm, department: e.target.value })}
                  placeholder="Meat, Produce, etc."
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[['regular_price', 'Regular $'], ['card_price', 'Card/Sale $'], ['mix_match_price', 'Mix & Match $'], ['compare_at_price', 'Compare-At $']].map(([key, label]) => (
                <div key={key} style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>{label}</label>
                  <input type="number" step="0.01" value={adForm[key]} onChange={e => setAdForm({ ...adForm, [key]: e.target.value })}
                    placeholder="0.00"
                    style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 8px', color: T.text, fontSize: px(13) }} />
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Unit size</label>
                <input value={adForm.unit_size} onChange={e => setAdForm({ ...adForm, unit_size: e.target.value })}
                  placeholder="lb, 16 oz, each..."
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Sale start</label>
                <input type="date" value={adForm.sale_start} onChange={e => setAdForm({ ...adForm, sale_start: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Sale end</label>
                <input type="date" value={adForm.sale_end} onChange={e => setAdForm({ ...adForm, sale_end: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: px(11), color: T.muted, marginBottom: 4 }}>Notes</label>
              <input value={adForm.notes} onChange={e => setAdForm({ ...adForm, notes: e.target.value })}
                placeholder="Optional -- e.g. lean % not specified, approximate match only"
                style={{ width: '100%', boxSizing: 'border-box', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '10px 12px', color: T.text, fontSize: px(13) }} />
            </div>

            {adMessage && (
              <div style={{ fontSize: px(12), color: adMessage.startsWith('Error') ? '#dc2626' : T.teal, marginBottom: 12 }}>{adMessage}</div>
            )}

            <button onClick={submitAd} disabled={adSubmitting}
              style={{ width: '100%', padding: '12px', background: T.teal, color: '#fff', border: 'none', borderRadius: 10, fontFamily: FB, fontWeight: 700, fontSize: px(14), cursor: 'pointer', opacity: adSubmitting ? 0.7 : 1, marginBottom: 20 }}>
              {adSubmitting ? 'Adding...' : '+ Add Deal'}
            </button>

            {recentAds.length > 0 && (
              <>
                <div style={{ fontFamily: FD, fontSize: px(15), color: T.teal, marginBottom: 8 }}>Recently Added This Session</div>
                {recentAds.map((ad, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', background: T.card, border: '1px solid ' + T.border, borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
                    <span style={{ fontSize: px(12), color: T.text }}>{ad.item_name}</span>
                    <span style={{ fontSize: px(11), color: T.muted }}>{ad.storeName}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
