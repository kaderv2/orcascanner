// GET /api/pools          -> every Orca Whirlpool, scored and ranked (thin pools excluded)
// GET /api/pools?debug=1  -> crawl log, which stats periods arrived, raw first pool + its score
//
// Query: hold, posUsd (or pos), tf, size, maxPages (total page budget), crawlMinTvl (dust floor sent to Orca, default 1000),
//        minTvl=250000, minVol24=50000, minAgeDays=7 -> pools below any of these, or with an effective fee of 0,
//        are flagged thin:true + thinReason and left out of the ranking unless includeThin=1.
//        Cost model params (delta-neutral LP + short perp):
//          solTxCostSol=0.00002     SOL tx fee per transaction
//          lpTxCount=3              txs per LP open/close cycle (swap + open + close; position rent is refundable = 0)
//          tickArrayRentSol=0       non-refundable tick-array init rent in SOL (0 when already initialized)
//          swapSlippage=0.001       0.1% slippage on the ~50% balancing swap (plus 0.5*effectiveFeeRate)
//          hedgeRatio=0.5           short perp notional as fraction of posUsd (~50% volatile side)
//          perpTakerFee=0.0005      perp taker fee per side (open + close = 2 * perpTakerFee * hedgeRatio * posUsd)
//          perpFundingDaily=0.0001  daily funding/borrow rate on short notional (can be negative when shorts are paid)
//          solPriceUsd              optional override; otherwise derived from SOL/USDC pool (Orca or DexScreener)
//
// Orca   https://api.orca.so/v2/solana/pools
//        params: size, next (cursor from meta.cursor.next; "after" also works, "cursor"/"page" are ignored),
//                sortBy, sortDirection, minTvl, stats=<comma list from 5m,15m,30m,1h,2h,4h,8h,24h,7d,30d>
//        meta:   { cursor: { previous, next } }
//        pool:   { address, liquidity, price (tokenB per tokenA), tvlUsdc, feeRate,
//                  tokenBalanceA/B (RAW integers), adaptiveFeeEnabled,
//                  adaptiveFee:{currentRate,maxRate,constants:{...},variables:{...}} | null,
//                  tokenA:{symbol,address,decimals}, tokenB:{...},
//                  stats:{ "<period>":{volume,fees,...} }, priceHistory7d:[ "decimal"|null x14 ] }
// DexScreener  used only for exact pool age and the chart link, never for fees.
//        https://api.dexscreener.com/latest/dex/pairs/solana/<addr,addr,...>
//        -> { pairs:[ { pairAddress, url, pairCreatedAt(ms), priceChange:{m5,h1,h6,h24} } ] }

try { require("node:dns").setDefaultResultOrder?.("ipv4first"); } catch {}

const ORCA = "https://api.orca.so/v2/solana/pools";
const DS = "https://api.dexscreener.com/latest/dex/pairs/solana/";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLE = new Set(["USDC","USDT","PYUSD","FDUSD","USDS","DAI","USDG","USDE","CASH","EURC","USD1","SUSD"]);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Default cost model parameters for delta-neutral LP + short perp hedge.
const COST_DEFAULTS = {
  solTxCostSol: 0.00002,   // SOL fee per transaction
  lpTxCount: 3,            // transactions per LP open/close cycle (position rent is refundable = 0)
  tickArrayRentSol: 0,     // non-refundable tick-array init rent in SOL
  swapSlippage: 0.001,     // 0.1% slippage on the ~50% balancing swap
  hedgeRatio: 0.5,         // short perp notional / posUsd (~50% volatile leg)
  perpTakerFee: 0.0005,    // perp taker fee per side (charged on open + close)
  perpFundingDaily: 0.0001 // daily perp funding/borrow rate on short notional (can be negative)
};

const WIDTH_MIN = 0.03;
const WIDTH_MAX = 0.85;
const PROFILE_KS = { conservador: 2.0, moderado: 1.5, agressivo: 1.0 };

