// GET /api/pools          -> every Orca Whirlpool, enriched with DexScreener, scored and ranked
// GET /api/pools?debug=1  -> crawl log, cursor key, DexScreener match rate, raw first pool
//
// Sources
//   Orca   https://api.orca.so/v2/solana/pools
//          { data:[ { address, liquidity, price, tvlUsdc, feeRate, adaptiveFeeEnabled,
//                     tokenA:{symbol,address,decimals}, tokenB:{...},
//                     stats:{ "24h":{volume,fees}, "7d":{...}, "30d":{...} },
//                     priceHistory7d:[ "decimal"|null x14 ] } ], meta?:{next,previous} }
//   DexScreener https://api.dexscreener.com/latest/dex/pairs/solana/<addr,addr,...>
//          { pairs:[ { pairAddress, url, pairCreatedAt(ms),
//                      volume:{m5,h1,h6,h24}, priceChange:{m5,h1,h6,h24}(percent),
//                      txns:{m5:{buys,sells},...}, liquidity:{usd} } ] }

const ORCA = "https://api.orca.so/v2/solana/pools";
const DS = "https://api.dexscreener.com/latest/dex/pairs/solana/";
const STABLE = new Set(["USDC","USDT","PYUSD","FDUSD","USDS","DAI","USDG","USDE","CASH","EURC","USD1","SUSD"]);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Timeframes. Orca only publishes 24h/7d/30d; the short windows come from DexScreener,
// which offers exactly m5, h1, h6 and h24 — there is no 4h or 12h window to read.
const TF = {
  m5:  { hours: 5 / 60, src: "ds",   label: "5 min" },
  h1:  { hours: 1,      src: "ds",   label: "1 hour" },
  h6:  { hours: 6,      src: "ds",   label: "6 hours" },
  h24: { hours: 24,     src: "ds",   label: "24 hours" },
  d7:  { hours: 168,    src: "orca", label: "7 days" }
};

/* ---------------- Orca crawl ---------------- */
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
  const base = `${ORCA}?size=${size}&sortBy=tvl&sortDirection=desc${minTvl ? `&minTvl=${minTvl}` : ""}`;
  const seen = new Map(), log = [];
  let cursorKey = null;

  const first = await getPage(base);
  first.pools.forEach(p => p?.address && seen.set(p.address, p));
  log.push({ page: 1, got: first.pools.length, total: seen.size, envelope: first.envelope, metaKeys: first.metaKeys });

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

/* ---------------- DexScreener enrichment ---------------- */
async function enrich(addresses) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));

  const CONC = 5;
  for (let i = 0; i < chunks.length; i += CONC) {
    const batch = chunks.slice(i, i + CONC).map(async group => {
      try {
        const r = await fetch(DS + group.join(","), { headers: { accept: "application/json" } });
        if (!r.ok) return;
        const j = await r.json();
        for (const p of (j?.pairs || [])) if (p?.pairAddress) out.set(p.pairAddress, p);
      } catch { /* a failed chunk just means those pools keep Orca-only data */ }
    });
    await Promise.all(batch);
  }
  return out;
}

/* ---------------- maths ---------------- */
// Daily volatility from Orca's 7-day series, plus the pool's age when the series is short.
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

