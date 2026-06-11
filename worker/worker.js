export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (origin !== env.ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (origin !== env.ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 });

    const url     = new URL(request.url);
    const from    = url.searchParams.get('from') || '';
    const to      = url.searchParams.get('to')   || '';
    const refresh = url.searchParams.get('refresh') === '1';

    if (!isDate(from) || !isDate(to))
      return jsonResp({ error: 'from and to must be YYYY-MM-DD' }, 400, origin);
    if (from > to)
      return jsonResp({ error: 'from must be before or equal to to' }, 400, origin);
    if (from < '2026-04-01')
      return jsonResp({ error: 'Data is only available from 2026-04-01' }, 400, origin);

    if (url.searchParams.get('format') === 'lineitem') {
      const allOrders = [];
      for (const chunk of monthChunks(from, to)) {
        let orders;
        try {
          orders = await fetchAllOrders(chunk.from, chunk.to, env.SHOPIFY_ADMIN_TOKEN,
            'id,tags,note_attributes,created_at,line_items,total_tax,refunds');
        } catch (err) {
          return jsonResp({ error: err.message }, 502, origin);
        }
        allOrders.push(...orders);
      }
      return jsonResp(processLineItems(allOrders), 200, origin);
    }

    const curMonthStart = firstOfMonth(todayStr());
    const chunks = monthChunks(from, to);
    const chunkResults = [];

    for (const chunk of chunks) {
      const isCurrentMonth = chunk.to >= curMonthStart;
      const chunkKey = `glen-india:chunk:${chunk.from}:${chunk.to}`;

      // Historical chunks: always serve from cache
      // Current month: re-fetch only when refresh=1
      const skipCache = refresh && isCurrentMonth;

      if (!skipCache) {
        const cached = await env.GLEN_INDIA_CACHE.get(chunkKey);
        if (cached) {
          try { chunkResults.push({ ...JSON.parse(cached), _cached: true }); continue; } catch (_) {}
        }
      }

      // Read existing cached value BEFORE fetching so we can compare order counts
      let prevResult = null;
      if (skipCache) {
        const prev = await env.GLEN_INDIA_CACHE.get(chunkKey);
        if (prev) { try { prevResult = JSON.parse(prev); } catch (_) {} }
      }

      let orders;
      try {
        orders = await fetchAllOrders(chunk.from, chunk.to, env.SHOPIFY_ADMIN_TOKEN);
      } catch (err) {
        return jsonResp({ error: err.message, incomplete: true }, 502, origin);
      }

      const chunkResult = { ...processOrders(orders), fetchedAt: new Date().toISOString() };

      // Keep old fetchedAt if order count unchanged (timestamp = when data last changed)
      if (prevResult) {
        const oldTotal = prevResult.rows?.reduce((s, r) => s + r.orders, 0) || 0;
        const newTotal = chunkResult.rows.reduce((s, r) => s + r.orders, 0);
        if (oldTotal === newTotal) chunkResult.fetchedAt = prevResult.fetchedAt;
      }

      const ttl = isCurrentMonth ? 3600 : 7 * 86400;
      await env.GLEN_INDIA_CACHE.put(chunkKey, JSON.stringify(chunkResult), { expirationTtl: ttl });
      chunkResults.push(chunkResult);
    }

    return jsonResp(mergeChunkResults(chunkResults), 200, origin);
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

function firstOfMonth(dateStr) {
  return dateStr.slice(0, 8) + '01';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Month-chunk helpers ───────────────────────────────────────────────────────

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
      if (!tableMap[tk]) {
        tableMap[tk] = { utm_source: row.utm_source, utm_medium: row.utm_medium,
          utm_campaign: row.utm_campaign, utm_content: row.utm_content||'', utm_term: row.utm_term||'',
          orders: 0, revenue: 0, cancellations: 0, cancelledRevenue: 0, channel: 'Magic' };
      }
      tableMap[tk].orders          += row.orders;
      tableMap[tk].revenue         += row.revenue;
      tableMap[tk].cancellations   += row.cancellations;
      tableMap[tk].cancelledRevenue += (row.cancelledRevenue || 0);
    }

    for (const pt of (result.timeseries || [])) {
      const sk = `${pt.date}|${pt.utm_source}`;
      if (!tsMap[sk]) tsMap[sk] = { date: pt.date, utm_source: pt.utm_source, orders: 0, revenue: 0, cancellations: 0 };
      tsMap[sk].orders        += pt.orders;
      tsMap[sk].revenue       += pt.revenue;
      tsMap[sk].cancellations += pt.cancellations;
    }
  }

  return {
    rows:       Object.values(tableMap).sort((a, b) => b.orders - a.orders),
    timeseries: Object.values(tsMap).sort((a, b) => a.date < b.date ? -1 : 1),
    fetchedAt:  fetchedAt || new Date().toISOString(),
    incomplete: false,
  };
}

