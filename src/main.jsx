// Smarter Way to Shop — Entry Point
// Mirrors Smart Kitchen/Smart Cellar's main.jsx pattern (auth shell, trial, entitlement gating),
// adapted for SWTS's actual entitlement model: no tier system, just trial / addon / admin.
// RG Digital Labs, LLC · September 2026

import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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
function AuthModal({ onClose, onSuccess, initialMode = 'signup' }) {
  const [mode, setMode]         = useState(initialMode)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [name, setName]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [message, setMessage]   = useState('')

  const C = {
    bg: '#0f1720', surface: '#16202b', border: '#233240',
    text: '#e8edf2', muted: '#8a99a8', teal: '#0F8A7A', gold: '#C8963E',
  }
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
    if (data.user) {
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
    borderRadius: 8, color: C.text, fontFamily: FB, fontSize: 14,
    padding: '10px 14px', outline: 'none', marginBottom: 12, boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: C.bg, border: '1px solid ' + C.border, borderRadius: 18,
        padding: 32, maxWidth: 420, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <span style={{ fontSize: 28 }}>🛒</span>
          <div>
            <div style={{ fontFamily: FD, fontSize: 20, color: C.teal, lineHeight: 1, fontWeight: 700 }}>Smarter Way</div>
            <div style={{ fontFamily: FD, fontSize: 20, color: C.gold, lineHeight: 1, fontWeight: 600 }}>to Shop</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {['signup', 'signin'].map(m => (
            <button key={m} onClick={() => { setMode(m); setError('') }}
              style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, cursor: 'pointer',
                fontFamily: FB, fontWeight: 600, fontSize: 13,
                background: mode === m ? C.teal : C.surface,
                color: mode === m ? '#fff' : C.muted }}>
              {m === 'signup' ? 'Create Account' : 'Sign In'}
            </button>
          ))}
        </div>

        {mode === 'signup' && (
          <input style={inp} placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
        )}
        <input style={inp} placeholder="Email address" type="email" value={email}
          onChange={e => setEmail(e.target.value)} />
        <input style={inp} placeholder="Password" type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (mode === 'signup' ? handleSignUp() : handleSignIn())} />

        {error && <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#dc2626', marginBottom: 12 }}>{error}</div>}
        {message && <div style={{ fontFamily: 'monospace', fontSize: 12, color: C.gold, marginBottom: 12 }}>{message}</div>}

        <button onClick={mode === 'signup' ? handleSignUp : handleSignIn} disabled={loading}
          style={{ width: '100%', padding: '12px', border: 'none', borderRadius: 10,
            background: C.teal, color: '#fff', fontFamily: FB, fontWeight: 700,
            fontSize: 14, cursor: 'pointer', opacity: loading ? 0.7 : 1, marginBottom: 12 }}>
          {loading ? 'Please wait…' : mode === 'signup' ? 'Start 30-Day Free Trial' : 'Sign In'}
        </button>

        {mode === 'signup' && (
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: C.muted, textAlign: 'center', lineHeight: 1.5 }}>
            Free 30-day trial · No credit card required
          </div>
        )}

        <button onClick={onClose} style={{ display: 'block', width: '100%', marginTop: 12,
          background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 13 }}>
          Continue without signing in
        </button>
      </div>
    </div>
  )
}

// -- Subscription Modal: shows $5/mo (suite member) or $10/mo (standalone) based on
//    whether the user already has an active Smart Kitchen subscription -- a read-only
//    check against the shared profiles.tier column, decided the moment this modal opens. --
function SubscriptionModal({ user, isSuiteMember, onClose }) {
  const [billing, setBilling] = useState('monthly')
  const [loading, setLoading] = useState(false)
  const FB = "'DM Sans', sans-serif"
  const teal = '#0F8A7A'

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
      <div style={{ background: '#0f1720', border: '1px solid #233240',
        borderRadius: 18, padding: 32, maxWidth: 420, width: '100%' }}>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, color: teal, marginBottom: 8 }}>
          Continue with Smarter Way to Shop
        </div>
        {isSuiteMember && (
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#C8963E', marginBottom: 16, lineHeight: 1.5 }}>
            You're already a Smart Kitchen subscriber — here's your suite-member rate.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {['monthly', 'annual'].map(b => (
            <button key={b} onClick={() => setBilling(b)}
              style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, cursor: 'pointer',
                fontFamily: FB, fontWeight: 600, fontSize: 13,
                background: billing === b ? teal : '#16202b',
                color: billing === b ? '#fff' : '#8a99a8' }}>
              {b === 'monthly' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>

        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 36, color: '#e8edf2', marginBottom: 20 }}>
          ${billing === 'annual' ? (price.annual / 12).toFixed(2) : price.monthly.toFixed(2)}
          <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#8a99a8' }}>/mo</span>
          {billing === 'annual' && (
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#8a99a8', marginTop: 4 }}>
              billed ${price.annual.toFixed(2)}/year
            </div>
          )}
        </div>

        <button onClick={subscribe} disabled={loading}
          style={{ width: '100%', padding: '12px', border: 'none', borderRadius: 10,
            background: teal, color: '#fff', fontFamily: FB, fontWeight: 700,
            fontSize: 14, cursor: 'pointer', opacity: loading ? 0.7 : 1, marginBottom: 12 }}>
          {loading ? 'Loading…' : 'Subscribe'}
        </button>
        <button onClick={onClose} style={{ display: 'block', width: '100%', background: 'none',
          border: 'none', color: '#8a99a8', cursor: 'pointer', fontSize: 13 }}>
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
      />

      {showAuth && (
        <AuthModal
          initialMode={authMode}
          onClose={() => setShowAuth(false)}
          onSuccess={u => { setUser(u); setShowAuth(false); getUserProfile(u.id).then(setUserProfile) }}
        />
      )}

      {showSub && user && (
        <SubscriptionModal
          user={user}
          isSuiteMember={isSuiteMember}
          onClose={() => setShowSub(false)}
        />
      )}
    </>
  )
}

createRoot(document.getElementById('root')).render(<Root />)