// Daily volatility implied by DexScreener's price changes.
// E|move| over T hours = sigma_daily * sqrt(T/24) * sqrt(2/pi), so invert each window
// and take the median — one window on its own is very noisy.
function sigmaFromChanges(pcObj) {
  if (!pcObj) return null;
  const est = [];
  for (const [k, hrs] of [["m5", 5 / 60], ["h1", 1], ["h6", 6], ["h24", 24]]) {
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

function score(pool, ds, tfKey, holdDays) {
  const tf = TF[tfKey] || TF.h24;
  const tvl = num(pool.tvlUsdc);
  const s24 = pool.stats?.["24h"] || {}, s7 = pool.stats?.["7d"] || {}, s30 = pool.stats?.["30d"] || {};
  const price = num(pool.price);
  const A = pool.tokenA || {}, B = pool.tokenB || {};
  const symA = (A.symbol || "?").toUpperCase(), symB = (B.symbol || "?").toUpperCase();
  const stableA = STABLE.has(symA), stableB = STABLE.has(symB);
  const feeRate = num(pool.feeRate) / 1e6;                       // fraction, e.g. 0.0016
  const adaptiveRate = pool.adaptiveFee?.currentRate != null ? num(pool.adaptiveFee.currentRate) / 1e6 : null;
  const rate = pool.adaptiveFeeEnabled && adaptiveRate ? adaptiveRate : feeRate;

  const orcaVol = volAndAge(pool.priceHistory7d);
  const dsSigma = sigmaFromChanges(ds?.priceChange);
  // Orca's 7-day series has far more observations, so prefer it when the pool is old
  // enough to have a full one. New pools only have DexScreener's windows.
  const sigma = orcaVol.ageDays === null && orcaVol.sigma !== null ? orcaVol.sigma : (dsSigma ?? orcaVol.sigma);
  const sigmaSrc = orcaVol.ageDays === null && orcaVol.sigma !== null ? "orca7d" : (dsSigma !== null ? "dexscreener" : "orca7d");

  const created = ds?.pairCreatedAt ? Number(ds.pairCreatedAt) : null;
  const ageDays = created ? Math.max(0, (Date.now() - created) / 864e5) : orcaVol.ageDays;

  // DexScreener's volume is measured differently from Orca's and typically runs higher,
  // so calibrate it against the one window both report before trusting the short ones.
  const dsV24 = num(ds?.volume?.h24), orcaV24 = num(s24.volume);
  const cal = dsV24 > 0 && orcaV24 > 0 ? Math.min(5, Math.max(0.2, orcaV24 / dsV24)) : 1;

  // Fees per day over the chosen window.
  let feesPerDay = null, windowVol = null, haveTf = false;
  if (tf.src === "ds" && ds?.volume) {
    const v = num(ds.volume[tfKey]) * cal;
    if (v > 0 || tfKey === "h24") { windowVol = v; feesPerDay = v * rate * (24 / tf.hours); haveTf = true; }
  }
  if (feesPerDay === null) {                                      // 7d, or no DexScreener row
    const f7 = num(s7.fees), f24 = num(s24.fees);
    feesPerDay = tfKey === "d7" ? (f7 > 0 ? f7 / 7 : f24) : (f24 > 0 ? f24 : f7 / 7);
    windowVol = tfKey === "d7" ? num(s7.volume) : num(s24.volume);
    haveTf = tf.src === "orca";
  }

  const L = humanL(pool.liquidity, A.decimals, B.decimals);
  let feePerL = L ? feesPerDay / L : null;
  const costPerL = sigma !== null && price > 0 ? (sigma * sigma * Math.sqrt(price)) / 4 : null;
  let basis = "liquidity", edge = feePerL !== null && costPerL ? feePerL / costPerL : null;
  if (edge === null || !Number.isFinite(edge) || edge > 1000) {
    const y = tvl > 0 ? feesPerDay / tvl : 0;
    edge = sigma !== null && sigma > 0 ? y / ((sigma * sigma) / 8) : null;
    basis = "tvl"; feePerL = null;
  }

  const width = sigma !== null ? Math.max(0.08, Math.min(0.85, 1.5 * sigma * Math.sqrt(holdDays))) : null;
  let earns = null, needs = null, netDay = null;
  if (width && price > 0 && sigma !== null) {
    const lp = lPerDollar(price, width);
    needs = costPerL !== null ? costPerL * lp : null;
    earns = basis === "liquidity" && feePerL !== null ? feePerL * lp
      : (tvl > 0 ? (feesPerDay / tvl) * (lp / lPerDollar(price, 0.5)) : null);
    if (earns !== null && needs !== null) netDay = earns - needs;
  }

  const y24 = tvl > 0 ? num(s24.fees) / tvl : 0;
  const y7 = tvl > 0 ? num(s7.fees) / 7 / tvl : 0;
  const y30 = tvl > 0 ? num(s30.fees) / 30 / tvl : 0;
  const tx = ds?.txns?.[tfKey] || ds?.txns?.h24 || null;

  return {
    address: pool.address,
    pair: `${A.symbol || "?"}/${B.symbol || "?"}`,
    base: stableA && !stableB ? B.symbol : A.symbol,
    quote: stableA && !stableB ? A.symbol : B.symbol,
    bothVolatile: !stableA && !stableB,
    stablePair: stableA && stableB,
    feeRate: rate * 100,
    adaptiveFee: !!pool.adaptiveFeeEnabled,
    price, tvl,
    vol24: num(s24.volume), windowVol, haveTf,
    volOverTvl: tvl > 0 ? num(s24.volume) / tvl : 0,
    yield24: y24, yield7d: y7, yield30d: y30,
    trend: (y7 > 0 && y30 > 0) ? y7 / y30 : null,
    spike: (y7 > 0 && y24 > 3 * y7),
    sigma, sigmaSrc, created, ageDays, cal,
    edge, basis, width, earns, needs, netDay,
    netPer1k: netDay !== null ? netDay * 1000 : null,
    dsUrl: ds?.url || null,
    txns: tx ? { buys: num(tx.buys), sells: num(tx.sells) } : null,
    onDs: !!ds
  };
}

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
  try {
    const hold = Math.max(1, Math.min(365, num(q.hold) || 30));
    const tfKey = TF[q.tf] ? q.tf : "h24";
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
        dexscreenerMatched: dsMap.size, dexscreenerMissing: raw.length - dsMap.size,
        timeframe: tfKey, firstPool: a, firstDexScreener: dsMap.get(a.address) || null,
        scored: score(a, dsMap.get(a.address), tfKey, hold)
      });
    }

    const pools = raw.map(p => score(p, dsMap.get(p.address), tfKey, hold)).filter(p => !p.stablePair);
    pools.sort((a, b) => (b.netDay ?? -1e9) - (a.netDay ?? -1e9));
    res.json({
      at: Date.now(), scanned: raw.length, returned: pools.length,
      cursorKey, pages: log.length, timeframe: tfKey, dexscreenerMatched: dsMap.size, pools
    });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
};
module.exports._test = { volAndAge, sigmaFromChanges, lPerDollar, humanL, score, TF };
