// GET /api/hedge?notional=10&days=7
// Compares live SOL short perp hedge costs across Solana-native venues (Jupiter Perps, Pacifica, Drift/Velocity).
//
// Empirical API formats & units (verified 2026-11-14):
// 1. Jupiter Perps: GET https://perps-api.jup.ag/v1/pool-info?mint=So11111111111111111111111111111111111111112
//    - shortBorrowRatePercent: string in PERCENT per hour (e.g. "0.0007" => 0.0007%/h => 0.000007 decimal/h).
//      Jupiter JLP has no p2p funding; shorts ALWAYS pay borrow on full notional.
//    - openFeePercent: string in PERCENT per side (e.g. "0.06" => 0.06% => 0.0006 decimal/side), charged on open & close.
//    - min impact: 0.01% per side (0.0001 decimal/side, per docs linear impact ceil to 1 bp).
//    - min collateral: US$10, min leverage: 1.1x (=> effective min notional US$11 at 1.1x), max leverage: 250x.
//
// 2. Pacifica: GET https://api.pacifica.fi/api/v1/info
//    - data[]: array of markets; filter symbol === "SOL" && instrument_type === "perpetual" (exclude "SOL-USDC" spot).
//    - funding_rate / next_funding_rate: string in DECIMAL per hour (e.g. "-0.0000003" => -0.00003%/h).
//      Convention: positive = longs pay shorts (short receives); negative = shorts pay longs.
//    - min_order_size: string in USD (e.g. "10" => US$10).
//    - max_leverage: number (e.g. 20).
//    - taker fee: 0.04% per side (0.0004 decimal/side, docs tier 1). Closed Beta product -> flagged "beta".
//
// 3. Drift / Velocity: GET https://data.velocity.exchange/stats/markets
//    - markets[]: array of markets; find symbol === "SOL-PERP".
//    - fees.taker: number in DECIMAL per side (e.g. 0.0002 => 0.02% = 2 bps).
//    - fees.maker: number in DECIMAL per side (e.g. -0.000025 => -0.0025% rebate).
//    - fundingRate: { long: string, short: string } in PERCENT per hour (e.g. short="0.00125" => 0.00125%/h => 0.0000125 decimal/h).
//      Unlabelled in JSON; verified against Velocity's 0.00125%/h (10.95% APR) dead-zone floor.
//      Positive fundingRate.short means shorts RECEIVE funding (longs pay shorts).
//    - limits.amount.min: number in SOL (e.g. 0.01 SOL). Converted to USD via oraclePrice/markPrice/price.
//    - limits.leverage: { min: 1, max: 20 }.
//    - quoteVolume: string in USD 24h volume; openInterest: { long, short } strings in SOL.

try { require("node:dns").setDefaultResultOrder?.("ipv4first"); } catch {}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TIMEOUT_MS = 8000;

const URLS = {
  jupiterApi: `https://perps-api.jup.ag/v1/pool-info?mint=${SOL_MINT}`,
  jupiterFeesDocs: "https://docs.jup.ag/user-docs/trade/perps/fees",
  jupiterPosDocs: "https://docs.jup.ag/user-docs/trade/perps/positions-and-collateral",
  pacificaApi: "https://api.pacifica.fi/api/v1/info",
  pacificaFeesDocs: "https://docs.pacifica.fi/trading-on-pacifica/trading-fees",
  pacificaFundingDocs: "https://docs.pacifica.fi/trading-on-pacifica/funding-rates",
  velocityApi: "https://data.velocity.exchange/stats/markets",
  velocityFeesDocs: "https://docs.velocity.exchange/protocol/trading/trading-fees",
  velocityFundingDocs: "https://docs.velocity.exchange/protocol/trading/funding-rates",
  velocitySpecsDocs: "https://docs.velocity.exchange/protocol/trading/market-specs"
};

