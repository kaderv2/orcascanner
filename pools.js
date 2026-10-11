// GET /api/pools          -> every Orca Whirlpool, scored and ranked
// GET /api/pools?debug=1  -> what the crawler found: page sizes, cursor keys, envelope shape
//
// Orca schema (observed at https://api.orca.so/v2/solana/pools):
//   { data: [ { address, liquidity, price, tvlUsdc, feeRate, adaptiveFeeEnabled,
//               tokenA:{symbol,address,decimals}, tokenB:{...},
//               stats:{ "24h":{volume,fees}, "7d":{...}, "30d":{...} },
//               priceHistory7d:[ "decimal" | null, ... 14 slots, 12h apart ] } ],
//     meta?: { next, previous } }

const SRC = "https://api.orca.so/v2/solana/pools";
const STABLE = new Set(["USDC","USDT","PYUSD","FDUSD","USDS","DAI","USDG","USDE","CASH","EURC","USD1","SUSD"]);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/* ---------------- crawling ---------------- */
// The cursor parameter name isn't documented, so try the usual ones and keep
// whichever actually advances the list.
const CURSOR_KEYS = ["after", "cursor", "next", "page"];

async function getPage(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Orca returned ${r.status}`);
  const j = await r.json();
  return {
    pools: Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [],
    next: j?.meta?.next ?? j?.next ?? null,
    envelope: Object.keys(j || {}),
    metaKeys: j?.meta ? Object.keys(j.meta) : null
  };
}

async function crawl({ size = 500, maxPages = 40, minTvl = 0 } = {}) {
  const base = `${SRC}?size=${size}&sortBy=tvl&sortDirection=desc${minTvl ? `&minTvl=${minTvl}` : ""}`;
  const seen = new Map();
  const log = [];
  let cursorKey = null;

  const first = await getPage(base);
  first.pools.forEach(p => p?.address && seen.set(p.address, p));
  log.push({ page: 1, got: first.pools.length, total: seen.size, envelope: first.envelope, metaKeys: first.metaKeys, next: first.next ? String(first.next).slice(0, 24) : null });

  let next = first.next;
  for (let page = 2; page <= maxPages && next; page++) {
    let advanced = false;
    // On the first paged request, work out which parameter name the cursor uses.
    const keys = cursorKey ? [cursorKey] : CURSOR_KEYS;
    for (const k of keys) {
      let pg;
      try { pg = await getPage(`${base}&${k}=${encodeURIComponent(next)}`); } catch { continue; }
      const before = seen.size;
      pg.pools.forEach(p => p?.address && seen.set(p.address, p));
      if (seen.size > before) {
        cursorKey = k; advanced = true; next = pg.next;
        log.push({ page, key: k, got: pg.pools.length, added: seen.size - before, total: seen.size });
        break;
      }
    }
    if (!advanced) { log.push({ page, stopped: "no new pools from any cursor key", triedKeys: keys }); break; }
  }
  return { pools: [...seen.values()], log, cursorKey };
}

/* ---------------- maths ---------------- */
// Daily volatility from the pool's own 7-day price series.
function volAndAge(series) {
  if (!Array.isArray(series) || !series.length) return { sigma: null, ageDays: null };
  const slots = series.length;                       // normally 14 slots across 7 days
  const hoursPerSlot = (7 * 24) / Math.max(1, slots - 1);
  const p = series.map(num).filter(v => v > 0);
  const ageDays = p.length >= slots ? null           // full history: at least 7 days old
    : Math.max(0.5, ((p.length - 1) * hoursPerSlot) / 24);
  if (p.length < 4) return { sigma: null, ageDays };
  const r = [];
  for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1);
  const sigma = Math.sqrt(v) * Math.sqrt(24 / hoursPerSlot);
  return { sigma, ageDays };
}

// Liquidity per $1 of position value for a ±w range at price P.
function lPerDollar(P, w) {
  const s = Math.sqrt(P);
  const val = (1 / s - 1 / Math.sqrt(P * (1 + w))) * P + (s - Math.sqrt(P * (1 - w)));
  return val > 0 ? 1 / val : 0;
}

function humanL(rawL, decA, decB) {
  const L = parseFloat(rawL);
  const d = (Number(decA) + Number(decB)) / 2;
  return Number.isFinite(L) && L > 0 && Number.isFinite(d) ? L / Math.pow(10, d) : null;
}

function score(pool, holdDays) {
  const tvl = num(pool.tvlUsdc);
  const s24 = pool.stats?.["24h"] || {}, s7 = pool.stats?.["7d"] || {}, s30 = pool.stats?.["30d"] || {};
  const fees24 = num(s24.fees), fees7 = num(s7.fees), fees30 = num(s30.fees);
  const vol24 = num(s24.volume), vol7 = num(s7.volume), vol30 = num(s30.volume);
  const price = num(pool.price);
  const { sigma, ageDays } = volAndAge(pool.priceHistory7d);

  const A = pool.tokenA || {}, B = pool.tokenB || {};
  const symA = (A.symbol || "?").toUpperCase(), symB = (B.symbol || "?").toUpperCase();
  const stableA = STABLE.has(symA), stableB = STABLE.has(symB);

  // Income and the cost of price movement both scale with how concentrated the
  // liquidity is, so working per unit of liquidity makes the ratio range-free.
  const L = humanL(pool.liquidity, A.decimals, B.decimals);
  let feePerL = L ? (fees7 > 0 ? fees7 / 7 : fees24) / L : null;
  let costPerL = sigma !== null && price > 0 ? (sigma * sigma * Math.sqrt(price)) / 4 : null;
  let basis = "liquidity";
  let edge = feePerL !== null && costPerL ? feePerL / costPerL : null;
  if (edge === null || !Number.isFinite(edge) || edge > 1000) {
    const y = tvl > 0 ? (fees7 > 0 ? fees7 / 7 : fees24) / tvl : 0;
    edge = sigma !== null && sigma > 0 ? y / ((sigma * sigma) / 8) : null;
    basis = "tvl";
    feePerL = null;
  }

  // Set-and-forget width: about 1.5 standard deviations of a move over the hold.
  const width = sigma !== null ? Math.max(0.08, Math.min(0.85, 1.5 * sigma * Math.sqrt(holdDays))) : null;

  let earns = null, needs = null, netDay = null;
  if (width && price > 0 && sigma !== null) {
    const lp = lPerDollar(price, width);
    needs = costPerL !== null ? costPerL * lp : null;
    earns = basis === "liquidity" && feePerL !== null
      ? feePerL * lp
      : (tvl > 0 ? ((fees7 > 0 ? fees7 / 7 : fees24) / tvl) * (lp / lPerDollar(price, 0.5)) : null);
    if (earns !== null && needs !== null) netDay = earns - needs;
  }

  // Is the fee income steady or a one-off spike?
  const y24 = tvl > 0 ? fees24 / tvl : 0;
  const y7 = tvl > 0 ? fees7 / 7 / tvl : 0;
  const y30 = tvl > 0 ? fees30 / 30 / tvl : 0;
  let trend = null, spike = false;
  if (y7 > 0 && y30 > 0) trend = y7 / y30;
  if (y7 > 0 && y24 > 3 * y7) spike = true;

  return {
    address: pool.address,
    pair: `${A.symbol || "?"}/${B.symbol || "?"}`,
    base: stableA && !stableB ? B.symbol : A.symbol,
    quote: stableA && !stableB ? A.symbol : B.symbol,
    bothVolatile: !stableA && !stableB,
    stablePair: stableA && stableB,
    feeRate: num(pool.feeRate) / 10000,
    adaptiveFee: !!pool.adaptiveFeeEnabled,
    price, tvl, vol24,
    volOverTvl: tvl > 0 ? vol24 / tvl : 0,
    yield24: y24, yield7d: y7, yield30d: y30,
    trend, spike,
    sigma, ageDays, isNew: ageDays !== null,
    edge, basis, width, earns, needs, netDay,
    // dollars a $1,000 position would net per day at the suggested range
    netPer1k: netDay !== null ? netDay * 1000 : null
  };
}

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  res.setHeader("cache-control", "s-maxage=180, stale-while-revalidate=900");
  try {
    const hold = Math.max(1, Math.min(365, num(q.hold) || 30));
    const { pools: raw, log, cursorKey } = await crawl({
      size: Math.max(50, Math.min(1000, num(q.size) || 500)),
      maxPages: Math.max(1, Math.min(60, num(q.maxPages) || 40)),
      minTvl: num(q.minTvl) || 0
    });
    if (!raw.length) return res.status(502).json({ error: "No pools returned", log });
    if (q.debug) return res.json({ scanned: raw.length, cursorKey, log, firstPool: raw[0], scored: score(raw[0], hold) });

    const pools = raw.map(p => score(p, hold)).filter(p => !p.stablePair);
    pools.sort((a, b) => (b.netDay ?? -1e9) - (a.netDay ?? -1e9));
    res.json({ at: Date.now(), scanned: raw.length, returned: pools.length, cursorKey, pages: log.length, pools });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
};
module.exports._test = { volAndAge, lPerDollar, humanL, score, crawl };