// Orca's own fee accounting, at every period it publishes.
const PERIOD_HOURS = { "5m":1/12, "15m":0.25, "30m":0.5, "1h":1, "2h":2, "4h":4, "8h":8, "24h":24, "7d":168, "30d":720 };
const ALL_PERIODS = Object.keys(PERIOD_HOURS).join(",");

/* ---------------- Orca crawl ---------------- */
// Query parameter that carries the cursor. Verified against the live API: "next" and "after" both
// advance; "cursor" and "page" are silently ignored and return page 1 again.
const CURSOR_KEYS = ["next", "after", "cursor", "page"];

// Orca v2 returns the cursor in meta.cursor.next; older shapes are kept as fallbacks.
const nextCursor = j => j?.meta?.cursor?.next ?? j?.meta?.next ?? j?.cursor?.next ?? j?.next ?? null;

async function getPage(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Orca returned ${r.status}`);
  const j = await r.json();
  return {
    pools: Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [],
    next: nextCursor(j),
    envelope: Object.keys(j || {}),
    metaKeys: j?.meta ? Object.keys(j.meta) : null
  };
}

const addAll = (seen, pools) => {
  const before = seen.size;
  for (const p of pools) if (p?.address && !seen.has(p.address)) seen.set(p.address, p);
  return seen.size - before;
};

async function sweep(seen, log, label, dir, { size, budget, crawlMinTvl, cursorKey = null }) {
  const base = `${ORCA}?size=${size}&stats=${ALL_PERIODS}&sortBy=tvl&sortDirection=${dir}${crawlMinTvl ? `&minTvl=${crawlMinTvl}` : ""}`;
  const first = await getPage(base);
  const added0 = addAll(seen, first.pools);
  log.push({ sweep: label, page: 1, got: first.pools.length, added: added0,
             total: seen.size, envelope: first.envelope, metaKeys: first.metaKeys,
             statsPeriods: Object.keys(first.pools[0]?.stats || {}) });

  let next = first.next, pages = 1, stalled = false;
  while (next && pages < budget) {
    let advanced = false;
    for (const k of (cursorKey ? [cursorKey] : CURSOR_KEYS)) {
      let pg;
      try { pg = await getPage(`${base}&${k}=${encodeURIComponent(next)}`); } catch { continue; }
      const added = addAll(seen, pg.pools);
      // A page with no new addresses means the key was ignored (page 1 again) or the cursor looped.
      if (pg.pools.length && added > 0) {
        cursorKey = k; advanced = true; next = pg.next; pages++;
        log.push({ sweep: label, page: pages, key: k, got: pg.pools.length, added, total: seen.size });
        break;
      }
    }
    if (!advanced) {
      stalled = true;
      log.push({ sweep: label, page: pages + 1, stopped: "cursor did not advance", nextSeen: String(next).slice(0, 24) });
      break;
    }
  }
  return { cursorKey, pages, complete: !next, stalled };
}

// Sorted by TVL descending and followed through the cursor until it runs out or the page budget
// (maxPages, total across sweeps) is spent. Only if the cursor breaks is the smallest-first sweep
// used to pick up the tail from the other end.
async function crawl({ size = 1000, maxPages = 40, crawlMinTvl = 0 } = {}) {
  const seen = new Map(), log = [];
  let cursorKey = null, pages = 0, complete = false;
  for (const [label, dir] of [["largest first", "desc"], ["smallest first", "asc"]]) {
    const budget = maxPages - pages;
    if (budget < 1) break;
    try {
      const r = await sweep(seen, log, label, dir, { size, budget, crawlMinTvl, cursorKey });
      cursorKey = r.cursorKey || cursorKey; pages += r.pages;
      if (r.complete) complete = true;
      if (!r.stalled) break;          // finished or out of budget: the other end adds nothing new
    } catch (e) { log.push({ sweep: label, error: String(e.message || e) }); }
  }
  return { pools: [...seen.values()], log, cursorKey, pages, complete };
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

// Orca v2 rates are in hundredths of a basis point (1e6 = 100%). feeRate is the static base fee;
// adaptiveFee.currentRate is only the variable surcharge (often 0), capped by adaptiveFee.maxRate.
// Effective = base + variable, under the program's 10% hard limit — never 0 while the base is > 0.
const FEE_RATE_HARD_LIMIT = 100000;
function effectiveFeeRate(pool) {
  const base = Math.max(0, num(pool?.feeRate));
  const af = pool?.adaptiveFeeEnabled && pool.adaptiveFee ? pool.adaptiveFee : null;
  let variable = af ? Math.max(0, num(af.currentRate)) : 0;
  if (af && num(af.maxRate) > 0) variable = Math.min(variable, num(af.maxRate));
  return { base, variable, total: Math.min(base + variable, FEE_RATE_HARD_LIMIT) };
}

// A full 7-day series (no empty leading slots) proves the pool is at least about a week old.
const fullHistory = s => Array.isArray(s) && s.length > 1 && s.every(v => num(v) > 0);

// Why a scored pool is too thin to rank; [] when it is fine.
function thinReasons(s, pool, { minTvl = 250000, minVol24 = 50000, minAgeDays = 7 } = {}) {
  const r = [];
  if (!(s.feeRate > 0)) r.push("fee 0");
  if (s.tvl < minTvl) r.push(`tvl<${minTvl}`);
  if (s.vol24 < minVol24) r.push(`vol24<${minVol24}`);
  if (minAgeDays > 0) {
    if (s.ageDays != null) { if (s.ageDays < minAgeDays) r.push(`age ${s.ageDays.toFixed(1)}d<${minAgeDays}d`); }
    else if (!(fullHistory(pool?.priceHistory7d) && minAgeDays <= 7)) r.push("age unknown");
  }
  return r;
}

const isSolToken = t => t?.address === SOL_MINT || (t?.symbol || "").toUpperCase() === "SOL";

function inferPoolSolPrice(pool) {
  const price = num(pool?.price);
  if (!(price > 0)) return null;
  const symA = (pool?.tokenA?.symbol || "").toUpperCase();
  const symB = (pool?.tokenB?.symbol || "").toUpperCase();
  if (isSolToken(pool?.tokenA) && STABLE.has(symB)) return price;
  if (isSolToken(pool?.tokenB) && STABLE.has(symA)) return 1 / price;
  return null;
}

// Derive SOL/USD from the highest-TVL SOL/stable pool in Orca's response, falling back to
// quoteUsd on a */SOL pool or DexScreener's priceUsd.
function extractSolPriceUsd(pools = [], dsMap = null) {
  let best = null, bestScore = -1;
  for (const p of pools) {
    const px = inferPoolSolPrice(p);
    if (!(px > 0)) continue;
    const symA = (p.tokenA?.symbol || "").toUpperCase(), symB = (p.tokenB?.symbol || "").toUpperCase();
    const isSolMint = (p.tokenA?.address === SOL_MINT) || (p.tokenB?.address === SOL_MINT);
    const isUsdc = symA === "USDC" || symB === "USDC";
    const tvl = num(p.tvlUsdc);
    const rank = (isSolMint ? 1e14 : 0) + (isUsdc ? 1e12 : 0) + tvl;
    if (rank > bestScore) { bestScore = rank; best = px; }
  }
  if (best) return best;

  let bestTvl = -1;
  for (const p of pools) {
    if (!isSolToken(p?.tokenB)) continue;
    const q = quoteUsd(p, num(p.price));
    const tvl = num(p.tvlUsdc);
    if (q > 0 && tvl > bestTvl) { bestTvl = tvl; best = q; }
  }
  if (best) return best;

  if (dsMap) {
    for (const pair of dsMap.values()) {
      const bt = pair?.baseToken;
      if ((bt?.address === SOL_MINT || (bt?.symbol || "").toUpperCase() === "SOL") && num(pair.priceUsd) > 0) {
        return num(pair.priceUsd);
      }
    }
  }
  return null;
}

function evalWidth(width, posUsd, ctx) {
  const { price, sigma, basis, costPerL, qUsd, L, feesPerDay, tvl, yTvl } = ctx;
  if (!(width > 0) || !(price > 0) || sigma === null) {
    return { earns: null, needs: null, netDay: null, share: null, conc: null };
  }
  const lp = lPerDollar(price, width);
  let earns, needs, share;
  if (basis === "liquidity") {
    // lp is liquidity per ONE QUOTE TOKEN of position value, so dividing by the quote
    // token's dollar price turns both sides into a yield on dollars.
    needs = costPerL * lp / qUsd;
    // Your own deposit joins the active liquidity and dilutes the fee per unit, which
    // matters enormously in a small pool. Model the share you would actually hold.
    const Lme = (posUsd / qUsd) * lp;
    share = L && L > 0 ? Lme / (L + Lme) : 1;
    earns = (feesPerDay * share) / posUsd;
  } else {
    const k = lp / lPerDollar(price, 0.5);
    needs = ((sigma * sigma) / 8) * k;
    share = tvl > 0 ? posUsd / (tvl + posUsd) : 1;
    earns = yTvl * k * (tvl > 0 ? tvl / (tvl + posUsd) : 1);
  }
  const netDay = earns - needs;
  const conc = yTvl > 0 ? earns / yTvl : null; // how much better than the pool average
  return { earns, needs, netDay, share, conc };
}

function calcCostRates(width, holdDays, rate, sigma, costOpts) {
  const solPrice = num(costOpts.solPriceUsd);
  const fixedOnceUsd = (costOpts.solTxCostSol * costOpts.lpTxCount + costOpts.tickArrayRentSol) * solPrice;
  // Mean first-exit time of Brownian motion from [-width, +width] is (width/sigma)^2 days.
  const rebalances = (width > 0 && sigma !== null) ? holdDays * (sigma / width) ** 2 : 0;
  // Balancing ~50% of posUsd pays pool fee + slippage on the swapped half.
  const swapOnceRate = 0.5 * (rate + costOpts.swapSlippage);
  const hedgeFeeRate = 2 * costOpts.perpTakerFee * costOpts.hedgeRatio;
  const fundingRateHold = costOpts.perpFundingDaily * costOpts.hedgeRatio * holdDays;
  return { fixedOnceUsd, rebalances, swapOnceRate, hedgeFeeRate, fundingRateHold };
}

function costsAtPos(posUsd, rates) {
  const lpFixedUsd = rates.fixedOnceUsd * (1 + rates.rebalances);
  const swapUsd = posUsd * rates.swapOnceRate * (1 + rates.rebalances);
  const hedgeUsd = posUsd * rates.hedgeFeeRate;
  const fundingUsd = posUsd * rates.fundingRateHold;
  return {
    lpFixedUsd,
    swapUsd,
    hedgeUsd,
    fundingUsd,
    rebalances: rates.rebalances,
    totalUsd: lpFixedUsd + swapUsd + hedgeUsd + fundingUsd
  };
}

// Find smallest posUsd in [10, 1e7] where expected profit over holdDays >= total costs.
// Because dilution makes netProfit(posUsd) concave (often peaking and then falling negative as
// posUsd -> 1e7), we locate the peak via golden-section search in log-space, then binary-search
// [10, xPeak] for the breakeven root.
function solveMinPosUsd(width, holdDays, ctx, costOpts) {
  if (!(width > 0) || !(ctx.price > 0) || ctx.sigma === null) {
    return { minPosUsd: null, minPosReason: "missing price or volatility" };
  }
  const rates = calcCostRates(width, holdDays, ctx.rate, ctx.sigma, costOpts);
  const profit = pUsd => {
    const ev = evalWidth(width, pUsd, ctx);
    if (ev.netDay === null) return null;
    return ev.netDay * holdDays * pUsd - costsAtPos(pUsd, rates).totalUsd;
  };
  const MIN_POS = 10, MAX_POS = 1e7;
  const fMin = profit(MIN_POS);
  if (fMin === null || !Number.isFinite(fMin)) {
    return { minPosUsd: null, minPosReason: "insufficient pool data" };
  }
  if (fMin >= 0) return { minPosUsd: MIN_POS, minPosReason: null };

  const PHI = (Math.sqrt(5) - 1) / 2;
  let lo = Math.log(MIN_POS), hi = Math.log(MAX_POS);
  let x1 = hi - PHI * (hi - lo), x2 = lo + PHI * (hi - lo);
  let f1 = profit(Math.exp(x1)), f2 = profit(Math.exp(x2));
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) {
      lo = x1; x1 = x2; f1 = f2;
      x2 = lo + PHI * (hi - lo); f2 = profit(Math.exp(x2));
    } else {
      hi = x2; x2 = x1; f2 = f1;
      x1 = hi - PHI * (hi - lo); f1 = profit(Math.exp(x1));
    }
  }
  const xPeak = Math.exp((lo + hi) / 2);
  const fPeak = profit(xPeak);
  const fMax = profit(MAX_POS);
  if (Math.max(fPeak, fMax) < 0) {
    const ev0 = evalWidth(width, 1e-6, ctx);
    const propCostHold = rates.swapOnceRate * (1 + rates.rebalances) + rates.hedgeFeeRate + rates.fundingRateHold;
    const reason = (ev0.netDay !== null && ev0.netDay * holdDays <= propCostHold)
      ? "yield does not cover IL/LVR and proportional costs"
      : "fixed/rebalance costs exceed max profit after dilution";
    return { minPosUsd: null, minPosReason: reason };
  }

  let a = MIN_POS, b = fPeak >= 0 ? xPeak : MAX_POS;
  for (let i = 0; i < 60; i++) {
    const mid = (a + b) / 2;
    if (profit(mid) >= 0) b = mid; else a = mid;
  }
  return { minPosUsd: b, minPosReason: null };
}

function calcBreakevenDays(width, holdDays, posUsd, netDay, ctx, costOpts) {
  if (netDay === null || !(width > 0) || !(ctx.price > 0) || ctx.sigma === null) return null;
  const rates = calcCostRates(width, holdDays, ctx.rate, ctx.sigma, costOpts);
  const initialCost = rates.fixedOnceUsd + posUsd * (rates.swapOnceRate + rates.hedgeFeeRate);
  const rebalPerDay = (rates.fixedOnceUsd + posUsd * rates.swapOnceRate) * ((ctx.sigma / width) ** 2);
  const fundingPerDay = posUsd * costOpts.perpFundingDaily * costOpts.hedgeRatio;
  const dailyNet = netDay * posUsd - fundingPerDay - rebalPerDay;
  if (!(dailyNet > 0)) return null;
  return Math.max(0, initialCost / dailyNet);
}

function score(pool, ds, tfKey, holdDays, posUsd = 1000, opts = {}) {
  const costOpts = {
    ...COST_DEFAULTS,
    ...opts,
    solPriceUsd: opts.solPriceUsd ?? inferPoolSolPrice(pool) ?? 0
  };
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

  const fee = effectiveFeeRate(pool);
  const rate = fee.total / 1e6;

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

  const ctx = { price, sigma, basis, costPerL, qUsd, L, feesPerDay, tvl, yTvl, rate };
  const profiles = {};
  for (const [name, k] of Object.entries(PROFILE_KS)) {
    const w = sigma !== null ? Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, k * sigma * Math.sqrt(holdDays))) : null;
    const ev = evalWidth(w, posUsd, ctx);
    const rebal = (w && sigma !== null) ? holdDays * (sigma / w) ** 2 : null;
    const minSol = solveMinPosUsd(w, holdDays, ctx, costOpts);
    profiles[name] = {
      k,
      widthPct: w !== null ? w * 100 : null,
      lower: (w !== null && price > 0) ? price * (1 - w) : null,
      upper: (w !== null && price > 0) ? price * (1 + w) : null,
      expectedRebalances: rebal,
      netDay: ev.netDay,
      netPer1k: ev.netDay !== null ? ev.netDay * 1000 : null,
      minPosUsd: minSol.minPosUsd,
      minPosReason: minSol.minPosReason
    };
  }

  // Top-level fields stay anchored to the moderate profile (k=1.5) for backward compatibility.
  const mod = profiles.moderado;
  const width = mod.widthPct !== null ? mod.widthPct / 100 : null;
  const modEval = evalWidth(width, posUsd, ctx);
  const { earns, needs, netDay, share, conc } = modEval;
  const costs = (width && price > 0 && sigma !== null)
    ? costsAtPos(posUsd, calcCostRates(width, holdDays, rate, sigma, costOpts))
    : null;
  const breakevenDays = calcBreakevenDays(width, holdDays, posUsd, netDay, ctx, costOpts);

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
    feeRateBase: fee.base / 1e4, feeRateAdaptive: fee.variable / 1e4,   // percent
    feeRateRealized24h: num(s24.volume) > 0 ? (num(s24.fees) / num(s24.volume)) * 100 : null,
    adaptiveFee: !!pool.adaptiveFeeEnabled,
    price, quoteUsd: qUsd, tvl,
    vol24: num(s24.volume), windowVol, haveTf, usedPeriod: useKey,
    volOverTvl: tvl > 0 ? num(s24.volume) / tvl : 0,
    yield24: y24, yield7d: y7, yield30d: y30,
    trend: (y7 > 0 && y30 > 0) ? y7 / y30 : null,
    spike: (y7 > 0 && y24 > 3 * y7),
    sigma, sigmaSrc, created, ageDays,
    poolAvg: yTvl, feesPerDay, activeL: L, share, conc, posUsd,
    edge, edgeTvl, basis, width, earns, needs, netDay,
    netPer1k: netDay !== null ? netDay * 1000 : null,
    minPosUsd: mod.minPosUsd,
    minPosReason: mod.minPosReason,
    breakevenDays,
    costs,
    profiles,
    dsUrl: ds?.url || null, onDs: !!ds
  };
}

// Numeric query param with a default; an explicit 0 is honoured (e.g. minTvl=0 turns that gate off).
const param = (q, k, def) => (q[k] === undefined || q[k] === "" || !Number.isFinite(parseFloat(q[k])))
  ? def : Math.max(0, parseFloat(q[k]));
const signedParam = (q, k, def) => (q[k] === undefined || q[k] === "" || !Number.isFinite(parseFloat(q[k])))
  ? def : parseFloat(q[k]);
const flag = v => v === true || v === "1" || v === "true" || v === "yes";

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
  try {
    const hold = Math.max(1, Math.min(365, num(q.hold) || num(q.holdDays) || 30));
    const rawPos = q.posUsd !== undefined && q.posUsd !== "" ? parseFloat(q.posUsd) : parseFloat(q.pos);
    const pos = Math.max(1, Math.min(1e7, Number.isFinite(rawPos) && rawPos > 0 ? rawPos : 1000));
    const tfKey = PERIOD_HOURS[q.tf] ? q.tf : "24h";
    const filters = {
      minTvl: param(q, "minTvl", 250000),
      minVol24: param(q, "minVol24", 50000),
      minAgeDays: param(q, "minAgeDays", 7),
      includeThin: flag(q.includeThin)
    };
    const crawlOpts = {
      size: Math.max(50, Math.min(1000, num(q.size) || 1000)),
      maxPages: Math.max(1, Math.min(60, num(q.maxPages) || 40)),
      // Dust floor applied by Orca itself; tens of thousands of near-empty pools sit below it.
      crawlMinTvl: param(q, "crawlMinTvl", 1000)
    };
    const { pools: raw, log, cursorKey, pages, complete } = await crawl(crawlOpts);
    if (!raw.length) return res.status(502).json({ error: "No pools returned", log });

    // DexScreener only matters for pools that can still rank, unless thin ones were asked for too.
    const isStable = t => STABLE.has((t?.symbol || "").toUpperCase());
    const mayRank = p => filters.includeThin || (
      effectiveFeeRate(p).total > 0 && num(p.tvlUsdc) >= filters.minTvl &&
      num(p.stats?.["24h"]?.volume) >= filters.minVol24 && !(isStable(p.tokenA) && isStable(p.tokenB)));
    const dsMap = q.nods ? new Map() : await enrich(raw.filter(mayRank).map(p => p.address).filter(Boolean));
    const crawlInfo = { pages, complete, cursorKey, ...crawlOpts };

    const solPriceOverride = param(q, "solPriceUsd", 0);
    const solPriceUsd = solPriceOverride > 0 ? solPriceOverride : extractSolPriceUsd(raw, dsMap);
    const costOpts = {
      solTxCostSol: param(q, "solTxCostSol", COST_DEFAULTS.solTxCostSol),
      lpTxCount: param(q, "lpTxCount", COST_DEFAULTS.lpTxCount),
      tickArrayRentSol: param(q, "tickArrayRentSol", COST_DEFAULTS.tickArrayRentSol),
      swapSlippage: param(q, "swapSlippage", COST_DEFAULTS.swapSlippage),
      hedgeRatio: param(q, "hedgeRatio", COST_DEFAULTS.hedgeRatio),
      perpTakerFee: param(q, "perpTakerFee", COST_DEFAULTS.perpTakerFee),
      perpFundingDaily: signedParam(q, "perpFundingDaily", COST_DEFAULTS.perpFundingDaily),
      solPriceUsd
    };

    if (q.debug) {
      const a = raw[0];
      return res.json({
        scanned: raw.length, cursorKey, crawl: crawlInfo, filters, log,
        statsPeriodsReturned: Object.keys(a?.stats || {}),
        periodsRequested: ALL_PERIODS,
        dexscreenerMatched: dsMap.size,
        timeframe: tfKey, solPriceUsd, costParams: costOpts,
        firstPool: a, scored: score(a, dsMap.get(a.address), tfKey, hold, pos, costOpts)
      });
    }

    const scored = raw.map(p => {
      const s = score(p, dsMap.get(p.address), tfKey, hold, pos, costOpts);
      const why = thinReasons(s, p, filters);
      s.thin = why.length > 0;
      s.thinReason = why.length ? why.join("; ") : null;
      return s;
    }).filter(p => !p.stablePair);
    const thinCounts = {};
    for (const s of scored) if (s.thin) for (const r of s.thinReason.split("; ")) {
      const k = r.startsWith("age ") && r !== "age unknown" ? `age<${filters.minAgeDays}d` : r;
      thinCounts[k] = (thinCounts[k] || 0) + 1;
    }
    const thin = scored.filter(p => p.thin).length;
    const pools = filters.includeThin ? scored : scored.filter(p => !p.thin);
    pools.sort((a, b) => (b.netDay ?? -1e9) - (a.netDay ?? -1e9));
    res.json({
      at: Date.now(), scanned: raw.length, returned: pools.length, cursorKey,
      pages, crawl: crawlInfo, filters, thin, thinCounts,
      feeZero: scored.filter(p => !(p.feeRate > 0)).length,
      timeframe: tfKey, holdDays: hold, positionUsd: pos,
      solPriceUsd, costParams: costOpts,
      periodsAvailable: Object.keys(raw[0]?.stats || {}),
      dexscreenerMatched: dsMap.size, pools
    });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
};
module.exports._test = { volAndAge, sigmaFromChanges, lPerDollar, humanL, quoteUsd, score, PERIOD_HOURS,
  nextCursor, effectiveFeeRate, thinReasons, fullHistory,
  COST_DEFAULTS, PROFILE_KS, extractSolPriceUsd, solveMinPosUsd, calcBreakevenDays };
