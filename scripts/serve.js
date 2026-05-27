#!/usr/bin/env node
// Glen India UTM Dashboard — Local development server
// Usage: node scripts/serve.js
//        SHOPIFY_ADMIN_TOKEN=shpca_... node scripts/serve.js

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const url   = require('url');

const PORT     = 3000;
const REPO_DIR = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_DIR, 'data/cache');

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

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css',   '.json': 'application/json',
};

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType || MIME[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  } catch (_) { res.writeHead(404); res.end('Not found'); }
}

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

async function fetchAllOrders(from, to, token, fields) {
  if (!fields) fields = 'id,tags,note_attributes,current_total_price,total_price,cancelled_at,cancel_reason,created_at';
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
  let content = a['utm_content'], term = a['utm_term'];
  if ((!source || !medium || !campaign) && a['codk_campaign_attribution']) {
    try {
      const c = JSON.parse(a['codk_campaign_attribution']);
      source=source||c.utm_source; medium=medium||c.utm_medium; campaign=campaign||c.utm_campaign;
      content=content||c.utm_content; term=term||c.utm_term;
    } catch(_) {}
  }
  if ((!source || !medium || !campaign) && a['_eventSourceUrl']) {
    try {
      const u = new URL(a['_eventSourceUrl']);
      source=source||u.searchParams.get('utm_source'); medium=medium||u.searchParams.get('utm_medium');
      campaign=campaign||u.searchParams.get('utm_campaign');
      content=content||u.searchParams.get('utm_content'); term=term||u.searchParams.get('utm_term');
    } catch(_) {}
  }
  return {
    utm_source:   (source?.trim()   || '(direct)').toLowerCase(),
    utm_medium:   (medium?.trim()   || '(none)').toLowerCase(),
    utm_campaign: (campaign?.trim() || '(not set)').toLowerCase(),
    utm_content:  (content?.trim()  || '').toLowerCase(),
    utm_term:     (term?.trim()     || '').toLowerCase(),
  };
}

function processOrders(orders) {
  const seen = new Set();
  const tableMap = {}, tsMap = {};
  for (const order of orders) {
    if (order.id != null) {
      if (seen.has(String(order.id))) continue;
      seen.add(String(order.id));
    }
    if (!(order.tags||'').split(',').map(t=>t.trim().toLowerCase()).includes('magic')) continue;
    const { utm_source, utm_medium, utm_campaign, utm_content, utm_term } = extractUTM(order.note_attributes);
    const revenueP          = Math.round(parseFloat(order.current_total_price||'0') * 100);
    const cancelled         = (order.cancelled_at != null || order.cancel_reason != null) ? 1 : 0;
    const origRevenueP      = Math.round(parseFloat(order.total_price || order.current_total_price||'0') * 100);
    const cancelledRevenueP = cancelled ? origRevenueP : 0;
    const date = order.created_at ? new Date(order.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}) : '';
    if (!date) continue;
    const tk = `${utm_source}|${utm_medium}|${utm_campaign}|${utm_content}|${utm_term}`;
    if (!tableMap[tk]) tableMap[tk] = { utm_source, utm_medium, utm_campaign, utm_content, utm_term, orders:0, revenue:0, cancellations:0, cancelledRevenue:0, channel:'Magic' };
    tableMap[tk].orders++;
    tableMap[tk].revenue         += revenueP;
    tableMap[tk].cancellations   += cancelled;
    tableMap[tk].cancelledRevenue += cancelledRevenueP;
    const sk = `${date}|${utm_source}`;
    if (!tsMap[sk]) tsMap[sk] = { date, utm_source, orders:0, revenue:0, cancellations:0 };
    tsMap[sk].orders++; tsMap[sk].revenue += revenueP; tsMap[sk].cancellations += cancelled;
  }
  return {
    rows: Object.values(tableMap).map(r=>({...r, revenue:r.revenue/100, cancelledRevenue:r.cancelledRevenue/100})).sort((a,b)=>b.orders-a.orders),
    timeseries: Object.values(tsMap).map(r=>({...r,revenue:r.revenue/100})).sort((a,b)=>a.date<b.date?-1:1),
    incomplete: false,
  };
}

