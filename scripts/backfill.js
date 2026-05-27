#!/usr/bin/env node
// Glen India UTM Dashboard — Backfill script
// Fetches Magic orders month-by-month from 2026-01-01 to today, saves to data/cache/
// Usage: node scripts/backfill.js
//        SHOPIFY_ADMIN_TOKEN=shpca_... node scripts/backfill.js

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ─── Token resolution ───────────────────────────────────────────────────────────
function getToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  try {
    const envFile = fs.readFileSync(path.join(os.homedir(), 'Desktop/shopify_merchants.env'), 'utf8');
    // Find the glen-india block and extract oauth-token
    const glenBlock = envFile.split(/\n(?=\{)/).find(b => b.includes('"glen-india"'));
    if (glenBlock) {
      const m = glenBlock.match(/"oauth-token"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch (_) {}
  throw new Error('SHOPIFY_ADMIN_TOKEN not set and ~/Desktop/shopify_merchants.env not found.\nRun: SHOPIFY_ADMIN_TOKEN=shpca_... node scripts/backfill.js');
}

// ─── Date helpers ───────────────────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function monthChunks(startYYYYMM, endDate) {
  const chunks = [];
  let [y, m] = startYYYYMM.split('-').map(Number);
  while (true) {
    const from = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const toFull = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const to = toFull < endDate ? toFull : endDate;
    if (from > endDate) break;
    chunks.push({ from, to });
    m++;
    if (m > 12) { m = 1; y++; }
    if (from > endDate) break;
  }
  return chunks;
}

// ─── Shopify API ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(urlStr, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token },
    };
    const req = https.request(opts, res => {
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
  const baseUrl = 'https://glen-india.myshopify.com/admin/api/2024-10/orders.json';
  let nextUrl = `${baseUrl}?tag=Magic`
    + `&created_at_min=${from}T00:00:00%2B05:30`
    + `&created_at_max=${to}T23:59:59%2B05:30`
    + `&status=any&limit=250&fields=${fields}`;

  const all = [];
  let page = 0;

  while (nextUrl) {
    page++;
    let resp;
    // Retry on 429
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await httpsGet(nextUrl, token);
      if (resp.status !== 429) break;
      const wait = 1000 * Math.pow(2, attempt);
      console.log(`  429 rate limit — waiting ${wait}ms...`);
      await sleep(wait);
    }
    if (resp.status !== 200) throw new Error(`Shopify API returned ${resp.status} for ${nextUrl}`);

    const data = JSON.parse(resp.body);
    all.push(...(data.orders || []));
    console.log(`  page ${page}: ${data.orders?.length || 0} orders (total so far: ${all.length})`);

    // Throttle when near bucket limit
    const limitHdr = resp.headers['x-shopify-shop-api-call-limit'] || '';
    const used = parseInt(limitHdr.split('/')[0], 10);
    if (used >= 35) {
      console.log(`  throttling (bucket: ${limitHdr})…`);
      await sleep(500);
    }

    nextUrl = parseNextLink(resp.headers['link']);
  }

  return all;
}

function parseNextLink(header) {
  if (!header) return null;
  const m = header.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

// ─── UTM extraction (mirrors worker.js logic) ────────────────────────────────────
function extractUTM(noteAttributes) {
  const a = Object.fromEntries(
    (noteAttributes || [])
      .filter(attr => attr != null && attr.name != null)
      .map(({ name, value }) => [name, value])
  );

  let source = a['utm_source'], medium = a['utm_medium'], campaign = a['utm_campaign'];

  if ((!source || !medium || !campaign) && a['codk_campaign_attribution']) {
    try {
      const codk = JSON.parse(a['codk_campaign_attribution']);
      source = source || codk.utm_source;
      medium = medium || codk.utm_medium;
      campaign = campaign || codk.utm_campaign;
    } catch (_) {}
  }

  if ((!source || !medium || !campaign) && a['_eventSourceUrl']) {
    try {
      const u = new URL(a['_eventSourceUrl']);
      source = source || u.searchParams.get('utm_source');
      medium = medium || u.searchParams.get('utm_medium');
      campaign = campaign || u.searchParams.get('utm_campaign');
    } catch (_) {}
  }

  return {
    utm_source:   (source?.trim()   || '(direct)').toLowerCase(),
    utm_medium:   (medium?.trim()   || '(none)').toLowerCase(),
    utm_campaign: (campaign?.trim() || '(not set)').toLowerCase(),
  };
}

// ─── Order processing (mirrors worker.js logic) ──────────────────────────────────
function processOrders(orders) {
  const seen = new Set();
  const tableMap = {}, tsMap = {};

  for (const order of orders) {
    if (order.id != null) {
      if (seen.has(String(order.id))) continue;
      seen.add(String(order.id));
    }
    const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
    if (!tags.includes('magic')) continue;

    const { utm_source, utm_medium, utm_campaign } = extractUTM(order.note_attributes);
    const revenueP          = Math.round(parseFloat(order.current_total_price || '0') * 100);
    const cancelled         = (order.cancelled_at != null || order.cancel_reason != null) ? 1 : 0;
    const cancelledRevenueP = cancelled ? revenueP : 0;
    const date = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      : '';
    if (!date) continue;

    const tk = `${utm_source}|${utm_medium}|${utm_campaign}`;
    if (!tableMap[tk]) tableMap[tk] = { utm_source, utm_medium, utm_campaign, orders: 0, revenue: 0, cancellations: 0, cancelledRevenue: 0, channel: 'Magic' };
    tableMap[tk].orders          += 1;
    tableMap[tk].revenue         += revenueP;
    tableMap[tk].cancellations   += cancelled;
    tableMap[tk].cancelledRevenue += cancelledRevenueP;

    const sk = `${date}|${utm_source}`;
    if (!tsMap[sk]) tsMap[sk] = { date, utm_source, orders: 0, revenue: 0, cancellations: 0 };
    tsMap[sk].orders        += 1;
    tsMap[sk].revenue       += revenueP;
    tsMap[sk].cancellations += cancelled;
  }

  const rows = Object.values(tableMap)
    .map(r => ({ ...r, revenue: r.revenue / 100, cancelledRevenue: r.cancelledRevenue / 100 }))
    .sort((a, b) => b.orders - a.orders);

  const timeseries = Object.values(tsMap)
    .map(r => ({ ...r, revenue: r.revenue / 100 }))
    .sort((a, b) => a.date < b.date ? -1 : 1);

  return { rows, timeseries, incomplete: false };
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const token = getToken();
  const today = todayIST();
  const cacheDir = path.join(__dirname, '../data/cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const chunks = monthChunks('2026-01', today);
  console.log(`Backfilling ${chunks.length} months from 2026-01-01 to ${today}`);

  for (const { from, to } of chunks) {
    const cacheFile = path.join(cacheDir, `${from}_${to}.json`);
    if (fs.existsSync(cacheFile)) {
      console.log(`[SKIP] ${from} → ${to} (already cached)`);
      continue;
    }
    console.log(`[FETCH] ${from} → ${to}`);
    try {
      const orders = await fetchAllOrders(from, to, token);
      const result = { ...processOrders(orders), fetchedAt: new Date().toISOString() };
      fs.writeFileSync(cacheFile, JSON.stringify(result));
      console.log(`  ✓ Saved: ${result.rows.length} UTM rows, ${result.timeseries.length} timeseries points`);
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
    }
    // Pause between months to avoid rate limit pressure on the store
    if (from !== chunks[chunks.length - 1].from) {
      console.log('  pausing 3s between months…');
      await sleep(3000);
    }
  }

  console.log('\nBackfill complete. Run: node scripts/serve.js');
}

main().catch(err => { console.error(err.message); process.exit(1); });
