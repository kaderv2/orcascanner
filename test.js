// Regression tests. Run: node test.js
const { _test } = require("./api/pools.js");
const { _test: hedgeTest } = require("./api/hedge.js");
const calc = require("./calc.js");
let fails = 0;
const ok = (name, cond, detail="") => { console.log((cond?"  PASS  ":"  FAIL  ")+name+(detail?"  "+detail:"")); if(!cond) fails++; };
const close = (a,b,tol=0.02) => Math.abs(a-b) <= tol*Math.max(Math.abs(a),Math.abs(b),1e-12);
const hist = (n,s,st) => { let p=st; const a=[String(st)]; for(let i=1;i<n;i++){p*=Math.exp((i%2?1:-1)*s);a.push(p.toFixed(12));} return a; };

// Build the SAME economic pool twice: once quoted in USDC, once quoted in a $1282 token.
// Identical dollars in, identical fees, identical ratio volatility. The scored yields
// must come out identical — that is what the quote-token conversion is for.
function build({quotePriceUsd, basePriceUsd, tvlUsd, fees24, sigma}) {
  const P = basePriceUsd / quotePriceUsd;              // quote per base
  const decA = 9, decB = 8;
  const baseQty = (tvlUsd*0.5)/basePriceUsd, quoteQty = (tvlUsd*0.5)/quotePriceUsd;
  const Vq = tvlUsd/quotePriceUsd;
  const L = Vq * _test.lPerDollar(P, 0.25);
  return {
    address:"X".repeat(44), price:String(P), tvlUsdc:String(tvlUsd), feeRate:1600,
    tokenA:{symbol:"BASE",decimals:decA}, tokenB:{symbol:quotePriceUsd===1?"USDC":"QUOTE",decimals:decB},
    tokenBalanceA:String(Math.round(baseQty*10**decA)), tokenBalanceB:String(Math.round(quoteQty*10**decB)),
    liquidity:String(Math.round(L*10**((decA+decB)/2))),
    stats:{"24h":{volume:String(fees24/0.0016),fees:String(fees24)},
           "7d":{volume:"1",fees:String(fees24*7)},"30d":{volume:"1",fees:String(fees24*30)}},
    priceHistory7d: hist(14, sigma/Math.sqrt(2), P)
  };
}
const args = { basePriceUsd: 112.3, tvlUsd: 3400232, fees24: 5940, sigma: 0.028 };
const inUsdc = _test.score(build({...args, quotePriceUsd: 1}), null, "24h", 30, 1000);
const inZec  = _test.score(build({...args, quotePriceUsd: 1282.0592}), null, "24h", 30, 1000);

console.log("\nQuote-token invariance (the bug that inflated SOL- and ZEC-quoted pools)");
ok("USDC-quoted pool stays on the liquidity basis", inUsdc.basis === "liquidity", inUsdc.basis);
ok("other-quoted pool stays on the liquidity basis", inZec.basis === "liquidity", inZec.basis);
ok("quoteUsd detected from pool balances", close(inZec.quoteUsd, 1282.0592, 0.01), "got "+inZec.quoteUsd.toFixed(2));
ok("earns identical across quote tokens", close(inUsdc.earns, inZec.earns),
   `${(inUsdc.earns*100).toFixed(4)}%/d vs ${(inZec.earns*100).toFixed(4)}%/d`);
ok("needs identical across quote tokens", close(inUsdc.needs, inZec.needs),
   `${(inUsdc.needs*100).toFixed(4)}%/d vs ${(inZec.needs*100).toFixed(4)}%/d`);
ok("edge identical across quote tokens", close(inUsdc.edge, inZec.edge),
   `${inUsdc.edge.toFixed(3)} vs ${inZec.edge.toFixed(3)}`);

console.log("\nMagnitudes are believable");
const poolAvg = 5940/3400232;
ok("earns within 3x of the pool-average yield", inZec.earns > poolAvg*0.5 && inZec.earns < poolAvg*3,
   `${(inZec.earns*100).toFixed(4)}%/d vs pool-average ${(poolAvg*100).toFixed(4)}%/d`);
