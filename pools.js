// GET /api/pools          -> every Orca Whirlpool, scored and ranked (thin pools excluded)
// GET /api/pools?debug=1  -> crawl log, which stats periods arrived, raw first pool + its score
//
// Ranking: by netAllIn = earns - needs(LVR) - friction/day (swap, perp fees, funding, rebalances, amortised over hold).
//          edge = pool-level fees / LVR; edgeNet = earns / (needs + friction), > 1 exactly when netAllIn > 0.
//
// Query: hold, posUsd (or pos), tf, size, maxPages (total page budget), crawlMinTvl (dust floor sent to Orca, default 1000),
//        minTvl=250000, minVol24=50000, minAgeDays=7 -> pools below any of these, or with an effective fee of 0,
//        are flagged thin:true + thinReason and left out of the ranking unless includeThin=1.
//        Cost model params (delta-neutral LP + short perp):
//          solTxCostSol=0.00002     SOL tx fee per transaction
//          lpTxCount=3              txs per LP open/close cycle (swap + open + close; position rent is refundable = 0)
//          tickArrayRentSol=0       non-refundable tick-array init rent in SOL (0 when already initialized)
//          swapSlippage=0.001       0.1% slippage on the ~50% balancing swap (plus 0.5*effectiveFeeRate)
//          hedgeRatio=<omitted>     short perp notional as fraction of posUsd. Omitted = derived from the range
//                                   (volatile share of the position at the centre: ~0.45 at +-20%, ~0.39 at +-50%;
//                                   1.0 when both tokens are volatile). Pass a number to pin it.
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

const SCORING = require("./scoring.js");
const { STABLE, COST_DEFAULTS, PERIOD_HOURS, num, score, thinReasons, effectiveFeeRate, extractSolPriceUsd } = SCORING;

const ORCA = "https://api.orca.so/v2/solana/pools";
const DS = "https://api.dexscreener.com/latest/dex/pairs/solana/";

// Orca's own fee accounting, at every period it publishes.
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
    const tfKey = (PERIOD_HOURS[q.tf] || q.tf === "blend") ? q.tf : "24h";
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
      hedgeRatio: param(q, "hedgeRatio", COST_DEFAULTS.hedgeRatio), // null unless pinned: derived from each range otherwise
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
    // Ranked by what the position clears per day after movement cost AND trading costs (not by the gross netDay).
    pools.sort((a, b) => (b.netAllIn ?? -1e9) - (a.netAllIn ?? -1e9));
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
module.exports._test = { ...SCORING, nextCursor };
