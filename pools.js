// GET /api/pools          -> every Orca Whirlpool, scored and ranked
// GET /api/pools?debug=1  -> crawl log, which stats periods arrived, raw first pool + its score
//
// Orca   https://api.orca.so/v2/solana/pools
//        params: size, next (cursor from meta.next), sortBy, sortDirection, minTvl,
//                stats=<comma list from 5m,15m,30m,1h,2h,4h,8h,24h,7d,30d>
//        pool:   { address, liquidity, price (tokenB per tokenA), tvlUsdc, feeRate,
//                  tokenBalanceA/B (RAW integers), adaptiveFeeEnabled, adaptiveFee:{currentRate},
//                  tokenA:{symbol,address,decimals}, tokenB:{...},
//                  stats:{ "<period>":{volume,fees,...} }, priceHistory7d:[ "decimal"|null x14 ] }
// DexScreener  used only for exact pool age and the chart link, never for fees.
//        https://api.dexscreener.com/latest/dex/pairs/solana/<addr,addr,...>
//        -> { pairs:[ { pairAddress, url, pairCreatedAt(ms), priceChange:{m5,h1,h6,h24} } ] }

const ORCA = "https://api.orca.so/v2/solana/pools";
const DS = "https://api.dexscreener.com/latest/dex/pairs/solana/";
const STABLE = new Set(["USDC","USDT","PYUSD","FDUSD","USDS","DAI","USDG","USDE","CASH","EURC","USD1","SUSD"]);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Orca's own fee accounting, at every period it publishes.
const PERIOD_HOURS = { "5m":1/12, "15m":0.25, "30m":0.5, "1h":1, "2h":2, "4h":4, "8h":8, "24h":24, "7d":168, "30d":720 };
const ALL_PERIODS = Object.keys(PERIOD_HOURS).join(",");

/* ---------------- Orca crawl ---------------- */
const CURSOR_KEYS = ["next", "after", "cursor", "page"];

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
  const base = `${ORCA}?size=${size}&stats=${ALL_PERIODS}&sortBy=tvl&sortDirection=desc${minTvl ? `&minTvl=${minTvl}` : ""}`;
  const seen = new Map(), log = [];
  let cursorKey = null;

  const first = await getPage(base);
  first.pools.forEach(p => p?.address && seen.set(p.address, p));
  log.push({ page: 1, got: first.pools.length, total: seen.size, envelope: first.envelope,
             metaKeys: first.metaKeys, statsPeriods: Object.keys(first.pools[0]?.stats || {}) });

  let next = first.next;
  for (let page = 2; page <= maxPages && next; page++) {
    let advanced = false;
    for (const k of (cursorKey ? [cursorKey] : CURSOR_KEYS)) {
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
    if (!advanced) { log.push({ page, stopped: "no new pools from any cursor key" }); break; }
  }
  return { pools: [...seen.values()], log, cursorKey };
}

/* ---------------- DexScreener: age and link only ---------------- */
async function enrich(addresses) {
  const out = new Map(), chunks = [];
  for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));
  for (let i = 0; i < chunks.length; i += 5) {
    await Promise.all(chunks.slice(i, i + 5).map(async group => {
      try {
        const r = await fetch(DS + group.join(","), { headers: { accept: "application/json" } });
        if (!r.ok) return;
        const j = await r.json();
        for (const p of (j?.pairs || [])) if (p?.pairAddress) out.set(p.pairAddress, p);
      } catch { /* a failed chunk only costs those pools their age and link */ }
    }));
  }
  return out;
}

/* ---------------- maths ---------------- */
function volAndAge(series) {
  if (!Array.isArray(series) || !series.length) return { sigma: null, ageDays: null };
  const slots = series.length, hps = (7 * 24) / Math.max(1, slots - 1);
  const p = series.map(num).filter(v => v > 0);
  const ageDays = p.length >= slots ? null : Math.max(0.5, ((p.length - 1) * hps) / 24);
  if (p.length < 4) return { sigma: null, ageDays };
  const r = [];
  for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1);
  return { sigma: Math.sqrt(v) * Math.sqrt(24 / hps), ageDays };
}

