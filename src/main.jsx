// Smarter Way to Shop — Entry Point
// Mirrors Smart Kitchen/Smart Cellar's main.jsx pattern (auth shell, trial, entitlement gating),
// adapted for SWTS's actual entitlement model: no tier system, just trial / addon / admin.
// RG Digital Labs, LLC · September 2026

import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App, { THEMES } from './App'
import {
  supabase,
  SWS_KEYS,
  getUserProfile,
  trialDaysRemaining,
  setSwsTrialStartDate,
  hasActiveSmartKitchenTier,
} from './supabaseClient'
import './App.css'

// -- Admin bypass (kept in sync with Smart Kitchen/Smart Cellar's list; not
//    imported cross-repo, so update all three if this ever changes) ----------
const ADMIN_EMAILS = ['thesmartkitchenapp@gmail.com', 'michiganrvvacations@gmail.com']

// -- Inline Auth Modal (standalone, no cross-app import — same approach as Smart Cellar) --
function AuthModal({ onClose, onSuccess, initialMode = 'signup', theme, setTheme, largeText, setLargeText }) {
  const [mode, setMode]         = useState(initialMode)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [name, setName]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [message, setMessage]   = useState('')

  const C = THEMES[theme]
  const scale = largeText ? 1.3 : 1
  const px = n => Math.round(n * scale)
  const FB = "'DM Sans', sans-serif"
  const FD = "'Cormorant Garamond', serif"

   async function handleSignUp() {
    if (!email || !password) { setError('Email and password are required.'); return }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
    setLoading(true); setError('')
    const { data, error: err } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: name } },
    })
    if (err) { setLoading(false); setError(err.message); return }

    // Supabase returns a user object with NO session and no error when the
    // email is already registered (intentional, to prevent account
    // enumeration). This is the expected path for most real users here --
    // someone who already has a Smart Kitchen account almost always types
    // the same email + password when adding this module, expecting it to
    // just work. So instead of bouncing them to "please sign in instead",
    // quietly try signing them in with what they just typed. Only surface
    // friction if that actually fails (wrong password, etc).
    if (data.user && !data.session) {
      const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password })
      if (signInErr) {
        setLoading(false)
        setMode('signin')
        setError("An account with this email already exists, but that password didn't match. Please sign in.")
        return
      }
      // Real session established on the existing account -- proceed exactly
      // like a normal successful signup. Don't touch sws_trial_start_date if
      // it's already set (setSwsTrialStartDate should no-op / not overwrite
      // an existing trial start for a returning user); only real new users
      // (data.session present on the original signUp call, handled below)
      // get a fresh trial clock started.
      onSuccess(signInData.user)
      setLoading(false)
      return
    }

    if (data.user && data.session) {
      await setSwsTrialStartDate(data.user.id).catch(() => {})
      onSuccess(data.user)
    } else {
      setMessage('Check your email to confirm your account.')
    }
    setLoading(false)
  }

  async function handleSignIn() {
    if (!email || !password) { setError('Email and password are required.'); return }
    setLoading(true); setError('')
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password })
    if (err) { setLoading(false); setError(err.message); return }
    onSuccess(data.user)
    setLoading(false)
  }

  const inp = {
    width: '100%', background: C.surface, border: '1px solid ' + C.border,
    borderRadius: 8, color: C.text, fontFamily: FB, fontSize: px(14),
    padding: '10px 14px', outline: 'none', marginBottom: 12, boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: C.bg, border: '1px solid ' + C.border, borderRadius: 18,
        padding: 32, maxWidth: 420, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={theme === 'light'}
            style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 8, color: C.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(14), lineHeight: 1 }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button onClick={() => setLargeText(!largeText)}
            title={largeText ? 'Switch to normal text size' : 'Switch to large text'}
            aria-pressed={largeText}
            style={{ background: 'none', border: '1px solid ' + (largeText ? C.teal : C.border), borderRadius: 8,
              color: largeText ? C.teal : C.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(12), fontWeight: 700 }}>
            Aa
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <span style={{ fontSize: px(28) }}>🛒</span>
          <div>
            <div style={{ fontFamily: FD, fontSize: px(20), color: C.teal, lineHeight: 1, fontWeight: 700 }}>Smarter Way</div>
            <div style={{ fontFamily: FD, fontSize: px(20), color: C.gold, lineHeight: 1, fontWeight: 600 }}>to Shop</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['signup', 'signin'].map(m => (
            <button key={m} onClick={() => { setMode(m); setError('') }}
              style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, cursor: 'pointer',
                fontFamily: FB, fontWeight: 600, fontSize: px(13),
                background: mode === m ? C.teal : C.surface,
                color: mode === m ? '#fff' : C.muted }}>
              {m === 'signup' ? 'Create Account' : 'Sign In'}
            </button>
          ))}
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: px(11), color: C.muted, textAlign: 'center',
          lineHeight: 1.5, marginBottom: 20 }}>
          Already have a Smart Kitchen account? Use the same email and password here.
        </div>
        {mode === 'signup' && (
          <input style={inp} placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
        )}
        <input style={inp} placeholder="Email address" type="email" value={email}
          onChange={e => setEmail(e.target.value)} />
        <input style={inp} placeholder="Password" type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (mode === 'signup' ? handleSignUp() : handleSignIn())} />

        {error && <div style={{ fontFamily: 'monospace', fontSize: px(12), color: '#dc2626', marginBottom: 12 }}>{error}</div>}
        {message && <div style={{ fontFamily: 'monospace', fontSize: px(12), color: C.gold, marginBottom: 12 }}>{message}</div>}

        <button onClick={mode === 'signup' ? handleSignUp : handleSignIn} disabled={loading}
          style={{ width: '100%', padding: '12px', border: 'none', borderRadius: 10,
            background: C.teal, color: '#fff', fontFamily: FB, fontWeight: 700,
            fontSize: px(14), cursor: 'pointer', opacity: loading ? 0.7 : 1, marginBottom: 12 }}>
          {loading ? 'Please wait…' : mode === 'signup' ? 'Start 30-Day Free Trial' : 'Sign In'}
        </button>

        {mode === 'signup' && (
          <div style={{ fontFamily: 'monospace', fontSize: px(11), color: C.muted, textAlign: 'center', lineHeight: 1.5 }}>
            Free 30-day trial · No credit card required
          </div>
        )}

        <button onClick={onClose} style={{ display: 'block', width: '100%', marginTop: 12,
          background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: px(13) }}>
          Continue without signing in
        </button>
      </div>
    </div>
  )
}