// ─── Line-item processing (for TSV download) ───────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }

function processLineItems(orders) {
  const seen = new Set();
  const rowMap = {};
  for (const order of orders) {
    if (order.id != null) {
      if (seen.has(String(order.id))) continue;
      seen.add(String(order.id));
    }
    if (!(order.tags||'').split(',').map(t=>t.trim().toLowerCase()).includes('magic')) continue;
    const { utm_source, utm_medium, utm_campaign, utm_content, utm_term } = extractUTM(order.note_attributes);
    const month = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}).slice(0,7)
      : '';
    if (!month) continue;
    const lineItems = order.line_items || [];
    const numItems  = Math.max(lineItems.length, 1);
    const totalTaxP = Math.round(parseFloat(order.total_tax || '0') * 100);
    for (const item of lineItems) {
      const productType  = item.product_type || '';
      const productTitle = item.title || '';
      const qty    = item.quantity || 1;
      const grossP = Math.round(parseFloat(item.price || '0') * qty * 100);
      const discP  = Math.round(parseFloat(item.total_discount || '0') * 100);
      const taxP   = Math.round(totalTaxP / numItems);
      const rk = `${utm_source}|${utm_medium}|${utm_campaign}|${utm_content}|${utm_term}|${productType}|${productTitle}|${month}`;
      if (!rowMap[rk]) {
        rowMap[rk] = { utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          product_type: productType, product_title: productTitle, month,
          _ids: new Set(), grossP: 0, discP: 0, taxP: 0, netItems: 0 };
      }
      rowMap[rk]._ids.add(String(order.id));
      rowMap[rk].grossP   += grossP;
      rowMap[rk].discP    += discP;
      rowMap[rk].taxP     += taxP;
      rowMap[rk].netItems += qty;
    }
  }
  return Object.values(rowMap).map(({ _ids, grossP, discP, taxP, netItems, ...r }) => {
    const gross = grossP / 100, disc = discP / 100, tax = taxP / 100, net = gross - disc;
    return { ...r, orders: _ids.size,
      gross_sales: round2(gross), discounts: round2(disc), returns: 0,
      net_sales: round2(net), shipping: 0, duties: 0, additional_fees: 0,
      taxes: round2(tax), total_sales: round2(net + tax), net_items: netItems };
  });
}

// ─── Month-chunk helpers ───────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function firstOfMonth(dateStr) {
  return dateStr.slice(0, 8) + '01';
}

function monthChunks(from, to) {
  const chunks = [];
  let [y, m] = from.split('-').map(Number);
  let curFrom = from;
  while (curFrom <= to) {
    const lastDay = new Date(y, m, 0).getDate();
    const monthEnd = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const chunkTo = monthEnd < to ? monthEnd : to;
    chunks.push({ from: curFrom, to: chunkTo });
    m++;
    if (m > 12) { m = 1; y++; }
    curFrom = `${y}-${String(m).padStart(2,'0')}-01`;
  }
  return chunks;
}

function mergeChunkResults(results) {
  const tableMap = {}, tsMap = {};
  let fetchedAt = null;
  for (const result of results) {
    if (!fetchedAt || result.fetchedAt > fetchedAt) fetchedAt = result.fetchedAt;
    for (const row of (result.rows || [])) {
      const tk = `${row.utm_source}|${row.utm_medium}|${row.utm_campaign}|${row.utm_content||''}|${row.utm_term||''}`;
      if (!tableMap[tk]) tableMap[tk] = { utm_source:row.utm_source, utm_medium:row.utm_medium, utm_campaign:row.utm_campaign, utm_content:row.utm_content||'', utm_term:row.utm_term||'', orders:0, revenue:0, cancellations:0, cancelledRevenue:0, channel:'Magic' };
      tableMap[tk].orders          += row.orders;
      tableMap[tk].revenue         += row.revenue;
      tableMap[tk].cancellations   += row.cancellations;
      tableMap[tk].cancelledRevenue += (row.cancelledRevenue || 0);
    }
    for (const pt of (result.timeseries || [])) {
      const sk = `${pt.date}|${pt.utm_source}`;
      if (!tsMap[sk]) tsMap[sk] = { date:pt.date, utm_source:pt.utm_source, orders:0, revenue:0, cancellations:0 };
      tsMap[sk].orders += pt.orders; tsMap[sk].revenue += pt.revenue; tsMap[sk].cancellations += pt.cancellations;
    }
  }
  return {
    rows:       Object.values(tableMap).sort((a,b)=>b.orders-a.orders),
    timeseries: Object.values(tsMap).sort((a,b)=>a.date<b.date?-1:1),
    fetchedAt:  fetchedAt || new Date().toISOString(),
    incomplete: false,
  };
}