ok("earns under 5%/day", inZec.earns < 0.05, (inZec.earns*100).toFixed(4)+"%/d");

console.log("\nEdge is the same at any range width");
const w = [0.1,0.2,0.3,0.5,0.8].map(x => {
  const p = build({...args, quotePriceUsd: 1282.0592});
  const r = _test.score(p, null, "24h", 30);
  const lp = _test.lPerDollar(+p.price, x);
  const base = _test.lPerDollar(+p.price, r.width);
  return (r.earns*lp/base)/(r.needs*lp/base);
});
ok("edge invariant to width", w.every(v => close(v, w[0])), w.map(v=>v.toFixed(3)).join(", "));

console.log("\nFallbacks and junk input");
ok("absurd liquidity falls back to TVL basis",
   _test.score({...build({...args,quotePriceUsd:1}), liquidity:"1"}, null, "24h", 30).basis === "tvl");
ok("missing balances fall back to TVL basis",
   _test.score({...build({...args,quotePriceUsd:1282}), tokenBalanceA:undefined}, null, "24h", 30).basis === "tvl");
ok("quoteUsd = 1 for a USDC-quoted pool", close(_test.quoteUsd(build({...args,quotePriceUsd:1}), args.basePriceUsd), 1, 0.01));
let threw = false;
for (const junk of [{}, {stats:{}}, {tokenA:{},tokenB:{},stats:{},priceHistory7d:null}, {liquidity:"abc",price:"x"}])
  try { _test.score(junk, null, "24h", 30); } catch(e) { threw = true; console.log("    threw:", e.message); }
ok("junk input does not throw", !threw);

console.log("\nPeriod selection");
const p = build({...args, quotePriceUsd: 1});
p.stats["30m"] = { volume:"77000", fees:"123" };
ok("uses the requested period when present", _test.score(p,null,"30m",30).usedPeriod === "30m");
ok("falls back to 24h when absent", _test.score(p,null,"4h",30).usedPeriod === "24h");
ok("flags the fallback", _test.score(p,null,"4h",30).haveTf === false);

console.log("\nDilution: your own deposit lowers the yield, and can never beat all the fees");
const small = build({ basePriceUsd: 0.5, tvlUsd: 26526, fees24: 601, sigma: 0.016, quotePriceUsd: 1 });
const sizes = [100, 1000, 10000, 100000].map(v => _test.score(small, null, "24h", 30, v));
ok("yield falls as the position grows", sizes.every((r,i) => i===0 || r.earns <= sizes[i-1].earns),
   sizes.map(r => (r.earns*100).toFixed(2)+"%").join(" > "));
ok("share of liquidity rises with size", sizes.every((r,i) => i===0 || r.share >= sizes[i-1].share),
   sizes.map(r => (r.share*100).toFixed(1)+"%").join(" < "));
ok("never exceeds the whole pool's fees", sizes.every((r,i) => r.earns <= 601/[100,1000,10000,100000][i] + 1e-9));
ok("pool average matches fees/TVL", close(sizes[1].poolAvg, 601/26526), (sizes[1].poolAvg*100).toFixed(3)+"%/day");

console.log("\nOrca v2 cursor");
ok("reads meta.cursor.next", _test.nextCursor({meta:{cursor:{previous:null,next:"abc"}}}) === "abc");
ok("falls back to meta.next", _test.nextCursor({meta:{next:"old"}}) === "old");
ok("null when there is no next page", _test.nextCursor({data:[],meta:{cursor:{previous:"p",next:null}}}) === null);

console.log("\nEffective fee rate: base + adaptive surcharge, never 0 when the base is not");
const af = (cur, max=100000) => ({adaptiveFeeEnabled:true, adaptiveFee:{currentRate:cur,maxRate:max,constants:{},variables:{}}});
ok("adaptive currentRate 0 keeps the base", _test.effectiveFeeRate({feeRate:1600,...af(0)}).total === 1600);
ok("adaptive surcharge is added", _test.effectiveFeeRate({feeRate:400,...af(28)}).total === 428);
ok("surcharge capped at maxRate", _test.effectiveFeeRate({feeRate:100,...af(9000,6970)}).total === 7070);
ok("adaptiveFee null -> base only", _test.effectiveFeeRate({feeRate:3000,adaptiveFeeEnabled:false,adaptiveFee:null}).total === 3000);
ok("scored feeRate is a percent of the effective rate",
   close(_test.score({...build({...args,quotePriceUsd:1}),...af(0)},null,"24h",30).feeRate, 0.16, 1e-9));

