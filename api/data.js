'use strict';

const PROJECTS = [
  { name: 'rubix-pole-acquisition',    id: 'prj_345gNlBNxgvsSCakmtpNTSECGFqR', short: 'pole'  },
  { name: 'rubix-pitch-generator-dev', id: 'prj_GM0WHDF8ik7PjMeib2Zha1EYXblM', short: 'pitch' },
  { name: 'rubix-smart-content',       id: 'prj_kAzFteCZudVEikhKBC2dK2GdpMVS', short: 'smart' },
];

const SVCS = ['Build Minutes', 'Function Invocations', 'Function Duration', 'Fast Data Transfer'];
const LIMITS = {
  'Build Minutes': 6000,
  'Function Invocations': 1e6,
  'Function Duration': 1000,
  'Fast Data Transfer': 1000,
};
const UNITS = {
  'Build Minutes': 'min',
  'Function Invocations': 'invoc.',
  'Function Duration': 'GB-h',
  'Fast Data Transfer': 'GB',
};

module.exports = async (req, res) => {
  const VERCEL_TOKEN     = process.env.VERCEL_TOKEN;
  const VERCEL_TEAM_ID   = process.env.VERCEL_TEAM_ID;
  const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY;
  const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID;

  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID) {
    return res.status(500).json({ error: 'Env vars manquants : VERCEL_TOKEN, VERCEL_TEAM_ID' });
  }

  const vH = { Authorization: `Bearer ${VERCEL_TOKEN}` };
  const oH = { Authorization: `Bearer ${OPENAI_ADMIN_KEY}` };

  // ── Période de facturation (renouvellement le 20 de chaque mois) ──────────
  const now = new Date();
  const billingFrom = now.getDate() >= 20
    ? new Date(now.getFullYear(), now.getMonth(), 20, 0, 0, 0, 0)
    : new Date(now.getFullYear(), now.getMonth() - 1, 20, 0, 0, 0, 0);
  const billingEnd = new Date(billingFrom.getFullYear(), billingFrom.getMonth() + 1, billingFrom.getDate());

  const daysElapsed   = Math.max((now - billingFrom) / 86400000, 1);
  const totalDays     = (billingEnd - billingFrom) / 86400000;
  const daysRemaining = Math.max((billingEnd - now) / 86400000, 0);

  // Depuis jan 2026 pour OpenAI
  const sinceJan  = new Date('2026-01-01T00:00:00Z');
  const sinceUnix = Math.floor(sinceJan.getTime() / 1000);

  try {
    const [billing, deploys, openai] = await Promise.all([
      fetchBilling(VERCEL_TEAM_ID, vH, billingFrom, now),
      fetchDeploys(VERCEL_TEAM_ID, vH),
      fetchOpenAI(oH, OPENAI_PROJECT_ID, sinceUnix, sinceJan),
    ]);

    // ── Projections ──────────────────────────────────────────────────────────
    const proj = {};
    for (const svc of SVCS) {
      const used  = billing[svc]?.total ?? 0;
      const limit = LIMITS[svc];
      const rate  = used / daysElapsed;
      const projected = r(rate * totalDays, 1);
      const remaining = r(limit - used, 1);
      const daysUntil = rate > 0 ? Math.round(remaining / rate) : 999;
      const projPct   = r((projected / limit) * 100, 1);
      proj[svc] = {
        used:      r(used, 3),
        limit,
        unit:      UNITS[svc],
        dailyRate: r(rate, 2),
        projected,
        remaining,
        daysUntil,
        projPct,
        risk:      projPct > 80 ? 'danger' : projPct > 50 ? 'warn' : 'ok',
        perApp:    billing[svc]?.perApp ?? {},
      };
    }

    const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

    return res.json({
      period: {
        from:          fmtDate(billingFrom),
        to:            fmtDate(now),
        reset:         fmtDate(billingEnd),
        daysElapsed:   r(daysElapsed, 1),
        daysRemaining: r(daysRemaining, 1),
      },
      vercel:      { proj, deploys },
      openai,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Vercel Billing JSONL ──────────────────────────────────────────────────────
async function fetchBilling(teamId, headers, from, to) {
  const url = `https://api.vercel.com/v1/billing/charges?teamId=${teamId}` +
    `&from=${from.toISOString()}&to=${to.toISOString()}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) return {};

  const text = await resp.text();
  const result = {};

  for (const line of text.split('\n')) {
    if (line.length < 10) continue;
    // Pré-filtre rapide avant le JSON.parse coûteux
    const svc = SVCS.find(s => line.includes(s));
    if (!svc) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.ServiceName !== svc) continue;
      if (!result[svc]) result[svc] = { total: 0, perApp: {} };
      const qty = parseFloat(obj.ConsumedQuantity) || 0;
      result[svc].total += qty;
      const appName = obj.Tags?.ProjectName || '_other';
      result[svc].perApp[appName] = (result[svc].perApp[appName] || 0) + qty;
    } catch { /* ligne malformée, on passe */ }
  }

  // Arrondi final
  for (const svc of Object.keys(result)) {
    result[svc].total = r(result[svc].total, 3);
    for (const app of Object.keys(result[svc].perApp)) {
      result[svc].perApp[app] = r(result[svc].perApp[app], 3);
    }
  }
  return result;
}

// ── Vercel Deployments ────────────────────────────────────────────────────────
async function fetchDeploys(teamId, headers) {
  const deploys = {};
  await Promise.all(PROJECTS.map(async p => {
    try {
      const url  = `https://api.vercel.com/v6/deployments?projectId=${p.id}&teamId=${teamId}&limit=1`;
      const data = await (await fetch(url, { headers })).json();
      const d    = data.deployments?.[0];
      deploys[p.short] = {
        state:    d?.state ?? 'N/A',
        lastDate: d?.created
          ? new Date(d.created).toLocaleString('fr-FR', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })
          : 'N/A',
      };
    } catch {
      deploys[p.short] = { state: 'N/A', lastDate: 'N/A' };
    }
  }));
  return deploys;
}

// ── OpenAI Costs ──────────────────────────────────────────────────────────────
async function fetchOpenAI(headers, projectId, sinceUnix, sinceDate) {
  let totalCost = 0, totalRequests = 0;
  try {
    const [costsResp, usageResp] = await Promise.all([
      fetch(`https://api.openai.com/v1/organization/costs?start_time=${sinceUnix}&project_ids=${projectId}&limit=30`, { headers }),
      fetch(`https://api.openai.com/v1/organization/usage/completions?start_time=${sinceUnix}&project_ids=${projectId}&limit=31`, { headers }),
    ]);
    const [costs, usage] = await Promise.all([costsResp.json(), usageResp.json()]);
    for (const b of costs.data  ?? []) for (const r of b.results ?? []) totalCost     += parseFloat(r.amount?.value) || 0;
    for (const b of usage.data  ?? []) for (const r of b.results ?? []) totalRequests += parseInt(r.num_model_requests) || 0;
  } catch { /* OpenAI non critique */ }

  const costPerPrompt    = totalRequests > 0 ? r(totalCost / totalRequests, 4) : 0;
  const daysSince        = Math.max((Date.now() - sinceDate.getTime()) / 86400000, 1);
  const monthlyProjected = r(totalCost / daysSince * 30, 2);

  return {
    totalCost:         r(totalCost, 2),
    requests:          totalRequests,
    costPerPrompt,
    monthlyProjected,
  };
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const r   = (n, dec = 2) => Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
const pad = n => String(n).padStart(2, '0');
