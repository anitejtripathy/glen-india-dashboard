#!/usr/bin/env node
// Glen India UTM Dashboard — Local development server
// Serves dashboard at http://localhost:3000
// Usage: node scripts/serve.js
//        SHOPIFY_ADMIN_TOKEN=shpca_... node scripts/serve.js  (for live fallback)

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const url   = require('url');

const PORT     = 3000;
const REPO_DIR = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_DIR, 'data/cache');

// ─── Token (optional — only needed for uncached ranges) ─────────────────────────
function getToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'Desktop/shopify_merchants.env'), 'utf8');
    const glenBlock = envFile.split(/\n(?=\{)/).find(b => b.includes('"glen-india"'));
    if (glenBlock) {
      const m = glenBlock.match(/"oauth-token"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}

// ─── Static file helpers ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json',
};

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType || MIME[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  } catch (_) {
    res.writeHead(404); res.end('Not found');
  }
}

// ─── Shopify fetch (mirrors backfill.js logic) ──────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(urlStr, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers: { 'X-Shopify-Access-Token': token },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllOrders(from, to, token) {
  const fields = 'id,tags,note_attributes,current_total_price,cancelled_at,cancel_reason,created_at';
  let nextUrl = `https://glen-india.myshopify.com/admin/api/2024-10/orders.json?tag=Magic`
    + `&created_at_min=${from}T00:00:00%2B05:30`
    + `&created_at_max=${to}T23:59:59%2B05:30`
    + `&status=any&limit=250&fields=${fields}`;
  const all = [];
  while (nextUrl) {
    let resp;
    for (let i = 0; i < 3; i++) {
      resp = await httpsGet(nextUrl, token);
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, i));
    }
    if (resp.status !== 200) throw new Error(`Shopify returned ${resp.status}`);
    const data = JSON.parse(resp.body);
    all.push(...(data.orders || []));
    const limitHdr = resp.headers['x-shopify-shop-api-call-limit'] || '';
    if (parseInt(limitHdr.split('/')[0], 10) >= 35) await sleep(500);
    nextUrl = (resp.headers['link'] || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return all;
}

function extractUTM(noteAttributes) {
  const a = Object.fromEntries(
    (noteAttributes || []).filter(x => x?.name != null).map(({ name, value }) => [name, value])
  );
  let source = a['utm_source'], medium = a['utm_medium'], campaign = a['utm_campaign'];
  if ((!source || !medium || !campaign) && a['codk_campaign_attribution']) {
    try { const c = JSON.parse(a['codk_campaign_attribution']); source=source||c.utm_source; medium=medium||c.utm_medium; campaign=campaign||c.utm_campaign; } catch(_) {}
  }
  if ((!source || !medium || !campaign) && a['_eventSourceUrl']) {
    try { const u = new URL(a['_eventSourceUrl']); source=source||u.searchParams.get('utm_source'); medium=medium||u.searchParams.get('utm_medium'); campaign=campaign||u.searchParams.get('utm_campaign'); } catch(_) {}
  }
  return { utm_source:(source?.trim()||'(direct)').toLowerCase(), utm_medium:(medium?.trim()||'(none)').toLowerCase(), utm_campaign:(campaign?.trim()||'(not set)').toLowerCase() };
}

function processOrders(orders) {
  const tableMap = {}, tsMap = {};
  for (const order of orders) {
    if (!(order.tags||'').split(',').map(t=>t.trim().toLowerCase()).includes('magic')) continue;
    const { utm_source, utm_medium, utm_campaign } = extractUTM(order.note_attributes);
    const revenueP = Math.round(parseFloat(order.current_total_price||'0') * 100);
    const cancelled = (order.cancelled_at != null || order.cancel_reason != null) ? 1 : 0;
    const date = order.created_at ? new Date(order.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}) : '';
    if (!date) continue;
    const tk = `${utm_source}|${utm_medium}|${utm_campaign}`;
    if (!tableMap[tk]) tableMap[tk] = { utm_source, utm_medium, utm_campaign, orders:0, revenue:0, cancellations:0, channel:'Magic' };
    tableMap[tk].orders++; tableMap[tk].revenue += revenueP; tableMap[tk].cancellations += cancelled;
    const sk = `${date}|${utm_source}`;
    if (!tsMap[sk]) tsMap[sk] = { date, utm_source, orders:0, revenue:0, cancellations:0 };
    tsMap[sk].orders++; tsMap[sk].revenue += revenueP; tsMap[sk].cancellations += cancelled;
  }
  return {
    rows: Object.values(tableMap).map(r=>({...r,revenue:r.revenue/100})).sort((a,b)=>b.orders-a.orders),
    timeseries: Object.values(tsMap).map(r=>({...r,revenue:r.revenue/100})).sort((a,b)=>a.date<b.date?-1:1),
    incomplete: false,
  };
}

// ─── API handler ────────────────────────────────────────────────────────────────
async function handleApi(req, res, parsedUrl) {
  const params  = new URLSearchParams(parsedUrl.search);
  const from    = params.get('from') || '';
  const to      = params.get('to')   || '';
  const refresh = params.get('refresh') === '1';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'from and to must be YYYY-MM-DD' }));
  }
  if (from < '2026-01-01') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Data is only available from 2026-01-01' }));
  }

  const cacheFile = path.join(CACHE_DIR, `${from}_${to}.json`);
  if (!refresh && fs.existsSync(cacheFile)) {
    console.log(`[CACHE] ${from} → ${to}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(fs.readFileSync(cacheFile));
  }

  const token = getToken();
  if (!token) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No token available. Run backfill first or set SHOPIFY_ADMIN_TOKEN.' }));
  }

  console.log(`[LIVE] ${from} → ${to}`);
  try {
    const orders = await fetchAllOrders(from, to, token);
    const result = { ...processOrders(orders), fetchedAt: new Date().toISOString() };
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, incomplete: true }));
  }
}

// ─── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  if (parsed.pathname === '/api') {
    return handleApi(req, res, parsed);
  }
  if (parsed.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(`const CONFIG = { WORKER_URL: 'http://localhost:${PORT}/api' };`);
  }
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    return serveFile(res, path.join(REPO_DIR, 'index.html'), 'text/html');
  }
  // Fallback: try serving the file from repo root
  const filePath = path.join(REPO_DIR, parsed.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveFile(res, filePath);
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Glen India Dashboard — local dev server`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`\nIf data looks empty, run first: node scripts/backfill.js`);
});