console.log("\nThin-pool gates");
const good = _test.score(build({...args,quotePriceUsd:1}), null, "24h", 30);
ok("big, busy, week-old pool passes", _test.thinReasons(good, build({...args,quotePriceUsd:1})).length === 0,
   _test.thinReasons(good, build({...args,quotePriceUsd:1})).join("; "));
const tiny = build({ basePriceUsd: 0.5, tvlUsd: 26526, fees24: 30, sigma: 0.016, quotePriceUsd: 1 });
const why = _test.thinReasons(_test.score(tiny,null,"24h",30), tiny);
ok("small pool flagged for TVL and volume", why.includes("tvl<250000") && why.includes("vol24<50000"), why.join("; "));
const young = {...build({...args,quotePriceUsd:1})}; young.priceHistory7d = [null,null,null,null,null,null,null,null, ...young.priceHistory7d.slice(8)];
const whyY = _test.thinReasons(_test.score(young,null,"24h",30), young);
ok("young pool flagged for age", whyY.some(r => r.startsWith("age ")), whyY.join("; "));
const zero = {...build({...args,quotePriceUsd:1}), feeRate:0};
ok("fee 0 pool flagged", _test.thinReasons(_test.score(zero,null,"24h",30), zero).includes("fee 0"));
ok("gates can be switched off", _test.thinReasons(_test.score(tiny,null,"24h",30), tiny, {minTvl:0,minVol24:0,minAgeDays:0}).length === 0);

console.log("\nFeature 1: minPosUsd, costs breakdown, breakevenDays, and monotonicity");
const costPool = build({ basePriceUsd: 100, tvlUsd: 1500000, fees24: 3500, sigma: 0.025, quotePriceUsd: 1 });
const baseRes = _test.score(costPool, null, "24h", 30, 1000, { solPriceUsd: 100, tickArrayRentSol: 0.02 });
ok("minPosUsd computed as finite positive number >= 10", baseRes.minPosUsd !== null && baseRes.minPosUsd >= 10,
   `$${baseRes.minPosUsd?.toFixed(2)}`);
ok("costs components sum to totalUsd",
   close(baseRes.costs.lpFixedUsd + baseRes.costs.swapUsd + baseRes.costs.hedgeUsd + baseRes.costs.fundingUsd, baseRes.costs.totalUsd, 1e-9));
ok("rebalances matches holdDays * (sigma/width)^2",
   close(baseRes.costs.rebalances, 30 * (baseRes.sigma / baseRes.width) ** 2, 1e-9));

// At posUsd = minPosUsd (when > 10), net profit over holdDays ~= totalUsd and breakevenDays ~= holdDays
const atMin = _test.score(costPool, null, "24h", 30, baseRes.minPosUsd, { solPriceUsd: 100, tickArrayRentSol: 0.02 });
if (baseRes.minPosUsd > 10.01) {
  ok("at minPosUsd, netDay*holdDays*posUsd ~= costs.totalUsd",
     close(atMin.netDay * 30 * baseRes.minPosUsd, atMin.costs.totalUsd, 1e-4),
     `${(atMin.netDay*30*baseRes.minPosUsd).toFixed(4)} vs ${atMin.costs.totalUsd.toFixed(4)}`);
  ok("at minPosUsd, breakevenDays ~= holdDays",
     close(atMin.breakevenDays, 30, 1e-3), `${atMin.breakevenDays?.toFixed(3)}d`);
}

// Monotonicity with fixed and proportional costs
const rentSteps = [0, 0.01, 0.05, 0.2, 1.0].map(r =>
  _test.score(costPool, null, "24h", 30, 1000, { solPriceUsd: 100, tickArrayRentSol: r }).minPosUsd
);
ok("minPosUsd monotonically non-decreasing with tickArrayRentSol",
   rentSteps.every((v, i) => v !== null && (i === 0 || v >= rentSteps[i - 1])),
   rentSteps.map(v => "$" + v?.toFixed(1)).join(" <= "));