const toNum = v => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchJsonWithTimeout(url, timeoutMs = TIMEOUT_MS, fetchImpl = fetch) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: ac.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    const causeMsg = e?.cause?.message || e?.cause?.code;
    if (causeMsg && e?.message === "fetch failed") {
      throw new Error(`fetch failed (${causeMsg})`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseJupiter(raw, { notional = 10, days = 7, leverage = null, queriedAt = new Date().toISOString() } = {}) {
  const openFeePct = toNum(raw?.openFeePercent);
  const shortBorrowPctHr = toNum(raw?.shortBorrowRatePercent);
  if (openFeePct === null || shortBorrowPctHr === null) {
    throw new Error("Jupiter response missing openFeePercent or shortBorrowRatePercent");
  }
  const takerRate = openFeePct / 100;         // % -> decimal per side (0.06% => 0.0006)
  const impactRate = 0.0001;                  // 0.01% minimum impact per side
  const borrowHourly = shortBorrowPctHr / 100; // %/h -> decimal/h (0.0007%/h => 0.000007/h)
  const minCollateralUsd = 10;
  const minLeverage = 1.1;
  const maxLeverage = 250;
  const minNotionalUsd = minCollateralUsd * minLeverage; // US$11 at 1.1x

  const custoTrade = 2 * (takerRate + impactRate) * notional;
  const carregamento = borrowHourly * 24 * days * notional; // positive = short pays
  const total = custoTrade + carregamento;
  const totalPct = notional > 0 ? (total / notional) * 100 : 0;

  const levToCheck = leverage !== null && Number.isFinite(leverage) && leverage > 0 ? leverage : minLeverage;
  const collateralAtLev = notional / levToCheck;
  const minimoOk = levToCheck >= minLeverage && levToCheck <= maxLeverage && collateralAtLev >= minCollateralUsd;

  const avisos = [];
  if (!minimoOk) {
    avisos.push(
      leverage !== null
        ? `colateral US$${collateralAtLev.toFixed(2)} abaixo do mínimo US$${minCollateralUsd} (alav ${minLeverage}x–${maxLeverage}x)`
        : `colateral mín US$${minCollateralUsd} (exige notional ≥ US$${minNotionalUsd.toFixed(0)} a 1,1x)`
    );
  }
  avisos.push("borrow contínuo: short sempre paga (não recebe funding)");

  return {
    id: "jupiter",
    name: "Jupiter Perps (SOL JLP)",
    chain: "Solana",
    collateral: "USDC",
    beta: false,
    ok: true,
    error: null,
    queriedAt,
    cheapest: false,
    takerRate,
    impactRate,
    fundingHourly: null,
    nextFundingHourly: null,
    borrowHourly,
    minNotionalUsd,
    minCollateralUsd,
    minOrderLabel: `colat. US$${minCollateralUsd} (≥ US$${minNotionalUsd.toFixed(0)} @ 1,1x)`,
    minLeverage,
    maxLeverage,
    volume24hUsd: null,
    openInterestSol: null,
    openInterestUsd: null,
    solPriceUsd: null,
    custoTrade,
    carregamento,
    total,
    totalPct,
    minimoOk,
    avisos,
    sources: {
      taker: URLS.jupiterApi,
      impact: URLS.jupiterFeesDocs,
      borrow: URLS.jupiterApi,
      minimo: URLS.jupiterPosDocs,
      maxLeverage: URLS.jupiterPosDocs
    }
  };
}

function parsePacifica(raw, { notional = 10, days = 7, leverage = null, queriedAt = new Date().toISOString() } = {}) {
  const list = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
  const m = list.find(x => x?.symbol === "SOL" && (!x.instrument_type || x.instrument_type === "perpetual"));
  if (!m) throw new Error("Pacifica response missing SOL perpetual market");

  const fundingHourly = toNum(m.funding_rate);         // decimal/h; positive = long pays short
  const nextFundingHourly = toNum(m.next_funding_rate); // decimal/h; positive = long pays short
  const minNotionalUsd = toNum(m.min_order_size);       // USD
  const maxLeverage = toNum(m.max_leverage);
  if (fundingHourly === null || minNotionalUsd === null) {
    throw new Error("Pacifica SOL market missing funding_rate or min_order_size");
  }

  const takerRate = 0.0004; // 0.04% per side (docs tier 1)
  const impactRate = 0;
  const minLeverage = 1;

  const custoTrade = 2 * takerRate * notional;
  const carregamento = -fundingHourly * 24 * days * notional; // negative = short receives
  const total = custoTrade + carregamento;
  const totalPct = notional > 0 ? (total / notional) * 100 : 0;

  const levOk = leverage === null || (leverage >= minLeverage && (maxLeverage === null || leverage <= maxLeverage));
  const minimoOk = notional >= minNotionalUsd && levOk;

  const avisos = ["beta (Closed Beta nas docs)"];
  if (notional < minNotionalUsd) {
    avisos.push(`abaixo do mínimo de ordem (US$${minNotionalUsd})`);
  }
  if (nextFundingHourly !== null && Math.sign(nextFundingHourly) !== Math.sign(fundingHourly) && nextFundingHourly !== 0) {
    avisos.push(`próximo funding inverte sinal (${(nextFundingHourly * 100).toFixed(5)}%/h)`);
  }

  return {
    id: "pacifica",
    name: "Pacifica (SOL)",
    chain: "Solana",
    collateral: "USDC",
    beta: true,
    ok: true,
    error: null,
    queriedAt,
    cheapest: false,
    takerRate,
    impactRate,
    fundingHourly,
    nextFundingHourly,
    borrowHourly: 0,
    minNotionalUsd,
    minCollateralUsd: 10, // docs: min deposit US$10
    minOrderLabel: `US$${minNotionalUsd} min`,
    minLeverage,
    maxLeverage: maxLeverage ?? 20,
    volume24hUsd: null,
    openInterestSol: null,
    openInterestUsd: null,
    solPriceUsd: null,
    custoTrade,
    carregamento,
    total,
    totalPct,
    minimoOk,
    avisos,
    sources: {
      taker: URLS.pacificaFeesDocs,
      funding: URLS.pacificaApi,
      fundingDocs: URLS.pacificaFundingDocs,
      minimo: URLS.pacificaApi,
      maxLeverage: URLS.pacificaApi
    }
  };
}

function parseVelocity(raw, { notional = 10, days = 7, leverage = null, queriedAt = new Date().toISOString() } = {}) {
  const list = Array.isArray(raw?.markets) ? raw.markets : (Array.isArray(raw) ? raw : []);
  const m = list.find(x => x?.symbol === "SOL-PERP");
  if (!m) throw new Error("Velocity response missing SOL-PERP market");

  const takerRate = toNum(m?.fees?.taker);                  // decimal/side (0.0002 => 2 bps)
  const shortFundingPctHr = toNum(m?.fundingRate?.short);   // %/h (positive => short receives)
  const minSol = toNum(m?.limits?.amount?.min);             // SOL (0.01)
  const solPriceUsd = toNum(m.oraclePrice) ?? toNum(m.markPrice) ?? toNum(m.price);
  if (takerRate === null || shortFundingPctHr === null || minSol === null || !(solPriceUsd > 0)) {
    throw new Error("Velocity SOL-PERP missing fees, fundingRate, limits, or price");
  }

  const fundingHourly = shortFundingPctHr / 100; // %/h -> decimal/h
  const minNotionalUsd = minSol * solPriceUsd;
  const minLeverage = toNum(m?.limits?.leverage?.min) ?? 1;
  const maxLeverage = toNum(m?.limits?.leverage?.max) ?? 20;
  const volume24hUsd = toNum(m.quoteVolume) ?? 0;
  const oiLongSol = Math.abs(toNum(m?.openInterest?.long) ?? 0);
  const oiShortSol = Math.abs(toNum(m?.openInterest?.short) ?? 0);
  const openInterestUsd = Math.max(oiLongSol, oiShortSol) * solPriceUsd;

  const impactRate = 0;
  const custoTrade = 2 * takerRate * notional;
  const carregamento = -fundingHourly * 24 * days * notional; // negative = short receives
  const total = custoTrade + carregamento;
  const totalPct = notional > 0 ? (total / notional) * 100 : 0;

  const levOk = leverage === null || (leverage >= minLeverage && leverage <= maxLeverage);
  const minimoOk = notional >= minNotionalUsd && levOk;

  const avisos = [];
  if (volume24hUsd < 1_000_000) {
    avisos.push(`livro fino (vol 24h US$${Math.round(volume24hUsd).toLocaleString("en-US")} < US$1M)`);
  }
  if (notional < minNotionalUsd) {
    avisos.push(`abaixo do mínimo (${minSol} SOL ≈ US$${minNotionalUsd.toFixed(2)})`);
  }

  return {
    id: "velocity",
    name: "Drift / Velocity (SOL-PERP)",
    chain: "Solana",
    collateral: "USDT",
    beta: false,
    ok: true,
    error: null,
    queriedAt,
    cheapest: false,
    takerRate,
    makerRate: toNum(m?.fees?.maker),
    impactRate,
    fundingHourly,
    nextFundingHourly: null,
    borrowHourly: 0,
    minNotionalUsd,
    minCollateralUsd: null,
    minOrderLabel: `${minSol} SOL (≈ US$${minNotionalUsd.toFixed(2)})`,
    minLeverage,
    maxLeverage,
    volume24hUsd,
    openInterestSol: { long: oiLongSol, short: oiShortSol },
    openInterestUsd,
    solPriceUsd,
    custoTrade,
    carregamento,
    total,
    totalPct,
    minimoOk,
    avisos,
    sources: {
      taker: URLS.velocityApi,
      takerDocs: URLS.velocityFeesDocs,
      funding: URLS.velocityApi,
      fundingDocs: URLS.velocityFundingDocs,
      minimo: URLS.velocityApi,
      maxLeverage: URLS.velocityApi,
      volume24h: URLS.velocityApi,
      openInterest: URLS.velocityApi
    }
  };
}

function rankVenues(venues) {
  const sorted = [...venues].sort((a, b) => {
    const aErr = !a.ok || a.total === null || !Number.isFinite(a.total);
    const bErr = !b.ok || b.total === null || !Number.isFinite(b.total);
    if (aErr !== bErr) return aErr ? 1 : -1;
    if (aErr && bErr) return 0;
    if (a.total !== b.total) return a.total - b.total;
    if (a.minimoOk !== b.minimoOk) return a.minimoOk ? -1 : 1;
    return 0;
  });
  let cheapestId = null;
  for (const v of sorted) {
    v.cheapest = false;
    if (!cheapestId && v.ok && v.minimoOk) {
      v.cheapest = true;
      cheapestId = v.id;
    }
  }
  return { venues: sorted, cheapest: cheapestId };
}

async function queryHedge({ notional = 10, days = 7, leverage = null, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const queriedAt = new Date().toISOString();
  const specs = [
    { id: "jupiter", name: "Jupiter Perps (SOL JLP)", url: URLS.jupiterApi, parse: parseJupiter },
    { id: "pacifica", name: "Pacifica (SOL)", url: URLS.pacificaApi, parse: parsePacifica },
    { id: "velocity", name: "Drift / Velocity (SOL-PERP)", url: URLS.velocityApi, parse: parseVelocity }
  ];

  const results = await Promise.all(specs.map(async (sp) => {
    const vTime = new Date().toISOString();
    try {
      const json = await fetchJsonWithTimeout(sp.url, timeoutMs, fetchImpl);
      return sp.parse(json, { notional, days, leverage, queriedAt: new Date().toISOString() });
    } catch (e) {
      return {
        id: sp.id,
        name: sp.name,
        chain: "Solana",
        ok: false,
        error: String(e?.message || e),
        queriedAt: vTime,
        cheapest: false,
        minimoOk: false,
        custoTrade: null,
        carregamento: null,
        total: null,
        totalPct: null,
        avisos: ["erro na consulta ao vivo"],
        sources: { api: sp.url }
      };
    }
  }));

  const { venues, cheapest } = rankVenues(results);
  return {
    queriedAt,
    notional,
    days,
    leverage,
    cheapest,
    venues
  };
}

const posNum = (v, def, min = 0, max = 1e9) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > min ? Math.min(max, n) : def;
};

module.exports = async (req, res) => {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  res.setHeader("cache-control", "no-store");
  try {
    const notional = posNum(q.notional, 10, 0, 1e9);
    const days = posNum(q.days, 7, 0, 3650);
    const levRaw = parseFloat(q.leverage);
    const leverage = Number.isFinite(levRaw) && levRaw > 0 ? levRaw : null;
    const out = await queryHedge({ notional, days, leverage });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
};

module.exports._test = {
  URLS,
  TIMEOUT_MS,
  parseJupiter,
  parsePacifica,
  parseVelocity,
  rankVenues,
  queryHedge,
  fetchJsonWithTimeout
};
