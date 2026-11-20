// Replays headroom_calc_vectors_v1.json against headroom_calc_v1.js.
// Exact fields must be equal; model (float) fields within 1e-9 relative / 1e-12 absolute.
// Run: node run_vectors_v1.js <vectors.json> <module.js>
"use strict";
const fs = require("fs");
const path = require("path");
const V = JSON.parse(fs.readFileSync(process.argv[2] || "headroom_calc_vectors_v1.json", "utf8"));
const H = require(path.resolve(process.argv[3] || "headroom_calc_v1.js"));
let pass = 0, fail = 0;
const fails = [];
const canon = (x) => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object")
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const close = (a, b) => (a === null || b === null) ? a === b :
  Math.abs(a - b) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
function ok(cond, what) { if (cond) pass++; else { fail++; if (fails.length < 20) fails.push(what); } }
const fr = (f) => (f === null || f === undefined) ? null : H.fstr(f);

for (const [i, v] of V.analyze.entries()) {
  const legs = v.template ? H.template(v.template, v.params) : v.legs;
  if (v.template) ok(eq(legs, v.legs), "template legs " + i);
  const a = H.analyze(legs);
  ok(eq(a.breakevens.map(fr), v.breakevens), "be " + i);
  ok(eq(a.breakevens.map(H.roundHalfAway), v.breakevens_ticks), "be ticks " + i);
  ok(eq(a.zeroRanges, v.zero_ranges), "zero " + i);
  ok(a.maxProfit === v.max_profit && a.maxLoss === v.max_loss && a.netPremium === v.net_premium, "max/net " + i);
  for (const [s, p, c] of v.samples) ok(H.pnlExpiry(legs, s) === p && H.ticksToCents(p) === c, "sample " + i);
}
const G = ["price", "delta", "gamma", "theta", "vega", "rho"];
for (const [i, v] of V.bs.entries()) { const o = H.bs(...v.in); for (const g of G) ok(close(o[g], v.out[g]), "bs " + g + " " + i); }
for (const [i, v] of V.iv.entries()) ok(close(H.impliedVol(...v.in), v.out), "iv " + i);
for (const [i, v] of V.model.entries()) ok(close(H.pnlModel(v.legs, ...v.in), v.out), "model " + i);
function cmpObj(o, exp, tag) {
  for (const k of Object.keys(exp)) {
    const e = exp[k], got = o[k];
    if (typeof e === "string") ok(fr(got) === e, tag + " " + k);
    else if (Number.isInteger(e) && Number.isInteger(got)) ok(got === e, tag + " " + k);
    else ok(close(got, e), tag + " " + k);
  }
  ok(Object.keys(o).length === Object.keys(exp).length, tag + " keys");
}
for (const [i, v] of V.cc.entries()) cmpObj(H.coveredCall(...v.in), v.out, "cc " + i);
for (const [i, v] of V.csp.entries()) cmpObj(H.cashSecuredPut(...v.in), v.out, "csp " + i);
for (const [i, v] of V.roll.entries()) cmpObj(H.roll(...v.in), v.out, "roll " + i);
for (const [i, v] of V.annualize.entries()) { const o = H.annualize(...v.in); ok(close(o[0], v.out[0]) && close(o[1], v.out[1]), "ann " + i); }
for (const [i, v] of V.wash.entries()) ok(eq(H.washSaleWindow(...v.in), v.out), "wash " + i);
for (const v of V.parse) { let got; try { got = H.parsePrice(v.in); } catch (e) { got = null; } ok(got === v.out, "parse " + JSON.stringify(v.in)); }
const JSFN = { bs: H.bs, analyze: H.analyze, pnl_model: H.pnlModel, annualize: H.annualize,
  covered_call: H.coveredCall, cash_secured_put: H.cashSecuredPut, roll: H.roll, wash_sale_window: H.washSaleWindow };
for (const v of V.nosolution) {
  let threw = false;
  try { JSFN[v.fn](...v.args); } catch (e) { threw = e instanceof RangeError; }
  ok(threw, "no solution " + v.fn + " " + JSON.stringify(v.args));
}
for (const a of V.noiv) ok(H.impliedVol(...a) === null, "no iv " + JSON.stringify(a));
ok(H.VERSION === V.version, "version");
console.log(`PASS ${pass} FAIL ${fail}`);
for (const f of fails) console.log("  FAIL", f);
process.exit(fail ? 1 : 0);