// -- Subscription Modal: shows $5/mo (suite member) or $10/mo (standalone) based on
//    whether the user already has an active Smart Kitchen subscription -- a read-only
//    check against the shared profiles.tier column, decided the moment this modal opens. --
function SubscriptionModal({ user, isSuiteMember, onClose, theme, setTheme, largeText, setLargeText }) {
  const [billing, setBilling] = useState('monthly')
  const [loading, setLoading] = useState(false)
  const C = THEMES[theme]
  const scale = largeText ? 1.3 : 1
  const px = n => Math.round(n * scale)
  const FB = "'DM Sans', sans-serif"
  const teal = C.teal

  const price = isSuiteMember
    ? { monthly: 5, annual: 50, monthlyKey: 'sws_addon_monthly', annualKey: 'sws_addon_annual' }
    : { monthly: 10, annual: 100, monthlyKey: 'sws_standalone_monthly', annualKey: 'sws_standalone_annual' }

  async function subscribe() {
    setLoading(true)
    try {
      const priceKey = billing === 'annual' ? price.annualKey : price.monthlyKey
      const res = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, email: user.email, priceKey }),
      })
      const data = await res.json()
      if (data.url) window.location.href = data.url
      else setLoading(false)
    } catch { setLoading(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: C.bg, border: '1px solid ' + C.border,
        borderRadius: 18, padding: 32, maxWidth: 420, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={theme === 'light'}
            style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 8, color: C.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(14), lineHeight: 1 }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button onClick={() => setLargeText(!largeText)}
            title={largeText ? 'Switch to normal text size' : 'Switch to large text'}
            aria-pressed={largeText}
            style={{ background: 'none', border: '1px solid ' + (largeText ? C.teal : C.border), borderRadius: 8,
              color: largeText ? C.teal : C.muted, cursor: 'pointer', padding: '6px 10px', fontSize: px(12), fontWeight: 700 }}>
            Aa
          </button>
        </div>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: px(22), color: teal, marginBottom: 8 }}>
          Continue with Smarter Way to Shop
        </div>
        {isSuiteMember && (
          <div style={{ fontFamily: 'monospace', fontSize: px(11), color: C.gold, marginBottom: 16, lineHeight: 1.5 }}>
            You're already a Smart Kitchen subscriber — here's your suite-member rate.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {['monthly', 'annual'].map(b => (
            <button key={b} onClick={() => setBilling(b)}
              style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, cursor: 'pointer',
                fontFamily: FB, fontWeight: 600, fontSize: px(13),
                background: billing === b ? teal : C.surface,
                color: billing === b ? '#fff' : C.muted }}>
              {b === 'monthly' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>

        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: px(36), color: C.text, marginBottom: 20 }}>
          ${billing === 'annual' ? (price.annual / 12).toFixed(2) : price.monthly.toFixed(2)}
          <span style={{ fontFamily: 'monospace', fontSize: px(13), color: C.muted }}>/mo</span>
          {billing === 'annual' && (
            <div style={{ fontFamily: 'monospace', fontSize: px(11), color: C.muted, marginTop: 4 }}>
              billed ${price.annual.toFixed(2)}/year
            </div>
          )}
        </div>

        <button onClick={subscribe} disabled={loading}
          style={{ width: '100%', padding: '12px', border: 'none', borderRadius: 10,
            background: teal, color: '#fff', fontFamily: FB, fontWeight: 700,
            fontSize: px(14), cursor: 'pointer', opacity: loading ? 0.7 : 1, marginBottom: 12 }}>
          {loading ? 'Loading…' : 'Subscribe'}
        </button>
        <button onClick={onClose} style={{ display: 'block', width: '100%', background: 'none',
          border: 'none', color: C.muted, cursor: 'pointer', fontSize: px(13) }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// ROOT — Auth wrapper (mirrors Smart Kitchen / Smart Cellar Root pattern)
// =============================================================================
function Root() {
  const [user, setUser]               = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [showAuth, setShowAuth]       = useState(false)
  const [showSub, setShowSub]         = useState(false)
  const [authMode, setAuthMode]       = useState('signup')
  const [authReady, setAuthReady]     = useState(false)

  // Accessibility preferences -- shared across App and both modals, per-device,
  // persisted across visits. Owned here (not in App) so toggling either one
  // stays in sync even while a modal is open on top of the app.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('sws_theme') || 'dark' } catch { return 'dark' }
  })
  const [largeText, setLargeText] = useState(() => {
    try { return localStorage.getItem('sws_large_text') === 'true' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('sws_theme', theme) } catch {} }, [theme])
  useEffect(() => { try { localStorage.setItem('sws_large_text', String(largeText)) } catch {} }, [largeText])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user)
        getUserProfile(session.user.id).then(setUserProfile)
      }
      setAuthReady(true)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user)
        getUserProfile(session.user.id).then(setUserProfile)
      } else {
        setUser(null)
        setUserProfile(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    setUser(null); setUserProfile(null)
  }

  // -- Entitlement resolution -----------------------------------------------
  // No tier system here, deliberately -- just trial / addon / admin. Unlike
  // Smart Kitchen and Smart Cellar, this never writes to or reads a shared
  // "tier" concept for its OWN gating (only reads it read-only, elsewhere, to
  // decide suite-member pricing).
  const isAdmin      = user && ADMIN_EMAILS.includes(user.email?.toLowerCase())
  const trialEndsAt  = userProfile?.sws_trial_ends_at || null
  const inTrial      = !isAdmin && trialEndsAt && new Date(trialEndsAt) > new Date()
  const hasAddon     = !!userProfile?.smarter_way_to_shop_addon
  const isActive     = isAdmin || inTrial || hasAddon
  const daysLeft     = trialDaysRemaining(trialEndsAt)
  const isSuiteMember = hasActiveSmartKitchenTier(userProfile)

  const statusLabel = isAdmin ? 'Admin'
    : inTrial ? `Trial (${daysLeft}d left)`
    : hasAddon ? (isSuiteMember ? 'Member ($5/mo)' : 'Member ($10/mo)')
    : 'Trial ended'

  if (!authReady) return null

  return (
    <>
      <App
        user={user}
        isActive={isActive}
        isSuiteMember={isSuiteMember}
        statusLabel={statusLabel}
        onUpgrade={() => { if (!user) { setAuthMode('signup'); setShowAuth(true) } else setShowSub(true) }}
        onAuthAction={user ? handleSignOut : () => { setAuthMode('signin'); setShowAuth(true) }}
        theme={theme} setTheme={setTheme} largeText={largeText} setLargeText={setLargeText}
      />

      {showAuth && (
        <AuthModal
          initialMode={authMode}
          onClose={() => setShowAuth(false)}
          onSuccess={u => { setUser(u); setShowAuth(false); getUserProfile(u.id).then(setUserProfile) }}
          theme={theme} setTheme={setTheme} largeText={largeText} setLargeText={setLargeText}
        />
      )}

      {showSub && user && (
        <SubscriptionModal
          user={user}
          isSuiteMember={isSuiteMember}
          onClose={() => setShowSub(false)}
          theme={theme} setTheme={setTheme} largeText={largeText} setLargeText={setLargeText}
        />
      )}
    </>
  )
}

createRoot(document.getElementById('root')).render(<Root />)
