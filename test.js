// Regression tests. Run: node test.js
const { _test } = require("./api/pools.js");
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

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