// Fallback volatility for pools too young for a 7-day series.
// E|move over T| = sigma_daily * sqrt(T/24) * sqrt(2/pi); invert each window, take the median.
function sigmaFromChanges(pcObj) {
  if (!pcObj) return null;
  const est = [];
  for (const [k, hrs] of [["m5", 5/60], ["h1", 1], ["h6", 6], ["h24", 24]]) {
    const d = Math.abs(num(pcObj[k])) / 100;
    if (d > 0) est.push((d / 0.7979) * Math.sqrt(24 / hrs));
  }
  if (!est.length) return null;
  est.sort((a, b) => a - b);
  const mid = Math.floor(est.length / 2);
  return est.length % 2 ? est[mid] : (est[mid - 1] + est[mid]) / 2;
}

function lPerDollar(P, w) {
  const s = Math.sqrt(P);
  const val = (1 / s - 1 / Math.sqrt(P * (1 + w))) * P + (s - Math.sqrt(P * (1 - w)));
  return val > 0 ? 1 / val : 0;
}
function humanL(rawL, decA, decB) {
  const L = parseFloat(rawL), d = (Number(decA) + Number(decB)) / 2;
  return Number.isFinite(L) && L > 0 && Number.isFinite(d) ? L / Math.pow(10, d) : null;
}

// What one unit of tokenB is worth in dollars, from the pool's own balances.
// Liquidity maths is denominated in tokenB; fees are reported in dollars. Without this
// conversion a SOL-quoted pool overstates its edge by roughly the SOL price.
function quoteUsd(pool, price) {
  const decA = Number(pool.tokenA?.decimals), decB = Number(pool.tokenB?.decimals);
  const ba = parseFloat(pool.tokenBalanceA), bb = parseFloat(pool.tokenBalanceB);
  const tvl = num(pool.tvlUsdc);
  if (![decA, decB, ba, bb].every(Number.isFinite) || !(tvl > 0) || !(price > 0)) return null;
  const valueInB = (ba / 10 ** decA) * price + (bb / 10 ** decB);
  if (!(valueInB > 0)) return null;
  const q = tvl / valueInB;
  return Number.isFinite(q) && q > 0 ? q : null;
}