// ─── Shopify pagination ────────────────────────────────────────────────────────

async function fetchAllOrders(from, to, token, fields) {
  if (!fields) fields = 'id,tags,note_attributes,current_total_price,total_price,cancelled_at,cancel_reason,created_at';
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
    const limitHdr = resp.headers.get('X-Shopify-Shop-Api-Call-Limit') || '';
    if (parseInt(limitHdr.split('/')[0], 10) >= 35) await sleep(500);
    nextUrl = parseNextLink(resp.headers.get('Link'));
  }
  return all;
}

async function fetchWithBackoff(url, token, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (resp.status !== 429) {
      if (!resp.ok) { await resp.body?.cancel(); throw new Error(`Shopify API returned ${resp.status}`); }
      return resp;
    }
    await sleep(1000 * Math.pow(2, i));
  }
  throw new Error('Shopify rate limit exceeded — try again in a few seconds');
}

function parseNextLink(header) {
  if (!header) return null;
  const m = header.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

// ─── UTM extraction ────────────────────────────────────────────────────────────

function isNumericId(s) { return s && /^\d+$/.test(s.trim()); }

function extractUTM(noteAttributes) {
  const a = Object.fromEntries(
    (noteAttributes || [])
      .filter(attr => attr != null && attr.name != null)
      .map(({ name, value }) => [name, value])
  );
  let source = a['utm_source'], medium = a['utm_medium'], campaign = a['utm_campaign'];
  let content = a['utm_content'], term = a['utm_term'];

  // Parse codk once — it captures the readable campaign name set at ad click time
  let codk = null;
  if (a['codk_campaign_attribution']) {
    try { codk = JSON.parse(a['codk_campaign_attribution']); } catch (_) {}
  }

  // When utm_campaign is a bare numeric ID (Google/Meta campaign ID like "21997516765"),
  // the direct param is not human-readable. Prefer the full codk tuple which has the
  // readable campaign name (e.g. "DR_Old_Search_Brand_MaxConvValue_AllProducts_24April2023").
  if (codk && isNumericId(campaign) && codk.utm_campaign && !isNumericId(codk.utm_campaign)) {
    source   = codk.utm_source   || source;
    medium   = codk.utm_medium   || medium;
    campaign = codk.utm_campaign;
    content  = content  || codk.utm_content;
    term     = term     || codk.utm_term;
  }

  // Standard fallback: fill in any missing fields from codk
  if (codk && (!source || !medium || !campaign)) {
    source   = source   || codk.utm_source;
    medium   = medium   || codk.utm_medium;
    campaign = campaign || codk.utm_campaign;
    content  = content  || codk.utm_content;
    term     = term     || codk.utm_term;
  }

  // Last resort: _eventSourceUrl query params
  if ((!source || !medium || !campaign) && a['_eventSourceUrl']) {
    try {
      const u = new URL(a['_eventSourceUrl']);
      source   = source   || u.searchParams.get('utm_source');
      medium   = medium   || u.searchParams.get('utm_medium');
      campaign = campaign || u.searchParams.get('utm_campaign');
      content  = content  || u.searchParams.get('utm_content');
      term     = term     || u.searchParams.get('utm_term');
    } catch (_) {}
  }

  return {
    utm_source:   (source?.trim()   || '(direct)').toLowerCase(),
    utm_medium:   (medium?.trim()   || '(none)').toLowerCase(),
    utm_campaign: (campaign?.trim() || '(not set)').toLowerCase(),
    utm_content:  (content?.trim()  || '').toLowerCase(),
    utm_term:     (term?.trim()     || '').toLowerCase(),
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
    const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
    if (!tags.includes('magic')) continue;
    const { utm_source, utm_medium, utm_campaign, utm_content, utm_term } = extractUTM(order.note_attributes);
    const month = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7)
      : '';
    if (!month) continue;
    const lineItems = order.line_items || [];
    const numItems  = Math.max(lineItems.length, 1);
    const totalTaxP = Math.round(parseFloat(order.total_tax || '0') * 100);

    // Build a refund map: line_item_id → { returnAmountP, returnQty }
    const refundMap = {};
    for (const refund of (order.refunds || [])) {
      for (const rli of (refund.refund_line_items || [])) {
        const lid = String(rli.line_item_id);
        if (!refundMap[lid]) refundMap[lid] = { returnAmountP: 0, returnQty: 0 };
        refundMap[lid].returnAmountP += Math.round(parseFloat(rli.subtotal || '0') * 100);
        refundMap[lid].returnQty     += rli.quantity || 0;
      }
    }

    for (const item of lineItems) {
      const productType  = item.product_type || '';
      const productTitle = item.title || '';
      const qty    = item.quantity || 1;
      const grossP = Math.round(parseFloat(item.price || '0') * qty * 100);
      const discP  = Math.round(parseFloat(item.total_discount || '0') * 100);
      const taxP   = Math.round(totalTaxP / numItems);
      const ref    = refundMap[String(item.id)] || { returnAmountP: 0, returnQty: 0 };
      const rk = `${utm_source}|${utm_medium}|${utm_campaign}|${utm_content}|${utm_term}|${productType}|${productTitle}|${month}`;
      if (!rowMap[rk]) {
        rowMap[rk] = { utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          product_type: productType, product_title: productTitle, month,
          _ids: new Set(), grossP: 0, discP: 0, taxP: 0, returnP: 0, netItems: 0 };
      }
      rowMap[rk]._ids.add(String(order.id));
      rowMap[rk].grossP   += grossP;
      rowMap[rk].discP    += discP;
      rowMap[rk].taxP     += taxP;
      rowMap[rk].returnP  += ref.returnAmountP;
      rowMap[rk].netItems += qty;
    }
  }
  return Object.values(rowMap).map(({ _ids, grossP, discP, taxP, returnP, netItems, ...r }) => {
    const gross   = grossP / 100, disc = discP / 100, tax = taxP / 100;
    const returns = returnP / 100;
    const net     = gross - disc - returns;
    return { ...r, orders: _ids.size,
      gross_sales: round2(gross), discounts: round2(disc), returns: round2(returns),
      net_sales: round2(net), shipping: 0, duties: 0, additional_fees: 0,
      taxes: round2(tax), total_sales: round2(net + tax), net_items: netItems };
  });
}