// ─── API handler ───────────────────────────────────────────────────────────────

async function handleApi(req, res, parsedUrl) {
  const params  = new URLSearchParams(parsedUrl.search);
  const from    = params.get('from') || '';
  const to      = params.get('to')   || '';
  const refresh = params.get('refresh') === '1';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'from and to must be YYYY-MM-DD' }));
  }
  if (from < '2026-04-01') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Data is only available from 2026-04-01' }));
  }

  if (params.get('format') === 'lineitem') {
    const token = getToken();
    if (!token) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No token available.' }));
    }
    const allOrders = [];
    for (const chunk of monthChunks(from, to)) {
      try {
        const orders = await fetchAllOrders(chunk.from, chunk.to, token,
          'id,tags,note_attributes,created_at,line_items,total_tax');
        allOrders.push(...orders);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(processLineItems(allOrders)));
  }

  const today         = todayIST();
  const curMonthStart = firstOfMonth(today);
  const chunks        = monthChunks(from, to);

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const chunkResults = [];
  for (const chunk of chunks) {
    const isCurrentMonth = chunk.to >= curMonthStart;
    const chunkFile      = path.join(CACHE_DIR, `${chunk.from}_${chunk.to}.json`);
    const skipCache      = refresh && isCurrentMonth;

    if (!skipCache && fs.existsSync(chunkFile)) {
      try {
        console.log(`[CACHE] chunk ${chunk.from} → ${chunk.to}`);
        chunkResults.push(JSON.parse(fs.readFileSync(chunkFile, 'utf8')));
        continue;
      } catch (_) {}
    }

    const token = getToken();
    if (!token) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No token available. Set SHOPIFY_ADMIN_TOKEN or run backfill first.' }));
    }

    // Read existing cached value before fetch to compare order counts
    let prevResult = null;
    if (skipCache && fs.existsSync(chunkFile)) {
      try { prevResult = JSON.parse(fs.readFileSync(chunkFile, 'utf8')); } catch (_) {}
    }

    console.log(`[FETCH] chunk ${chunk.from} → ${chunk.to}`);
    try {
      const orders      = await fetchAllOrders(chunk.from, chunk.to, token);
      const chunkResult = { ...processOrders(orders), fetchedAt: new Date().toISOString() };

      // Preserve fetchedAt if order count unchanged
      if (prevResult) {
        const oldTotal = prevResult.rows?.reduce((s, r) => s + r.orders, 0) || 0;
        const newTotal = chunkResult.rows.reduce((s, r) => s + r.orders, 0);
        if (oldTotal === newTotal) chunkResult.fetchedAt = prevResult.fetchedAt;
      }

      fs.writeFileSync(chunkFile, JSON.stringify(chunkResult));
      chunkResults.push(chunkResult);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, incomplete: true }));
    }
  }

  const merged = mergeChunkResults(chunkResults);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(merged));
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname === '/api') return handleApi(req, res, parsed);
  if (parsed.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(`const CONFIG = { WORKER_URL: 'http://localhost:${PORT}/api' };`);
  }
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    return serveFile(res, path.join(REPO_DIR, 'index.html'), 'text/html');
  }
  const filePath = path.join(REPO_DIR, parsed.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return serveFile(res, filePath);
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Glen India Dashboard — local dev server`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`\nIf data looks empty, run first: node scripts/backfill.js`);
});
