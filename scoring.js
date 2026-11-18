// Pool scoring (edge, net yield, costs, ranking inputs) shared by the /api/pools function and the browser fallback.
// UMD export: window.OrcaScoring in the browser, module.exports in Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.OrcaScoring = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const STABLE = new Set(["USDC","USDT","PYUSD","FDUSD","USDS","DAI","USDG","USDE","CASH","EURC","USD1","SUSD"]);
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  // Default cost model parameters for delta-neutral LP + short perp hedge.
  const COST_DEFAULTS = {
    solTxCostSol: 0.00002,   // SOL fee per transaction
    lpTxCount: 3,            // transactions per LP open/close cycle (position rent is refundable = 0)
    tickArrayRentSol: 0,     // non-refundable tick-array init rent in SOL
    swapSlippage: 0.001,     // 0.1% slippage on the ~50% balancing swap
    hedgeRatio: null,        // short perp notional / posUsd. null = derived from the range (see hedgeRatioFor); a number overrides it
    perpTakerFee: 0.0005,    // perp taker fee per side (charged on open + close)
    perpFundingDaily: 0.0001 // daily perp funding/borrow rate on short notional (can be negative)
  };

  const WIDTH_MIN = 0.03;
  const WIDTH_MAX = 0.85;
  const PROFILE_KS = { conservador: 2.0, moderado: 1.5, agressivo: 1.0 };
  // Below this daily volatility the pair is pegged (LST, wrapped asset, stable-like): LVR is ~0 and the real risk is a depeg,
  // which this model does not price. Such pools are flagged, not hidden.
  const PEGGED_SIGMA = 0.005;

  // Orca's own fee accounting, at every period it publishes.
  const PERIOD_HOURS = { "5m":1/12, "15m":0.25, "30m":0.5, "1h":1, "2h":2, "4h":4, "8h":8, "24h":24, "7d":168, "30d":720 };
  // tf=blend: weights of the 24h / 7d / 30d fee rates (renormalised over the windows Orca returned).
  const BLEND_WEIGHTS = [["24h", 0.3], ["7d", 0.5], ["30d", 0.2]];

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

  /* ---------------- hedge sizing ---------------- */
  // Fraction of a concentrated position's value held in token A (the base side, quoted in B) when the price sits at the
  // centre of a +-w range. Exact: value of A = L*sqrt(P)*(1 - 1/sqrt(1+w)), value of B = L*sqrt(P)*(1 - sqrt(1-w)).
  // It is 0.5 for a hairline range and falls as the range widens (0.45 at +-20%, 0.39 at +-50%).
  function centerFractionA(w) {
    if (!(w > 0) || !(w < 1)) return 0.5;
    const vx = 1 - 1 / Math.sqrt(1 + w), vy = 1 - Math.sqrt(1 - w);
    return vx + vy > 0 ? vx / (vx + vy) : 0.5;
  }

  // Short perp notional as a fraction of the position, for the dollars that actually carry price risk.
  //  - one volatile token: its share of the position at the centre of the range;
  //  - two volatile tokens: both legs need a short, so the whole position is hedged (~1.0).
  function hedgeRatioFor(width, { bothVolatile = false, volatileIsQuote = false } = {}) {
    if (bothVolatile) return 1;
    const a = centerFractionA(width);
    return volatileIsQuote ? 1 - a : a;
  }

  // Explicit numeric override wins; otherwise derive from the range; 0.5 only when nothing is known.
  function hedgeRatioAt(costOpts, width) {
    const hr = costOpts?.hedgeRatio;
    if (typeof hr === "number" && Number.isFinite(hr) && hr >= 0) return hr;
    return typeof costOpts?.hedgeFn === "function" ? costOpts.hedgeFn(width) : 0.5;
  }

  /* ---------------- yield model ---------------- */
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
    const hedgeRatio = hedgeRatioAt(costOpts, width);
    const hedgeFeeRate = 2 * costOpts.perpTakerFee * hedgeRatio;
    const fundingRateHold = costOpts.perpFundingDaily * hedgeRatio * holdDays;
    return { fixedOnceUsd, rebalances, swapOnceRate, hedgeRatio, hedgeFeeRate, fundingRateHold };
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
    const fundingPerDay = posUsd * costOpts.perpFundingDaily * rates.hedgeRatio;
    const dailyNet = netDay * posUsd - fundingPerDay - rebalPerDay;
    if (!(dailyNet > 0)) return null;
    return Math.max(0, initialCost / dailyNet);
  }

  // Trading costs of holding `width` for holdDays, spread per day as a fraction of the position.
  function frictionAt(width, posUsd, holdDays, rate, sigma, costOpts) {
    const rates = calcCostRates(width, holdDays, rate, sigma, costOpts);
    const costs = costsAtPos(posUsd, rates);
    return { rates, costs, perDay: costs.totalUsd / holdDays / posUsd };
  }

  function score(pool, ds, tfKey, holdDays, posUsd = 1000, opts = {}) {
    const stats = pool.stats || {};
    const tvl = num(pool.tvlUsdc), price = num(pool.price);
    const s24 = stats["24h"] || {}, s7 = stats["7d"] || {}, s30 = stats["30d"] || {};
    const A = pool.tokenA || {}, B = pool.tokenB || {};
    const stableA = STABLE.has((A.symbol || "").toUpperCase()), stableB = STABLE.has((B.symbol || "").toUpperCase());
    const bothVolatile = !stableA && !stableB;
    const costOpts = {
      ...COST_DEFAULTS,
      ...opts,
      solPriceUsd: opts.solPriceUsd ?? inferPoolSolPrice(pool) ?? 0
    };
    // Hedge size follows the range unless the caller pinned a number: see hedgeRatioFor.
    costOpts.hedgeFn = w => hedgeRatioFor(w, { bothVolatile, volatileIsQuote: stableA && !stableB });

    const ov = volAndAge(pool.priceHistory7d);
    const dsSigma = sigmaFromChanges(ds?.priceChange);
    const sigma = ov.sigma !== null && ov.ageDays === null ? ov.sigma : (ov.sigma ?? dsSigma);
    const sigmaSrc = ov.sigma !== null ? "orca7d" : (dsSigma !== null ? "dexscreener" : null);
    const created = ds?.pairCreatedAt ? Number(ds.pairCreatedAt) : null;
    const ageDays = created ? Math.max(0, (Date.now() - created) / 864e5) : ov.ageDays;

    // Fees per day over the chosen period, straight from Orca's own accounting.
    // A 7d/30d window on a pool younger than that only holds as many days of fees as the pool has existed, so divide
    // by the age (never below 1 day), not by the nominal window, or young pools look like they earn too little.
    const hoursOf = k => {
      const h = PERIOD_HOURS[k] ?? 24;
      return h >= 168 && ageDays != null ? Math.max(24, Math.min(h, ageDays * 24)) : h;
    };
    const perDay = (k, field) => num(stats[k]?.[field]) * (24 / hoursOf(k));
    let haveTf, useKey, feesPerDay, windowVol;
    const blendParts = tfKey === "blend" ? BLEND_WEIGHTS.filter(([k]) => stats[k] && stats[k].fees !== undefined) : [];
    if (blendParts.length >= 2) {
      // Steadier than any single window: damps a one-day spike and matches the 7-day volatility sample better.
      const wsum = blendParts.reduce((a, [, w]) => a + w, 0);
      feesPerDay = blendParts.reduce((a, [k, w]) => a + w * perDay(k, "fees"), 0) / wsum;
      windowVol = blendParts.reduce((a, [k, w]) => a + w * perDay(k, "volume"), 0) / wsum;
      haveTf = true; useKey = "blend";
    } else {
      const want = stats[tfKey];
      haveTf = !!(want && want.fees !== undefined) && tfKey !== "blend";
      useKey = haveTf ? tfKey : (stats["24h"] ? "24h" : "7d");
      feesPerDay = perDay(useKey, "fees");
      windowVol = num(stats[useKey]?.volume);
    }

    const fee = effectiveFeeRate(pool);
    const rate = fee.total / 1e6;

    const qUsd = stableB ? 1 : quoteUsd(pool, price);
    const L = humanL(pool.liquidity, A.decimals, B.decimals);
    const feePerL = L ? feesPerDay / L : null;                    // dollars per unit of liquidity
    const costPerL = (sigma !== null && price > 0 && qUsd)
      ? (sigma * sigma * Math.sqrt(price) / 4) * qUsd : null;     // converted to dollars too

    const yTvl = tvl > 0 ? feesPerDay / tvl : 0;
    const edgeTvl = sigma !== null && sigma > 0 ? yTvl / ((sigma * sigma) / 8) : null;

    // Dollar value of a FULL-RANGE position holding the pool's active liquidity, relative to TVL.
    // Pool-level edge = edgeTvl / concentration exactly: concentrated liquidity earns the same fees but carries more
    // LVR per dollar. It is ~1-20 for ordinary pools and in the thousands for tight pegged pairs (0.01% tiers).
    const concentration = (L && qUsd && price > 0 && tvl > 0) ? (2 * L * Math.sqrt(price) * qUsd) / tvl : null;

    let basis = "liquidity";
    let edge = feePerL !== null && costPerL ? feePerL / costPerL : null;
    // The liquidity basis is the accurate one, so it is only dropped when the data cannot support it: missing, or an
    // active liquidity under 1% of what TVL implies (ratio = 1/concentration > 100), which means the liquidity or
    // balance figures are off. A very HIGH concentration is legitimate (tight pegged pairs) and must stay on this
    // basis: the TVL fallback would inflate those edges by the concentration itself (1000x+).
    const ratio = edge !== null && edgeTvl ? edge / edgeTvl : null;
    if (edge === null || !Number.isFinite(edge) || (ratio !== null && ratio > 100)) {
      edge = edgeTvl; basis = "tvl";
    }

    const ctx = { price, sigma, basis, costPerL, qUsd, L, feesPerDay, tvl, yTvl, rate };
    const priceable = pw => sigma !== null && pw > 0 && price > 0;
    const profiles = {};
    for (const [name, k] of Object.entries(PROFILE_KS)) {
      const w = sigma !== null ? Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, k * sigma * Math.sqrt(holdDays))) : null;
      const ev = evalWidth(w, posUsd, ctx);
      const rebal = (w && sigma !== null) ? holdDays * (sigma / w) ** 2 : null;
      const minSol = solveMinPosUsd(w, holdDays, ctx, costOpts);
      const fr = priceable(w) && ev.netDay !== null ? frictionAt(w, posUsd, holdDays, rate, sigma, costOpts) : null;
      const netAllIn = fr ? ev.netDay - fr.perDay : null;
      profiles[name] = {
        k,
        widthPct: w !== null ? w * 100 : null,
        lower: (w !== null && price > 0) ? price * (1 - w) : null,
        upper: (w !== null && price > 0) ? price * (1 + w) : null,
        expectedRebalances: rebal,
        netDay: ev.netDay,
        netPer1k: ev.netDay !== null ? ev.netDay * 1000 : null,
        hedgeRatio: fr ? fr.rates.hedgeRatio : null,
        friction: fr ? fr.perDay : null,
        netAllIn,
        netAllInPer1k: netAllIn !== null ? netAllIn * 1000 : null,
        minPosUsd: minSol.minPosUsd,
        minPosReason: minSol.minPosReason
      };
    }

    // Top-level fields stay anchored to the moderate profile (k=1.5).
    const mod = profiles.moderado;
    const width = mod.widthPct !== null ? mod.widthPct / 100 : null;
    const modEval = evalWidth(width, posUsd, ctx);
    const { earns, needs, netDay, share, conc } = modEval;
    const modFr = (width && priceable(width) && netDay !== null) ? frictionAt(width, posUsd, holdDays, rate, sigma, costOpts) : null;
    const costs = modFr ? modFr.costs : null;
    const friction = modFr ? modFr.perDay : null;                  // trading costs per day, fraction of the position
    const netAllIn = modFr ? netDay - friction : null;             // what the position clears per day after EVERYTHING
    // Fees divided by (movement cost + trading costs): > 1 exactly when netAllIn > 0, so it reads as the safety margin.
    const edgeNet = modFr && needs + friction > 0 ? earns / (needs + friction) : null;
    const breakevenDays = calcBreakevenDays(width, holdDays, posUsd, netDay, ctx, costOpts);

    const y24 = tvl > 0 ? num(s24.fees) / tvl : 0;
    const y7 = tvl > 0 ? num(s7.fees) / 7 / tvl : 0;
    const y30 = tvl > 0 ? num(s30.fees) / 30 / tvl : 0;

    return {
      address: pool.address,
      pair: `${A.symbol || "?"}/${B.symbol || "?"}`,
      base: stableA && !stableB ? B.symbol : A.symbol,
      quote: stableA && !stableB ? A.symbol : B.symbol,
      bothVolatile,
      stablePair: stableA && stableB,
      pegged: sigma !== null && sigma < PEGGED_SIGMA,
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
      concentration,
      edge, edgeTvl, edgeNet, basis, width, earns, needs, netDay,
      netPer1k: netDay !== null ? netDay * 1000 : null,
      friction, netAllIn,
      netAllInPer1k: netAllIn !== null ? netAllIn * 1000 : null,
      hedgeRatioUsed: modFr ? modFr.rates.hedgeRatio : null,
      minPosUsd: mod.minPosUsd,
      minPosReason: mod.minPosReason,
      breakevenDays,
      costs,
      profiles,
      dsUrl: ds?.url || null, onDs: !!ds
    };
  }

  return {
    SOL_MINT, STABLE, COST_DEFAULTS, WIDTH_MIN, WIDTH_MAX, PROFILE_KS, PEGGED_SIGMA, PERIOD_HOURS, BLEND_WEIGHTS,
    num, volAndAge, sigmaFromChanges, lPerDollar, humanL, quoteUsd, effectiveFeeRate, fullHistory, thinReasons,
    isSolToken, inferPoolSolPrice, extractSolPriceUsd,
    centerFractionA, hedgeRatioFor, hedgeRatioAt,
    evalWidth, calcCostRates, costsAtPos, solveMinPosUsd, calcBreakevenDays, frictionAt, score
  };
}));