// ─── Order processing ──────────────────────────────────────────────────────────

function processOrders(orders) {
  const seen = new Set();
  const tableMap = {}, tsMap = {};

  for (const order of orders) {
    // Deduplicate by order ID (safety net against API pagination edge cases)
    if (order.id != null) {
      if (seen.has(String(order.id))) continue;
      seen.add(String(order.id));
    }

    const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
    if (!tags.includes('magic')) continue;

    const { utm_source, utm_medium, utm_campaign, utm_content, utm_term } = extractUTM(order.note_attributes);
    const revenueP         = Math.round(parseFloat(order.current_total_price || '0') * 100);
    const cancelled        = (order.cancelled_at != null || order.cancel_reason != null) ? 1 : 0;
    const origRevenueP     = Math.round(parseFloat(order.total_price || order.current_total_price || '0') * 100);
    const cancelledRevenueP = cancelled ? origRevenueP : 0;
    const date = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      : '';
    if (!date) continue;

    const tk = `${utm_source}|${utm_medium}|${utm_campaign}|${utm_content}|${utm_term}`;
    if (!tableMap[tk]) tableMap[tk] = { utm_source, utm_medium, utm_campaign, utm_content, utm_term, orders: 0, revenue: 0, cancellations: 0, cancelledRevenue: 0, channel: 'Magic' };
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
