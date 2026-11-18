// Budget & LP + short-perp hedge calculator (shared between browser UI and Node tests).
// UMD export: window.OrcaCalc in browser, module.exports in Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.OrcaCalc = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PROFILE_KS = { conservador: 2.0, moderado: 1.5, agressivo: 1.0 };
  const WIDTH_MIN = 0.03;
  const WIDTH_MAX = 0.85;

  const DEFAULTS = {
    hedgeRatio: 0.5,        // short perp notional = 50% of LP position (volatile side)
    marginBufferPct: 0.20,  // 20% extra margin buffer on top of base collateral
    solReserveSol: 0.03,    // SOL reserved for tx fees & rent (~0.03 SOL)
    solTxCostSol: 0.00002,  // SOL fee per transaction
    entryTxCount: 2,        // swap + open LP transactions at entry
    lpTxCount: 3,           // full cycle transactions (swap + open + close)
    swapSlippage: 0.001,    // 0.1% slippage on ~50% balancing swap
    defaultLeverage: 2
  };

  const num = v => {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  function lPerDollar(P, w) {
    if (!(P > 0) || !(w > 0) || w >= 0.999) return 0;
    const s = Math.sqrt(P);
    const val = (1 / s - 1 / Math.sqrt(P * (1 + w))) * P + (s - Math.sqrt(P * (1 - w)));
    return val > 0 ? 1 / val : 0;
  }

  function profileWidth(sigma, days, profile) {
    const k = PROFILE_KS[profile] ?? PROFILE_KS.moderado;
    if (!(sigma > 0) || !(days > 0)) return null;
    return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, k * sigma * Math.sqrt(days)));
  }

  function evalPoolAt(pool, width, posUsd) {
    const price = num(pool?.price);
    const sigma = pool?.sigma != null ? num(pool.sigma) : null;
    if (!(width > 0) || !(price > 0) || !(posUsd > 0) || sigma === null || !(sigma >= 0)) {
      return { earns: null, needs: null, netDay: null, share: null };
    }
    const tvl = num(pool.tvl);
    const feesPerDay = pool.feesPerDay != null ? num(pool.feesPerDay) : num(pool.poolAvg) * tvl;
    const yTvl = tvl > 0 ? feesPerDay / tvl : num(pool.poolAvg);
    const qUsd = num(pool.quoteUsd) > 0 ? num(pool.quoteUsd) : 1;
    const lp = lPerDollar(price, width);

    // Prefer liquidity-basis dilution when activeL is available (or inferable from share at posUsd).
    let activeL = pool.activeL != null && num(pool.activeL) > 0 ? num(pool.activeL) : null;
    if (activeL === null && pool.basis === "liquidity" && num(pool.share) > 0 && num(pool.share) < 0.999 && num(pool.posUsd) > 0 && num(pool.width) > 0) {
      const refLme = (num(pool.posUsd) / qUsd) * lPerDollar(price, num(pool.width));
      activeL = refLme * (1 - num(pool.share)) / num(pool.share);
    }

    if (pool.basis === "liquidity" && activeL && activeL > 0 && lp > 0) {
      const costPerL = (sigma * sigma * Math.sqrt(price) / 4) * qUsd;
      const needs = (costPerL * lp) / qUsd;
      const Lme = (posUsd / qUsd) * lp;
      const share = Lme / (activeL + Lme);
      const earns = (feesPerDay * share) / posUsd;
      return { earns, needs, netDay: earns - needs, share };
    }

    const baseLp = lPerDollar(price, 0.5);
    const k = baseLp > 0 ? lp / baseLp : 1;
    const needs = ((sigma * sigma) / 8) * k;
    const share = tvl > 0 ? posUsd / (tvl + posUsd) : 1;
    const earns = yTvl * k * (tvl > 0 ? tvl / (tvl + posUsd) : 1);
    return { earns, needs, netDay: earns - needs, share };
  }

  function horizonCostsAt(P, {
    days,
    sigma,
    width,
    poolFeeRate,
    swapSlippage,
    solTxCostSol,
    lpTxCount,
    solPriceUsd,
    hedgeRatio,
    venueTaker,
    venueImpact,
    venueBorrowHourly,
    venueFundingHourly,
    isBorrowVenue
  }) {
    const rebalances = (width > 0 && sigma !== null && sigma >= 0) ? days * (sigma / width) ** 2 : 0;
    const fixedOnceUsd = solTxCostSol * lpTxCount * solPriceUsd;
    const lpFixedUsd = fixedOnceUsd * (1 + rebalances);
    const swapOnceUsd = P * 0.5 * (poolFeeRate + swapSlippage);
    const swapUsd = swapOnceUsd * (1 + rebalances);
    const hedgeNotional = hedgeRatio * P;
    const perpTradeUsd = 2 * (venueTaker + venueImpact) * hedgeNotional;
    const perpCarryUsd = isBorrowVenue
      ? venueBorrowHourly * 24 * days * hedgeNotional
      : -venueFundingHourly * 24 * days * hedgeNotional;
    return {
      rebalances,
      lpFixedUsd,
      swapUsd,
      perpTradeUsd,
      perpCarryUsd,
      totalUsd: lpFixedUsd + swapUsd + perpTradeUsd + perpCarryUsd
    };
  }

  function solveDynamicMinPosUsd(pool, width, days, costCtx) {
    if (!(width > 0) || !(num(pool?.price) > 0) || pool?.sigma == null) {
      return { minPosUsd: null, reason: "dados de preço ou volatilidade ausentes" };
    }
    const profit = pUsd => {
      const ev = evalPoolAt(pool, width, pUsd);
      if (ev.netDay === null) return null;
      return ev.netDay * days * pUsd - horizonCostsAt(pUsd, costCtx).totalUsd;
    };
    const MIN_POS = 10, MAX_POS = 1e7;
    const f10 = profit(MIN_POS);
    if (f10 === null || !Number.isFinite(f10)) {
      return { minPosUsd: null, reason: "dados insuficientes do pool" };
    }
    if (f10 >= 0) return { minPosUsd: MIN_POS, reason: null };

    const PHI = (Math.sqrt(5) - 1) / 2;
    let lo = Math.log(MIN_POS), hi = Math.log(MAX_POS);
    let x1 = hi - PHI * (hi - lo), x2 = lo + PHI * (hi - lo);
    let f1 = profit(Math.exp(x1)), f2 = profit(Math.exp(x2));
    for (let i = 0; i < 70; i++) {
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
    if (Math.max(fPeak, profit(MAX_POS)) < 0) {
      return { minPosUsd: null, reason: "rendimento não empata custos no horizonte" };
    }
    let a = MIN_POS, b = fPeak >= 0 ? xPeak : MAX_POS;
    for (let i = 0; i < 50; i++) {
      const mid = (a + b) / 2;
      if (profit(mid) >= 0) b = mid; else a = mid;
    }
    return { minPosUsd: b, reason: null };
  }

  /**
   * Solve maximum LP position P such that:
   *   P + colateralHedge + reservaSolUsd + custosEntrada <= budgetUsd
   * where:
   *   hedgeNotional = hedgeRatio * P (0.5 * P)
   *   colateralBase = hedgeNotional / effectiveLeverage
   *   marginBuffer  = colateralBase * marginBufferPct (default 20% of collateral)
   *   colateral     = colateralBase + marginBuffer
   *   reservaSolUsd = solReserveSol * solPriceUsd (~0.03 SOL in USD)
   *   custosEntrada = swapEntryUsd + perpOpenUsd + txEntryUsd
   */
  function solveBudget({
    budgetUsd = 100,
    pool = null,
    venue = null,
    profile = "moderado",
    leverage = DEFAULTS.defaultLeverage,
    days = 7,
    marginBufferPct = DEFAULTS.marginBufferPct,
    solReserveSol = DEFAULTS.solReserveSol,
    solTxCostSol = DEFAULTS.solTxCostSol,
    entryTxCount = DEFAULTS.entryTxCount,
    lpTxCount = DEFAULTS.lpTxCount,
    swapSlippage = DEFAULTS.swapSlippage,
    hedgeRatio = DEFAULTS.hedgeRatio,
    solPriceUsd = null
  } = {}) {
    const B = Math.max(0, num(budgetUsd));
    const D = Math.max(1, num(days) || 7);
    const bufPct = Math.max(0, num(marginBufferPct));
    const profKey = PROFILE_KS[profile] ? profile : "moderado";

    const vMinLev = Math.max(1, num(venue?.minLeverage) || 1);
    const vMaxLev = Math.max(vMinLev, num(venue?.maxLeverage) || 20);
    const requestedLev = Math.max(1, num(leverage) || DEFAULTS.defaultLeverage);
    const effectiveLeverage = Math.max(vMinLev, Math.min(vMaxLev, requestedLev));
    const leverageClamped = Math.abs(effectiveLeverage - requestedLev) > 1e-9;

    const poolPrice = num(pool?.price);
    const quoteUsd = num(pool?.quoteUsd) > 0 ? num(pool.quoteUsd) : 1;
    const basePriceUsd = poolPrice > 0 ? poolPrice * quoteUsd : 0;
    const isSolPool = ((pool?.base || "").toUpperCase() === "SOL") || ((pool?.pair || "").toUpperCase().startsWith("SOL/"));
    const resolvedSolPrice = num(solPriceUsd) > 0
      ? num(solPriceUsd)
      : (num(venue?.solPriceUsd) > 0
        ? num(venue.solPriceUsd)
        : (isSolPool && basePriceUsd > 0 ? basePriceUsd : 0));

    const poolFeeRate = Math.max(0, num(pool?.feeRate)) / 100; // % -> decimal
    const venueTaker = Math.max(0, num(venue?.takerRate));
    const venueImpact = Math.max(0, num(venue?.impactRate));
    const venueEntryPerpRate = venueTaker + venueImpact;

    const solReserveFullUsd = solReserveSol * resolvedSolPrice;
    const txEntryFullUsd = solTxCostSol * entryTxCount * resolvedSolPrice;
    const fixedEntryUsd = solReserveFullUsd + txEntryFullUsd;

    const swapEntryRate = 0.5 * (poolFeeRate + swapSlippage);
    const perpOpenRate = hedgeRatio * venueEntryPerpRate;
    const collateralPerLp = (hedgeRatio / effectiveLeverage) * (1 + bufPct);
    const kProp = 1 + collateralPerLp + swapEntryRate + perpOpenRate;

    const canAllocateLp = B > fixedEntryUsd;
    const lpUsd = canAllocateLp ? (B - fixedEntryUsd) / kProp : 0;
    const hedgeNotionalUsd = hedgeRatio * lpUsd;
    const collateralBaseUsd = hedgeNotionalUsd / effectiveLeverage;
    const marginBufferUsd = collateralBaseUsd * bufPct;
    const collateralTotalUsd = collateralBaseUsd + marginBufferUsd;
    const swapEntryUsd = lpUsd * swapEntryRate;
    const perpOpenUsd = hedgeNotionalUsd * venueEntryPerpRate;
    const txEntryUsd = canAllocateLp ? txEntryFullUsd : 0;
    const solReserveUsd = canAllocateLp ? solReserveFullUsd : Math.min(B, solReserveFullUsd);
    const entryCostsUsd = swapEntryUsd + perpOpenUsd + txEntryUsd;
    const totalAllocatedUsd = lpUsd + collateralTotalUsd + solReserveUsd + entryCostsUsd;

    const lpBaseUsd = 0.5 * lpUsd;
    const lpQuoteUsd = 0.5 * lpUsd;
    const lpBaseAmount = basePriceUsd > 0 ? lpBaseUsd / basePriceUsd : null;
    const lpQuoteAmount = quoteUsd > 0 ? lpQuoteUsd / quoteUsd : null;

    // Profile range & yield estimation
    const sigma = pool?.sigma != null ? num(pool.sigma) : null;
    const width = profileWidth(sigma, D, profKey) ?? (pool?.profiles?.[profKey]?.widthPct ? pool.profiles[profKey].widthPct / 100 : null);
    const rangeLower = (width !== null && poolPrice > 0) ? poolPrice * (1 - width) : (pool?.profiles?.[profKey]?.lower ?? null);
    const rangeUpper = (width !== null && poolPrice > 0) ? poolPrice * (1 + width) : (pool?.profiles?.[profKey]?.upper ?? null);

    const isBorrowVenue = venue?.id === "jupiter" || (!(num(venue?.fundingHourly) !== 0) && num(venue?.borrowHourly) > 0);
    const costCtx = {
      days: D,
      sigma,
      width,
      poolFeeRate,
      swapSlippage,
      solTxCostSol,
      lpTxCount,
      solPriceUsd: resolvedSolPrice,
      hedgeRatio,
      venueTaker,
      venueImpact,
      venueBorrowHourly: num(venue?.borrowHourly),
      venueFundingHourly: num(venue?.fundingHourly),
      isBorrowVenue
    };

    const ev = evalPoolAt(pool, width, lpUsd);
    const horizonCosts = horizonCostsAt(lpUsd, costCtx);
    const lpGrossYieldUsd = ev.earns !== null ? ev.earns * D * lpUsd : null;
    const lpIlCostUsd = ev.needs !== null ? ev.needs * D * lpUsd : null;
    const lpNetBeforeCostsUsd = ev.netDay !== null ? ev.netDay * D * lpUsd : null;
    const netProfitUsd = lpNetBeforeCostsUsd !== null ? lpNetBeforeCostsUsd - horizonCosts.totalUsd : null;
    const netProfitPctBudget = netProfitUsd !== null && B > 0 ? (netProfitUsd / B) * 100 : null;
    const netProfitPctLp = netProfitUsd !== null && lpUsd > 0 ? (netProfitUsd / lpUsd) * 100 : null;

    const dynMin = solveDynamicMinPosUsd(pool, width, D, costCtx);
    const poolStaticMin = pool?.profiles?.[profKey]?.minPosUsd ?? pool?.minPosUsd ?? null;
    const effectiveMinPosUsd = dynMin.minPosUsd !== null ? dynMin.minPosUsd : poolStaticMin;
    const poolMinOk = effectiveMinPosUsd !== null && lpUsd >= effectiveMinPosUsd;

    // Venue minimums
    const venueMinNotional = num(venue?.minNotionalUsd);
    const venueMinCollateral = num(venue?.minCollateralUsd);
    const meetsNotionalMin = !venue || venue.ok === false ? false : hedgeNotionalUsd >= venueMinNotional;
    const meetsCollateralMin = !venue || !venueMinCollateral || venue.id !== "jupiter"
      ? true
      : collateralBaseUsd >= venueMinCollateral;
    const venueMinOk = !!venue && venue.ok !== false && meetsNotionalMin && meetsCollateralMin;

    const warnings = [];
    if (!canAllocateLp) {
      warnings.push(`Orçamento US$${B.toFixed(2)} insuficiente até para reserva de ${solReserveSol} SOL (≈ US$${solReserveFullUsd.toFixed(2)}) + taxa de tx.`);
    }
    if (leverageClamped) {
      warnings.push(`Alavancagem ajustada de ${requestedLev}x para ${effectiveLeverage}x (limites do venue: ${vMinLev}x–${vMaxLev}x).`);
    }
    if (venue && venue.ok === false) {
      warnings.push(`Venue ${venue.name || venue.id} indisponível no momento (${venue.error || "erro"}).`);
    } else if (venue && !venueMinOk) {
      if (!meetsCollateralMin) {
        warnings.push(`Colateral no venue (US$${collateralBaseUsd.toFixed(2)}) abaixo do mínimo de US$${venueMinCollateral} do ${venue.name}.`);
      } else {
        warnings.push(`Notional do hedge (US$${hedgeNotionalUsd.toFixed(2)}) abaixo do mínimo do venue (US$${venueMinNotional.toFixed(2)}).`);
      }
    }
    if (effectiveMinPosUsd === null) {
      warnings.push(`Pool não empata os custos no horizonte de ${D}d (${dynMin.reason || pool?.minPosReason || "edge insuficiente"}).`);
    } else if (!poolMinOk) {
      warnings.push(`Orçamento B pequeno demais para empatar custos: LP de US$${lpUsd.toFixed(2)} abaixo do mínimo do pool (US$${effectiveMinPosUsd.toFixed(2)}).`);
    } else if (netProfitUsd !== null && netProfitUsd < 0) {
      warnings.push(`Lucro líquido estimado negativo (${netProfitUsd.toFixed(2)} USD) neste horizonte — B pequeno demais para cobrir custos.`);
    }
    if (pool?.bothVolatile) {
      warnings.push("Pool com dois tokens voláteis: o hedge de 0,5×P cobre apenas uma perna.");
    }
    if (Array.isArray(venue?.avisos)) {
      for (const av of venue.avisos) {
        if (!warnings.includes(av)) warnings.push(av);
      }
    }

    return {
      budgetUsd: B,
      days: D,
      profile: profKey,
      requestedLeverage: requestedLev,
      effectiveLeverage,
      leverageClamped,
      solPriceUsd: resolvedSolPrice,
      lpUsd,
      lpBaseUsd,
      lpQuoteUsd,
      lpBaseAmount,
      lpQuoteAmount,
      hedgeNotionalUsd,
      collateralBaseUsd,
      marginBufferUsd,
      collateralTotalUsd,
      solReserveSol,
      solReserveUsd,
      swapEntryUsd,
      perpOpenUsd,
      txEntryUsd,
      entryCostsUsd,
      totalAllocatedUsd,
      remainingUsd: Math.max(0, B - totalAllocatedUsd),
      range: {
        widthPct: width !== null ? width * 100 : null,
        lower: rangeLower,
        upper: rangeUpper,
        expectedRebalances: horizonCosts.rebalances
      },
      horizonCosts,
      lpGrossYieldUsd,
      lpIlCostUsd,
      lpNetBeforeCostsUsd,
      netProfitUsd,
      netProfitPctBudget,
      netProfitPctLp,
      minPosUsd: effectiveMinPosUsd,
      poolMinOk,
      venueMinOk,
      feasible: canAllocateLp && poolMinOk && venueMinOk && (netProfitUsd === null || netProfitUsd >= 0),
      warnings
    };
  }

  return {
    PROFILE_KS,
    DEFAULTS,
    lPerDollar,
    profileWidth,
    evalPoolAt,
    horizonCostsAt,
    solveDynamicMinPosUsd,
    solveBudget
  };
}));
