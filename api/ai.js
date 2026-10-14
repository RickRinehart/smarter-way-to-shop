import { createClient } from '@supabase/supabase-js';

// Server-side proxy for every Claude call Smarter Way to Shop makes (shopping-list photo scan and flyer/ad reading).
// The Anthropic key lives ONLY here, as a non-VITE env var (ANTHROPIC_API_KEY), so it is never shipped to the
// browser. (It used to be read in the browser as VITE_ANTHROPIC_KEY, which put it in the site's public JavaScript
// where anyone could copy it; a copied key was used for hundreds of dollars of Opus calls in Oct 2026.)
//
// The browser sends {system, messages, max_tokens}. The MODEL is chosen here (env AI_MODEL), so it can be changed
// or rolled back from Vercel settings without a code change.
//
// Who may call it: SIGNED-IN users only (SWTS already makes people sign in before they see anything). Counters live in
// Supabase (the shared ai_rate_check function) because serverless memory is not shared between invocations.

const DEFAULT_MODEL = 'claude-sonnet-4-6'; // the model SWTS's prompts were built and tested on
const MAX_TOKENS_CAP = 16000;              // flyer batches ask for 16000
const MAX_MESSAGES = 10;
const ALLOWED_BLOCK_TYPES = new Set(['text', 'image', 'document']);
const UPSTREAM_TIMEOUT_MS = 115000;        // just under maxDuration (120s) in vercel.json

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function validBody(b) {
  if (!b || typeof b !== 'object') return 'Invalid request';
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) return 'Invalid messages';
  for (const m of b.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Invalid message role';
    if (typeof m.content === 'string') continue;
    if (!Array.isArray(m.content) || m.content.length === 0) return 'Invalid message content';
    for (const blk of m.content) {
      if (!blk || !ALLOWED_BLOCK_TYPES.has(blk.type)) return 'Unsupported content type';
    }
  }
  if (b.system !== undefined && typeof b.system !== 'string') return 'Invalid system prompt';
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'proxy_not_configured' });

  const body = req.body;
  const problem = validBody(body);
  if (problem) return res.status(400).json({ error: problem });

  const supabaseAdmin = createClient(
    process.env.VITE_SUPABASE_URL || 'https://wnlqvmedocpgjawmwivd.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Signed-in users only: a missing, bad or expired token is refused (never treated as a guest).
  const token = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'sign_in_required' });
  let user = null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    user = !error && data ? data.user : null;
  } catch (e) { user = null; }
  if (!user) return res.status(401).json({ error: 'sign_in_required' });

  // Rate limits: per user per hour, plus one cap on everything per day (a backstop for the wallet).
  const check = async (bucket, limit, windowSeconds) => {
    const { data, error } = await supabaseAdmin.rpc('ai_rate_check', {
      p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds,
    });
    if (error) throw new Error(error.message);
    return data === true;
  };
  try {
    const okUser = await check('swts:user:' + user.id, num(process.env.AI_USER_LIMIT_PER_HOUR, 300), 3600);
    if (!okUser) return res.status(429).json({ error: 'rate_limited' });
    const okAll = await check('swts:all', num(process.env.AI_ALL_PER_DAY, 4000), 86400);
    if (!okAll) return res.status(429).json({ error: 'rate_limited' });
  } catch (e) {
    // If the counter itself is broken, keep signed-in people working (and say so in the log).
    console.error('swts ai rate-limit check failed:', e.message);
  }

  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const payload = {
    model,
    max_tokens: Math.min(num(body.max_tokens, 1000), MAX_TOKENS_CAP),
    messages: body.messages,
  };
  if (body.system) payload.system = body.system;

  // Models in the 5.x family think before answering by default, and thinking tokens count against max_tokens (a short
  // request can come back EMPTY). Their API wants {type: 'between_tools'} to turn that off ({type: 'disabled'} is
  // rejected). Older models (like the default here) do not think unless asked, so nothing is sent for them.
  // AI_THINKING=default leaves the setting out entirely. If the API ever rejects it, retry once without it.
  const thinkingOff = /^claude-(sonnet|opus|haiku)-5/.test(model) && (process.env.AI_THINKING || 'off') !== 'default';
  const callAnthropic = async (p) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(p),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    return { r, d };
  };
  const failUpstream = (e) => {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.error('swts ai upstream fetch failed:', e && e.message);
    return res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'upstream_timeout' : 'upstream_unreachable' });
  };

  let result;
  try {
    result = await callAnthropic(thinkingOff ? { ...payload, thinking: { type: 'between_tools' } } : payload);
  } catch (e) { return failUpstream(e); }
  if (thinkingOff && !result.r.ok && result.r.status === 400 && /thinking/i.test(JSON.stringify((result.d && result.d.error) || ''))) {
    console.error('swts ai: upstream rejected the thinking setting, retrying without it');
    try { result = await callAnthropic(payload); } catch (e) { return failUpstream(e); }
  }
  const upstream = result.r;
  const data = result.d;

  if (!upstream.ok || !data) {
    const msg = (data && data.error && data.error.message) || '';
    console.error('swts ai upstream error', upstream.status, data && data.error && data.error.type, msg);
    // Out of credits: tell the app plainly (it shows a friendly message) instead of a vague 400.
    if (/credit balance is too low/i.test(msg)) return res.status(503).json({ error: 'ai_unavailable' });
    // Anything else: pass Anthropic's error shape through (never echoing keys).
    return res.status(upstream.status >= 400 ? upstream.status : 502).json({ error: (data && data.error) || { message: 'AI service error' } });
  }
  // Newer models can prepend a "thinking" block. The app only ever wants the text.
  const textOnly = Array.isArray(data.content) ? data.content.filter((b) => b && b.type === 'text') : [];
  return res.status(200).json({ ...data, content: textOnly });
}