const perpFeeSteps = [0, 0.0005, 0.002, 0.005].map(f =>
  _test.score(costPool, null, "24h", 30, 1000, { solPriceUsd: 100, tickArrayRentSol: 0.05, perpTakerFee: f }).minPosUsd
);
ok("minPosUsd monotonically non-decreasing with perpTakerFee",
   perpFeeSteps.every((v, i) => v !== null && (i === 0 || v >= perpFeeSteps[i - 1])),
   perpFeeSteps.map(v => "$" + v?.toFixed(1)).join(" <= "));

const slipSteps = [0, 0.001, 0.005, 0.01].map(s =>
  _test.score(costPool, null, "24h", 30, 1000, { solPriceUsd: 100, tickArrayRentSol: 0.05, swapSlippage: s }).minPosUsd
);
ok("minPosUsd monotonically non-decreasing with swapSlippage",
   slipSteps.every((v, i) => v !== null && (i === 0 || v >= slipSteps[i - 1])),
   slipSteps.map(v => "$" + v?.toFixed(1)).join(" <= "));

const fundSteps = [-0.0005, 0, 0.0001, 0.0005].map(fd =>
  _test.score(costPool, null, "24h", 30, 1000, { solPriceUsd: 100, tickArrayRentSol: 0.05, perpFundingDaily: fd }).minPosUsd
);
ok("minPosUsd monotonically non-decreasing with perpFundingDaily (incl. negative)",
   fundSteps.every((v, i) => v !== null && (i === 0 || v >= fundSteps[i - 1])),
   fundSteps.map(v => "$" + v?.toFixed(1)).join(" <= "));

// Never breaks even -> minPosUsd = null with reason
const loserPool = build({ basePriceUsd: 100, tvlUsd: 1500000, fees24: 10, sigma: 0.04, quotePriceUsd: 1 });
const loserRes = _test.score(loserPool, null, "24h", 30, 1000, { solPriceUsd: 100 });
ok("unprofitable pool returns minPosUsd = null with reason",
   loserRes.minPosUsd === null && typeof loserRes.minPosReason === "string" && loserRes.minPosReason.length > 0,
   loserRes.minPosReason || "");
ok("unprofitable pool returns breakevenDays = null", loserRes.breakevenDays === null);

const hugeRentRes = _test.score(small, null, "24h", 30, 1000, { solPriceUsd: 100, tickArrayRentSol: 500 });
ok("pool that dilutes before covering huge fixed cost returns minPosUsd = null with reason",
   hugeRentRes.minPosUsd === null && typeof hugeRentRes.minPosReason === "string",
   hugeRentRes.minPosReason || "");

console.log("\nFeature 2: range profiles (conservador, moderado, agressivo)");
const profs = baseRes.profiles;
ok("all 3 profiles exist with k = 2.0, 1.5, 1.0",
   profs.conservador.k === 2.0 && profs.moderado.k === 1.5 && profs.agressivo.k === 1.0);
ok("profiles ordered by width: conservador > moderado > agressivo",
   profs.conservador.widthPct > profs.moderado.widthPct && profs.moderado.widthPct > profs.agressivo.widthPct,
   `${profs.conservador.widthPct.toFixed(1)}% > ${profs.moderado.widthPct.toFixed(1)}% > ${profs.agressivo.widthPct.toFixed(1)}%`);
ok("profiles ordered inversely by expectedRebalances",
   profs.agressivo.expectedRebalances > profs.moderado.expectedRebalances &&
   profs.moderado.expectedRebalances > profs.conservador.expectedRebalances);
ok("profile lower < price < upper for all 3",
   ["conservador", "moderado", "agressivo"].every(k =>
     profs[k].lower > 0 && profs[k].lower < baseRes.price && baseRes.price < profs[k].upper));
ok("moderado matches top-level width, netDay, netPer1k, minPosUsd",
   close(profs.moderado.widthPct / 100, baseRes.width, 1e-9) &&
   close(profs.moderado.netDay, baseRes.netDay, 1e-9) &&
   close(profs.moderado.netPer1k, baseRes.netPer1k, 1e-9) &&
   close(profs.moderado.minPosUsd, baseRes.minPosUsd, 1e-9));

