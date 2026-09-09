// Smarter Way to Shop — store discovery via Google Places API (New).
//
// Kept server-side deliberately: a Places API key embedded in the client bundle can be scraped
// and abused by anyone (unlike a Supabase anon key, a Google API key with billing attached is a
// direct liability). This function holds the real key in an env var and the browser only ever
// talks to this endpoint.
//
// Two modes, because Google split this in the New API:
//   - query provided  -> Text Search (New): can find a specific named place ("Gene's Family
//     Market"), which Nearby Search (New) genuinely cannot do at all -- it takes no text input.
//   - no query        -> Nearby Search (New): general "what grocery stores are around here"
//     browsing, filtered to grocery-relevant place types.
//
// Field mask is kept intentionally minimal (only what the UI actually shows) since Places API
// (New) pricing scales with which fields are requested, not just call volume.

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
].join(',')

const GROCERY_TYPES = [
  'grocery_store',
  'supermarket',
  'butcher_shop',
  'liquor_store',
  'convenience_store',
]
// Note: 'farmer_stall' is a Table B type in Places API (New) -- it can appear in a response's
// `types` array but is rejected outright as a filter value in includedTypes/excludedTypes. If
// farmers-market coverage is wanted later, the closest Table A filter type is 'market' (unverified
// as of this writing -- check the current Table A list before adding it back).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Places search is not configured yet (missing API key).' })

  const { lat, lng, radiusMiles, query } = req.body || {}
  if (lat == null || lng == null || !radiusMiles) {
    return res.status(400).json({ error: 'lat, lng, and radiusMiles are required' })
  }
  const radiusMeters = Math.min(Math.round(radiusMiles * 1609.34), 50000) // Google caps radius at 50km

  try {
    let url, body
    if (query && query.trim()) {
      url = 'https://places.googleapis.com/v1/places:searchText'
      body = {
        textQuery: query.trim(),
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters } },
        maxResultCount: 10,
      }
    } else {
      url = 'https://places.googleapis.com/v1/places:searchNearby'
      body = {
        includedTypes: GROCERY_TYPES,
        maxResultCount: 20,
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters } },
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    })
    const data = await response.json()
    if (!response.ok) {
      console.error('Places API error:', data)
      return res.status(response.status).json({ error: data?.error?.message || 'Places search failed' })
    }

    const places = (data.places || []).map(p => ({
      placeId: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      latitude: p.location?.latitude ?? null,
      longitude: p.location?.longitude ?? null,
      types: p.types || [],
    }))
    return res.status(200).json({ places })
  } catch (err) {
    console.error('Places search error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