function score(pool, ds, tfKey, holdDays) {
  const stats = pool.stats || {};
  const tvl = num(pool.tvlUsdc), price = num(pool.price);
  const s24 = stats["24h"] || {}, s7 = stats["7d"] || {}, s30 = stats["30d"] || {};
  const A = pool.tokenA || {}, B = pool.tokenB || {};
  const stableA = STABLE.has((A.symbol || "").toUpperCase()), stableB = STABLE.has((B.symbol || "").toUpperCase());

  const ov = volAndAge(pool.priceHistory7d);
  const dsSigma = sigmaFromChanges(ds?.priceChange);
  const sigma = ov.sigma !== null && ov.ageDays === null ? ov.sigma : (ov.sigma ?? dsSigma);
  const sigmaSrc = ov.sigma !== null ? "orca7d" : (dsSigma !== null ? "dexscreener" : null);
  const created = ds?.pairCreatedAt ? Number(ds.pairCreatedAt) : null;
  const ageDays = created ? Math.max(0, (Date.now() - created) / 864e5) : ov.ageDays;

  // Fees per day over the chosen period, straight from Orca's own accounting.
  const want = stats[tfKey], haveTf = !!(want && want.fees !== undefined);
  const useKey = haveTf ? tfKey : (stats["24h"] ? "24h" : "7d");
  const useHours = PERIOD_HOURS[useKey] ?? 24;
  const used = stats[useKey] || {};
  const feesPerDay = num(used.fees) * (24 / useHours);
  const windowVol = num(used.volume);

  const rate = (pool.adaptiveFeeEnabled && pool.adaptiveFee?.currentRate != null
    ? num(pool.adaptiveFee.currentRate) : num(pool.feeRate)) / 1e6;

  const qUsd = stableB ? 1 : quoteUsd(pool, price);
  const L = humanL(pool.liquidity, A.decimals, B.decimals);
  const feePerL = L ? feesPerDay / L : null;                    // dollars per unit of liquidity
  const costPerL = (sigma !== null && price > 0 && qUsd)
    ? (sigma * sigma * Math.sqrt(price) / 4) * qUsd : null;     // converted to dollars too

  const yTvl = tvl > 0 ? feesPerDay / tvl : 0;
  const edgeTvl = sigma !== null && sigma > 0 ? yTvl / ((sigma * sigma) / 8) : null;

  let basis = "liquidity";
  let edge = feePerL !== null && costPerL ? feePerL / costPerL : null;
  // A pool's concentration lifts the liquidity-basis figure above the full-range one, but
  // only by a sane multiple. Anything wilder means the liquidity or balance data is off.
  const ratio = edge !== null && edgeTvl ? edge / edgeTvl : null;
  if (edge === null || !Number.isFinite(edge) || (ratio !== null && (ratio > 100 || ratio < 0.01))) {
    edge = edgeTvl; basis = "tvl";
  }

  const width = sigma !== null ? Math.max(0.08, Math.min(0.85, 1.5 * sigma * Math.sqrt(holdDays))) : null;
  let earns = null, needs = null, netDay = null;
  if (width && price > 0 && sigma !== null) {
    const lp = lPerDollar(price, width);
    if (basis === "liquidity") {
      // lp is liquidity per ONE QUOTE TOKEN of position value, not per dollar, so both
      // sides divide by the quote token's dollar price to become a yield on dollars.
      earns = feePerL * lp / qUsd; needs = costPerL * lp / qUsd;
    } else {
      const k = lp / lPerDollar(price, 0.5);                    // full-range-equivalent scaling
      earns = yTvl * k; needs = ((sigma * sigma) / 8) * k;
    }
    netDay = earns - needs;
  }

  const y24 = tvl > 0 ? num(s24.fees) / tvl : 0;
  const y7 = tvl > 0 ? num(s7.fees) / 7 / tvl : 0;
  const y30 = tvl > 0 ? num(s30.fees) / 30 / tvl : 0;

  return {
    address: pool.address,
    pair: `${A.symbol || "?"}/${B.symbol || "?"}`,
    base: stableA && !stableB ? B.symbol : A.symbol,
    quote: stableA && !stableB ? A.symbol : B.symbol,
    bothVolatile: !stableA && !stableB,
    stablePair: stableA && stableB,
    feeRate: rate * 100,
    adaptiveFee: !!pool.adaptiveFeeEnabled,
    price, quoteUsd: qUsd, tvl,
    vol24: num(s24.volume), windowVol, haveTf, usedPeriod: useKey,
    volOverTvl: tvl > 0 ? num(s24.volume) / tvl : 0,
    yield24: y24, yield7d: y7, yield30d: y30,
    trend: (y7 > 0 && y30 > 0) ? y7 / y30 : null,
    spike: (y7 > 0 && y24 > 3 * y7),
    sigma, sigmaSrc, created, ageDays,
    edge, edgeTvl, basis, width, earns, needs, netDay,
    netPer1k: netDay !== null ? netDay * 1000 : null,
    dsUrl: ds?.url || null, onDs: !!ds
  };
}

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
  try {
    const hold = Math.max(1, Math.min(365, num(q.hold) || 30));
    const tfKey = PERIOD_HOURS[q.tf] ? q.tf : "24h";
    const { pools: raw, log, cursorKey } = await crawl({
      size: Math.max(50, Math.min(1000, num(q.size) || 500)),
      maxPages: Math.max(1, Math.min(60, num(q.maxPages) || 40)),
      minTvl: num(q.minTvl) || 0
    });
    if (!raw.length) return res.status(502).json({ error: "No pools returned", log });

    const dsMap = q.nods ? new Map() : await enrich(raw.map(p => p.address).filter(Boolean));

    if (q.debug) {
      const a = raw[0];
      return res.json({
        scanned: raw.length, cursorKey, log,
        statsPeriodsReturned: Object.keys(a?.stats || {}),
        periodsRequested: ALL_PERIODS,
        dexscreenerMatched: dsMap.size,
        timeframe: tfKey,
        firstPool: a, scored: score(a, dsMap.get(a.address), tfKey, hold)
      });
    }

    const pools = raw.map(p => score(p, dsMap.get(p.address), tfKey, hold)).filter(p => !p.stablePair);
    pools.sort((a, b) => (b.netDay ?? -1e9) - (a.netDay ?? -1e9));
    res.json({
      at: Date.now(), scanned: raw.length, returned: pools.length, cursorKey,
      pages: log.length, timeframe: tfKey,
      periodsAvailable: Object.keys(raw[0]?.stats || {}),
      dexscreenerMatched: dsMap.size, pools
    });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
};
module.exports._test = { volAndAge, sigmaFromChanges, lPerDollar, humanL, quoteUsd, score, PERIOD_HOURS };