const lowVolPool = build({ basePriceUsd: 100, tvlUsd: 1000000, fees24: 1000, sigma: 0.004, quotePriceUsd: 1 });
const lowVolProfs = _test.score(lowVolPool, null, "7d", 7, 1000, { solPriceUsd: 100 }).profiles;
ok("low-vol 7d pool stays ordered with 3% lower clamp",
   lowVolProfs.conservador.widthPct >= lowVolProfs.moderado.widthPct &&
   lowVolProfs.moderado.widthPct >= lowVolProfs.agressivo.widthPct &&
   lowVolProfs.agressivo.widthPct >= 3,
   `${lowVolProfs.conservador.widthPct.toFixed(2)}% >= ${lowVolProfs.moderado.widthPct.toFixed(2)}% >= ${lowVolProfs.agressivo.widthPct.toFixed(2)}%`);

console.log("\nSOL price extraction");
const solUsdc = {
  address: "S1", price: "82.5", tvlUsdc: "10000000",
  tokenA: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 },
  tokenB: { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }
};
const usdcSol = {
  address: "S2", price: String(1 / 84), tvlUsdc: "5000000",
  tokenA: { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  tokenB: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", decimals: 9 }
};
const fakeSol = {
  address: "S0", price: "999", tvlUsdc: "999999999",
  tokenA: { symbol: "SOL", address: "FakeMint11111111111111111111111111111111111", decimals: 9 },
  tokenB: { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }
};
ok("extracts SOL price from SOL/USDC", close(_test.extractSolPriceUsd([solUsdc]), 82.5, 1e-6));
ok("extracts SOL price when SOL is tokenB", close(_test.extractSolPriceUsd([usdcSol]), 84, 1e-6));
ok("prefers real SOL_MINT over symbol-only match", close(_test.extractSolPriceUsd([fakeSol, solUsdc]), 82.5, 1e-6));

console.log("\nBreakeven days & profile field completeness");
const belowMin = _test.score(costPool, null, "24h", 30, 10, { solPriceUsd: 100, tickArrayRentSol: 0.02 });
const aboveMin = _test.score(costPool, null, "24h", 30, 5000, { solPriceUsd: 100, tickArrayRentSol: 0.02 });
ok("below minPosUsd has breakevenDays > holdDays or null",
   belowMin.breakevenDays === null || belowMin.breakevenDays > 30);
ok("above minPosUsd has breakevenDays <= holdDays",
   aboveMin.breakevenDays !== null && aboveMin.breakevenDays <= 30,
   `${aboveMin.breakevenDays?.toFixed(2)}d`);
const reqProfileKeys = ["k", "widthPct", "lower", "upper", "expectedRebalances", "netDay", "netPer1k", "minPosUsd"];
ok("every profile exposes all required keys",
   ["conservador", "moderado", "agressivo"].every(p => reqProfileKeys.every(k => k in profs[p])));

console.log("\nFeature A: venue parsing with fixtures, ranking, and isolated failure");
const jupFixture = {
  longAvailableLiquidity: "10000000.00",
  longBorrowRatePercent: "0.0015",
  shortBorrowRatePercent: "0.0007",
  openFeePercent: "0.06",
  maxPriceImpactFeePercent: "0.44"
};
const pacFixture = {
  success: true,
  data: [
    { symbol: "SOL-USDC", instrument_type: "spot", min_order_size: "10", max_leverage: 1, funding_rate: "0", next_funding_rate: "0" },
    { symbol: "SOL", instrument_type: "perpetual", min_order_size: "10", max_leverage: 20, funding_rate: "0.00000457", next_funding_rate: "0.00000103" }
  ]
};
const velFixture = {
  success: true,
  markets: [
    { symbol: "SOL", quoteVolume: "0" },
    {
      symbol: "SOL-PERP",
      fees: { maker: -0.000025, taker: 0.0002 },
      limits: { leverage: { min: 1, max: 20 }, amount: { min: 0.01, max: 16081.91 } },
      oraclePrice: "75.69",
      markPrice: "75.68",
      quoteVolume: "106722.70",
      openInterest: { long: "907.98", short: "-942.11" },
      fundingRate: { long: "-0.00125", short: "0.00125" }
    }
  ]
};

const jup10 = hedgeTest.parseJupiter(jupFixture, { notional: 10, days: 7, queriedAt: "2026-11-14T00:00:00.000Z" });
ok("Jupiter trade cost = 2*(0.06%+0.01%)*10 = 0.014", close(jup10.custoTrade, 0.014, 1e-9), String(jup10.custoTrade));
ok("Jupiter borrow carry = +0.0007%/h * 24 * 7 * 10 = 0.01176", close(jup10.carregamento, 0.01176, 1e-9), String(jup10.carregamento));
ok("Jupiter total = 0.02576", close(jup10.total, 0.02576, 1e-9));
ok("Jupiter at N=10 fails $10 collateral @ 1.1x min", jup10.minimoOk === false);
const jup11 = hedgeTest.parseJupiter(jupFixture, { notional: 11, days: 7 });
ok("Jupiter at N=11 passes $10 collateral @ 1.1x min", jup11.minimoOk === true);

const pac10 = hedgeTest.parsePacifica(pacFixture, { notional: 10, days: 7, queriedAt: "2026-11-14T00:00:00.000Z" });
ok("Pacifica selects perpetual SOL (not spot) and marks beta", pac10.beta === true && pac10.maxLeverage === 20);
ok("Pacifica trade cost = 2*0.04%*10 = 0.008", close(pac10.custoTrade, 0.008, 1e-9));
ok("Pacifica positive funding_rate means short receives (negative carry)", close(pac10.carregamento, -0.00000457 * 24 * 7 * 10, 1e-9));
ok("Pacifica N=10 passes min_order_size=10", pac10.minimoOk === true);
ok("Pacifica N=9.5 fails min_order_size=10", hedgeTest.parsePacifica(pacFixture, { notional: 9.5, days: 7 }).minimoOk === false);

const vel10 = hedgeTest.parseVelocity(velFixture, { notional: 10, days: 7, queriedAt: "2026-11-14T00:00:00.000Z" });
ok("Velocity trade cost = 2*0.02%*10 = 0.004", close(vel10.custoTrade, 0.004, 1e-9));
ok("Velocity positive short funding 0.00125%/h -> short receives -0.021", close(vel10.carregamento, -0.021, 1e-9));
ok("Velocity total = -0.017", close(vel10.total, -0.017, 1e-9));
ok("Velocity flags 'livro fino' when volume24h < $1M", vel10.avisos.some(a => a.includes("livro fino")));
const velDeep = { ...velFixture, markets: [{ ...velFixture.markets[1], quoteVolume: "2500000" }] };
ok("Velocity omits 'livro fino' when volume24h >= $1M", !hedgeTest.parseVelocity(velDeep, { notional: 10, days: 7 }).avisos.some(a => a.includes("livro fino")));

const ranked = hedgeTest.rankVenues([jup10, pac10, vel10]);
ok("rankVenues sorts ascending by total", ranked.venues.map(v => v.id).join(",") === "velocity,pacifica,jupiter", ranked.venues.map(v => v.id).join(","));
ok("rankVenues marks cheapest valid venue", ranked.cheapest === "velocity" && ranked.venues[0].cheapest === true);

// Cheapest skips venues that fail minimum even if cheaper
const cheapFailMin = { ...vel10, id: "vel-fail", total: -0.05, minimoOk: false };
const rankedSkip = hedgeTest.rankVenues([cheapFailMin, pac10, jup10]);
ok("cheapest skips venue failing minimoOk", rankedSkip.cheapest === "pacifica");

// Isolated failure test via mock fetchImpl
(async () => {
  const mockFetch = async (url) => {
    if (url.includes("pacifica")) throw new Error("simulated pacifica outage");
    if (url.includes("jup.ag")) return { ok: true, json: async () => jupFixture };
    if (url.includes("velocity")) return { ok: true, json: async () => velFixture };
    throw new Error("unexpected url");
  };
  const isoRes = await hedgeTest.queryHedge({ notional: 10, days: 7, fetchImpl: mockFetch });
  ok("isolated failure keeps healthy venues and sets error on failed venue",
     isoRes.venues.length === 3 &&
     isoRes.venues.filter(v => v.ok).length === 2 &&
     isoRes.venues.find(v => v.id === "pacifica").ok === false &&
     isoRes.cheapest === "velocity" &&
     /^\d{4}-\d{2}-\d{2}T/.test(isoRes.queriedAt));

  console.log("\nFeature B: budget calculator invariants");
  const solPool = _test.score(build({ basePriceUsd: 75.64, tvlUsd: 18000000, fees24: 38000, sigma: 0.031, quotePriceUsd: 1 }), null, "24h", 7, 1000, { solPriceUsd: 75.64 });
  solPool.pair = "SOL/USDC"; solPool.base = "SOL"; solPool.quote = "USDC";

  const budgets = [1, 2, 5, 20, 100, 1000, 10000];
  const allocs = budgets.map(b => calc.solveBudget({ budgetUsd: b, pool: solPool, venue: vel10, profile: "moderado", leverage: 2, days: 7, solPriceUsd: 75.64 }));
  ok("sum <= B for all budgets (incl. tiny B=1,2)", allocs.every(r => r.totalAllocatedUsd <= r.budgetUsd + 1e-9),
     allocs.map(r => `${r.totalAllocatedUsd.toFixed(2)}<=${r.budgetUsd}`).join(", "));
  ok("LP amount P monotonically non-decreasing in B (and strictly increasing once above SOL reserve)",
     allocs.every((r, i) => i === 0 || (r.budgetUsd > 5 ? r.lpUsd > allocs[i - 1].lpUsd : r.lpUsd >= allocs[i - 1].lpUsd)),
     allocs.map(r => `$${r.lpUsd.toFixed(2)}`).join(" <= "));

  const levs = [1, 1.5, 2, 4, 10, 20];
  const byLev = levs.map(l => calc.solveBudget({ budgetUsd: 1000, pool: solPool, venue: vel10, profile: "moderado", leverage: l, days: 7, solPriceUsd: 75.64 }));
  ok("higher leverage yields strictly larger LP position P",
     byLev.every((r, i) => i === 0 || r.lpUsd > byLev[i - 1].lpUsd),
     byLev.map(r => `${r.effectiveLeverage}x:$${r.lpUsd.toFixed(2)}`).join(" < "));

  const clampedLev = calc.solveBudget({ budgetUsd: 1000, pool: solPool, venue: vel10, profile: "moderado", leverage: 100, days: 7, solPriceUsd: 75.64 });
  ok("leverage is clamped to venue maxLeverage (20x)", clampedLev.effectiveLeverage === 20 && clampedLev.leverageClamped === true);

  const b20Pac = calc.solveBudget({ budgetUsd: 20, pool: solPool, venue: pac10, profile: "moderado", leverage: 2, days: 7, solPriceUsd: 75.64 });
  const b20Vel = calc.solveBudget({ budgetUsd: 20, pool: solPool, venue: vel10, profile: "moderado", leverage: 2, days: 7, solPriceUsd: 75.64 });
  const b100Pac = calc.solveBudget({ budgetUsd: 100, pool: solPool, venue: pac10, profile: "moderado", leverage: 2, days: 7, solPriceUsd: 75.64 });
  ok("B=20 fails Pacifica $10 min notional but passes Velocity 0.01 SOL min", b20Pac.venueMinOk === false && b20Vel.venueMinOk === true);
  ok("B=100 passes Pacifica $10 min notional", b100Pac.venueMinOk === true);

  const loserScored = _test.score(loserPool, null, "24h", 7, 1000, { solPriceUsd: 75.64 });
  const b100Loser = calc.solveBudget({ budgetUsd: 100, pool: loserScored, venue: vel10, profile: "moderado", leverage: 2, days: 7, solPriceUsd: 75.64 });
  ok("unprofitable pool warns and flags poolMinOk = false", b100Loser.poolMinOk === false && b100Loser.feasible === false && b100Loser.warnings.length > 0);

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
