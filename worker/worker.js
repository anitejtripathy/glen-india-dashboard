export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      if (origin !== env.ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Origin guard — only respond to the configured GitHub Pages URL
    if (origin !== env.ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    const url  = new URL(request.url);
    const from = url.searchParams.get('from') || '';
    const to   = url.searchParams.get('to')   || '';

    if (!isDate(from) || !isDate(to)) {
      return jsonResp({ error: 'from and to must be YYYY-MM-DD' }, 400, origin);
    }
    if (from > to) {
      return jsonResp({ error: 'from must be before or equal to to' }, 400, origin);
    }
    if (from < '2026-01-01') {
      return jsonResp({ error: 'Data is only available from 2026-01-01' }, 400, origin);
    }

    // KV cache check
    const refresh  = url.searchParams.get('refresh') === '1';
    const cacheKey = `glen-india:${from}:${to}`;
    if (!refresh) {
      const cached = await env.GLEN_INDIA_CACHE.get(cacheKey);
      if (cached) return jsonResp(cached, 200, origin, true);
    }

    // Fetch from Shopify
    let orders;
    try {
      orders = await fetchAllOrders(from, to, env.SHOPIFY_ADMIN_TOKEN);
    } catch (err) {
      return jsonResp({ error: err.message, incomplete: true }, 502, origin);
    }

    const result = { ...processOrders(orders), fetchedAt: new Date().toISOString() };
    // Historical ranges cache for 24h; ranges including today cache for 1h
    const ttl = to >= todayStr() ? 3600 : 86400;
    await env.GLEN_INDIA_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl });

    return jsonResp(result, 200, origin);
  },
};

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(body, status, origin, raw = false) {
  return new Response(raw ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Shopify pagination ────────────────────────────────────────────────────────

async function fetchAllOrders(from, to, token) {
  const fields  = 'id,tags,note_attributes,current_total_price,cancelled_at,cancel_reason,created_at';
  const baseUrl = 'https://glen-india.myshopify.com/admin/api/2024-10/orders.json';
  let nextUrl   = `${baseUrl}?tag=Magic`
    + `&created_at_min=${from}T00:00:00%2B05:30`
    + `&created_at_max=${to}T23:59:59%2B05:30`
    + `&status=any&limit=250&fields=${fields}`;

  const all = [];

  while (nextUrl) {
    const resp = await fetchWithBackoff(nextUrl, token);
    const data = await resp.json();
    all.push(...(data.orders || []));

    // Throttle when near the 40-call bucket limit
    const limitHdr = resp.headers.get('X-Shopify-Shop-Api-Call-Limit') || '';
    const used     = parseInt(limitHdr.split('/')[0], 10);
    if (used >= 35) await sleep(500);

    nextUrl = parseNextLink(resp.headers.get('Link'));
  }

  return all;
}

async function fetchWithBackoff(url, token, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (resp.status !== 429) {
      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`Shopify API returned ${resp.status}`);
      }
      return resp;
    }
    await sleep(1000 * Math.pow(2, i)); // 1s, 2s, 4s
  }
  throw new Error('Shopify rate limit exceeded — try again in a few seconds');
}

function parseNextLink(header) {
  if (!header) return null;
  const m = header.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

// ─── UTM extraction ────────────────────────────────────────────────────────────

function extractUTM(noteAttributes) {
  // Build a flat key→value map from note_attributes array
  const a = Object.fromEntries(
    (noteAttributes || [])
      .filter(attr => attr != null && attr.name != null)
      .map(({ name, value }) => [name, value])
  );

  let source   = a['utm_source'];
  let medium   = a['utm_medium'];
  let campaign = a['utm_campaign'];

  // Fallback 1: codk_campaign_attribution JSON blob
  if ((!source || !medium || !campaign) && a['codk_campaign_attribution']) {
    try {
      const codk = JSON.parse(a['codk_campaign_attribution']);
      source   = source   || codk.utm_source;
      medium   = medium   || codk.utm_medium;
      campaign = campaign || codk.utm_campaign;
    } catch (_) {}
  }

  // Fallback 2: _eventSourceUrl query params
  if ((!source || !medium || !campaign) && a['_eventSourceUrl']) {
    try {
      const u = new URL(a['_eventSourceUrl']);
      source   = source   || u.searchParams.get('utm_source');
      medium   = medium   || u.searchParams.get('utm_medium');
      campaign = campaign || u.searchParams.get('utm_campaign');
    } catch (_) {}
  }

  return {
    utm_source:   (source   || '(direct)').toLowerCase(),
    utm_medium:   (medium   || '(none)').toLowerCase(),
    utm_campaign: (campaign || '(not set)').toLowerCase(),
  };
}

// ─── Order processing ──────────────────────────────────────────────────────────

function processOrders(orders) {
  const tableMap = {};
  const tsMap    = {};

  for (const order of orders) {
    // Re-validate Magic tag (API pre-filters, but guard against edge cases)
    const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
    if (!tags.includes('magic')) continue;

    const { utm_source, utm_medium, utm_campaign } = extractUTM(order.note_attributes);
    const revenueP  = Math.round(parseFloat(order.current_total_price || '0') * 100);
    const cancelled = (order.cancelled_at != null || order.cancel_reason != null) ? 1 : 0;
    const date = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      : '';
    if (!date) continue;

    // Table aggregation: group by source + medium + campaign
    const tk = `${utm_source}|${utm_medium}|${utm_campaign}`;
    if (!tableMap[tk]) {
      tableMap[tk] = { utm_source, utm_medium, utm_campaign, orders: 0, revenue: 0, cancellations: 0, channel: 'Magic' };
    }
    tableMap[tk].orders        += 1;
    tableMap[tk].revenue       += revenueP;
    tableMap[tk].cancellations += cancelled;

    // Timeseries aggregation: group by date + source
    const sk = `${date}|${utm_source}`;
    if (!tsMap[sk]) {
      tsMap[sk] = { date, utm_source, orders: 0, revenue: 0, cancellations: 0 };
    }
    tsMap[sk].orders        += 1;
    tsMap[sk].revenue       += revenueP;
    tsMap[sk].cancellations += cancelled;
  }

  const rows = Object.values(tableMap)
    .map(r => ({ ...r, revenue: r.revenue / 100 }))
    .sort((a, b) => b.orders - a.orders);

  const timeseries = Object.values(tsMap)
    .map(r => ({ ...r, revenue: r.revenue / 100 }))
    .sort((a, b) => a.date < b.date ? -1 : 1);

  return { rows, timeseries, incomplete: false };
}
