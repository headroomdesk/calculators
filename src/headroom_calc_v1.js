/* Headroom free calculators: JS module v1.0.0. Port of headroom_calc_reference_v1.py
 * (the Python file is the source of record; vectors headroom_calc_vectors_v1.json).
 * No network, no storage, no dates or rates built in: every number is typed by the user.
 * Exact money: prices are integer ticks of $0.0001; expiry P/L, breakevens and max P/L are exact.
 * Model values (Black-Scholes, IV, Greeks, P/L before expiry) are floating point and labelled "model":
 * European exercise, lognormal prices, constant volatility and rate, dividends only as a continuous yield.
 * No solution is never a number: impossible IV returns null; bad inputs, zero time and dates past
 * expiry throw RangeError("no solution: ...") for the page to show as a message.
 * Usage: browser global HeadroomCalc, or require()/import in Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HeadroomCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const VERSION = "1.1.0";
  const TICKS = 10000;

  function safe(n) {
    if (!Number.isSafeInteger(n)) throw new RangeError("value outside exact range");
    return n;
  }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
  // Fraction as [num, den], den > 0, reduced
  function frac(n, d) {
    if (d === 0) throw new RangeError("division by zero");
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d) || 1;
    return [safe(n / g), safe(d / g)];
  }
  const fstr = (f) => f[0] + "/" + f[1];
  const fcmp = (f, n) => Math.sign(f[0] - n * f[1]); // compare fraction with integer
  const fnum = (f) => f[0] / f[1];

  // ------------------------------------------------------------ parsing / rounding
  function parsePrice(s) {
    if (typeof s !== "string") throw new TypeError("price must be a string");
    const t = s.trim();
    if (!/^[0-9]*\.?[0-9]*$/.test(t) || t === "" || t === ".") throw new RangeError("bad price");
    const [whole, fracPart = ""] = t.split(".");
    if (fracPart.length > 4) throw new RangeError("more than 4 decimals");
    return safe(parseInt(whole || "0", 10) * TICKS + parseInt((fracPart + "0000").slice(0, 4), 10));
  }
  function roundHalfAway(f) { // f = [num, den]
    const sign = f[0] < 0 ? -1 : 1;
    const a = Math.abs(f[0]), d = f[1];
    let q = Math.floor(a / d);
    const rem = a - q * d;
    if (2 * rem >= d) q += 1;
    return sign * q;
  }
  const ticksToCents = (ts) => roundHalfAway(frac(ts, 100));
  function fmtCents(c) {
    const sign = c < 0 ? "-" : "";
    c = Math.abs(c);
    return sign + Math.floor(c / 100) + "." + String(c % 100).padStart(2, "0");
  }

  // ------------------------------------------------------------ legs, exact expiry P/L
  const mult = (l) => (l.mult !== undefined ? l.mult : (l.kind === "stock" ? 1 : 100));
  function legPnlExpiry(l, S) {
    const q = l.qty, m = mult(l);
    if (l.kind === "call") return q * m * (Math.max(S - l.strike, 0) - l.price);
    if (l.kind === "put") return q * m * (Math.max(l.strike - S, 0) - l.price);
    if (l.kind === "stock") return q * (S - l.price);
    throw new TypeError("kind");
  }
  const pnlExpiry = (legs, S) => safe(legs.reduce((a, l) => a + legPnlExpiry(l, S), 0));
  const netPremium = (legs) => safe(legs.reduce((a, l) => a - l.qty * mult(l) * l.price, 0));
  function slopeRightOf(legs, x) {
    let m = 0;
    for (const l of legs) {
      if (l.kind === "stock") m += l.qty;
      else if (l.kind === "call" && l.strike <= x) m += l.qty * mult(l);
      else if (l.kind === "put" && l.strike > x) m -= l.qty * mult(l);
    }
    return m;
  }
  function checkLegs(legs) {
    if (!Array.isArray(legs) || legs.length === 0) throw new RangeError("no solution: add at least one leg");
    for (const l of legs) {
      if (l.kind !== "call" && l.kind !== "put" && l.kind !== "stock") throw new TypeError("kind");
      if (l.qty === 0 || !(mult(l) > 0)) throw new RangeError("no solution: quantity and multiplier must not be zero");
      if (l.kind !== "stock" && !(l.strike > 0)) throw new RangeError("no solution: strike must be above zero");
      if (l.kind === "stock" && !(l.price > 0)) throw new RangeError("no solution: stock price must be above zero");
    }
  }
  function analyze(legs) {
    checkLegs(legs);
    const ks = [...new Set(legs.filter((l) => l.kind !== "stock").map((l) => l.strike))].sort((a, b) => a - b);
    const pts = [0, ...ks];
    const segs = pts.map((a, i) => {
      const b = i + 1 < pts.length ? pts[i + 1] : null;
      const m = slopeRightOf(legs, a);
      return [a, b, m, safe(pnlExpiry(legs, a) - m * a)];
    });
    let bes = [];
    const zero = [];
    for (const [a, b, m, c] of segs) {
      if (m === 0) { if (c === 0) zero.push([a, b]); continue; }
      const r = frac(-c, m);
      if (fcmp(r, a) >= 0 && (b === null || fcmp(r, b) <= 0) && !bes.some((x) => x[0] === r[0] && x[1] === r[1])) bes.push(r);
    }
    const vals = pts.map((x) => pnlExpiry(legs, x));
    const lastM = segs[segs.length - 1][2];
    bes = bes.filter((r) => !zero.some(([a, b]) => fcmp(r, a) >= 0 && (b === null || fcmp(r, b) <= 0)));
    bes.sort((x, y) => x[0] * y[1] - y[0] * x[1]);
    return {
      breakevens: bes, zeroRanges: zero,
      maxProfit: lastM > 0 ? null : Math.max(...vals),
      maxLoss: lastM < 0 ? null : Math.min(...vals),
      netPremium: netPremium(legs),
    };
  }

  // ------------------------------------------------------------ normal distribution (Hart 1968 / West 2005)
  const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2.0 * Math.PI);
  function normCdf(x) {
    const xa = Math.abs(x);
    let c, b;
    if (xa > 37.0) c = 0.0;
    else {
      const e = Math.exp(-xa * xa / 2.0);
      if (xa < 7.07106781186547) {
        b = 3.52624965998911e-02 * xa + 0.700383064443688;
        b = b * xa + 6.37396220353165;
        b = b * xa + 33.912866078383;
        b = b * xa + 112.079291497871;
        b = b * xa + 221.213596169931;
        b = b * xa + 220.206867912376;
        c = e * b;
        b = 8.83883476483184e-02 * xa + 1.75566716318264;
        b = b * xa + 16.064177579207;
        b = b * xa + 86.7807322029461;
        b = b * xa + 296.564248779674;
        b = b * xa + 637.333633378831;
        b = b * xa + 793.826512519948;
        b = b * xa + 440.413735824752;
        c = c / b;
      } else {
        b = xa + 0.65;
        b = xa + 4.0 / b;
        b = xa + 3.0 / b;
        b = xa + 2.0 / b;
        b = xa + 1.0 / b;
        c = e / b / 2.506628274631;
      }
    }
    return x > 0 ? 1.0 - c : c;
  }

  // ------------------------------------------------------------ Black-Scholes (model)
  function bs(kind, S, K, T, r, q, sigma) {
    if (kind !== "call" && kind !== "put") throw new TypeError("kind");
    if (!(S > 0 && K > 0)) throw new RangeError("no solution: price and strike must be above zero");
    if (!(T > 0)) throw new RangeError("no solution: time to expiry must be above zero");
    if (!(sigma > 0)) throw new RangeError("no solution: volatility must be above zero");
    const sq = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq);
    const d2 = d1 - sigma * sq;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
    const pdf1 = normPdf(d1);
    const gamma = dq * pdf1 / (S * sigma * sq);
    const vega = S * dq * pdf1 * sq / 100.0;
    let price, delta, theta, rho;
    if (kind === "call") {
      price = S * dq * normCdf(d1) - K * dr * normCdf(d2);
      delta = dq * normCdf(d1);
      theta = (-S * dq * pdf1 * sigma / (2 * sq) - r * K * dr * normCdf(d2) + q * S * dq * normCdf(d1)) / 365.0;
      rho = K * T * dr * normCdf(d2) / 100.0;
    } else if (kind === "put") {
      price = K * dr * normCdf(-d2) - S * dq * normCdf(-d1);
      delta = -dq * normCdf(-d1);
      theta = (-S * dq * pdf1 * sigma / (2 * sq) + r * K * dr * normCdf(-d2) - q * S * dq * normCdf(-d1)) / 365.0;
      rho = -K * T * dr * normCdf(-d2) / 100.0;
    } else throw new TypeError("kind");
    return { price, delta, gamma, theta, vega, rho };
  }
  function impliedVol(kind, price, S, K, T, r, q) {
    if (T <= 0 || price <= 0) return null;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
    const lo_b = kind === "call" ? Math.max(S * dq - K * dr, 0.0) : Math.max(K * dr - S * dq, 0.0);
    const hi_b = kind === "call" ? S * dq : K * dr;
    if (!(lo_b < price && price < hi_b)) return null;
    let lo = 1e-6, hi = 5.0;
    if (bs(kind, S, K, T, r, q, hi).price < price) return null;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (bs(kind, S, K, T, r, q, mid).price < price) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
  function pnlModel(legs, S, tDays, r, q) {
    checkLegs(legs);
    if (!(S > 0) || tDays < 0) throw new RangeError("no solution: price must be above zero and the date not in the past");
    let tot = 0.0;
    for (const l of legs) {
      if (l.kind === "stock") { tot += l.qty * (S - l.price / TICKS); continue; }
      if (tDays > l.days) throw new RangeError("no solution: date is after this leg's expiry");
      const K = l.strike / TICKS;
      const v = tDays === l.days ? (l.kind === "call" ? Math.max(S - K, 0.0) : Math.max(K - S, 0.0))
        : bs(l.kind, S, K, (l.days - tDays) / 365.0, r, q, l.iv).price;
      tot += l.qty * mult(l) * (v - l.price / TICKS);
    }
    return tot;
  }

  // ------------------------------------------------------------ strategy templates
  const TEMPLATES = ["long_call", "long_put", "short_call", "short_put", "covered_call", "protective_put",
    "collar", "bull_call_spread", "bear_call_spread", "bull_put_spread", "bear_put_spread",
    "long_straddle", "short_straddle", "long_strangle", "short_strangle", "iron_condor",
    "iron_butterfly", "long_call_butterfly"];
  function template(name, p) {
    const n = p.n !== undefined ? p.n : 1;
    const C = (k, pr, q) => ({ kind: "call", qty: q, strike: k, price: pr });
    const P = (k, pr, q) => ({ kind: "put", qty: q, strike: k, price: pr });
    const St = (pr, q) => ({ kind: "stock", qty: q, price: pr });
    const T = {
      long_call: () => [C(p.k1, p.x1, n)],
      long_put: () => [P(p.k1, p.x1, n)],
      short_call: () => [C(p.k1, p.x1, -n)],
      short_put: () => [P(p.k1, p.x1, -n)],
      covered_call: () => [St(p.s, 100 * n), C(p.k1, p.x1, -n)],
      protective_put: () => [St(p.s, 100 * n), P(p.k1, p.x1, n)],
      collar: () => [St(p.s, 100 * n), P(p.k1, p.x1, n), C(p.k2, p.x2, -n)],
      bull_call_spread: () => [C(p.k1, p.x1, n), C(p.k2, p.x2, -n)],
      bear_call_spread: () => [C(p.k1, p.x1, -n), C(p.k2, p.x2, n)],
      bull_put_spread: () => [P(p.k1, p.x1, n), P(p.k2, p.x2, -n)],
      bear_put_spread: () => [P(p.k1, p.x1, -n), P(p.k2, p.x2, n)],
      long_straddle: () => [C(p.k1, p.x1, n), P(p.k1, p.x2, n)],
      short_straddle: () => [C(p.k1, p.x1, -n), P(p.k1, p.x2, -n)],
      long_strangle: () => [P(p.k1, p.x1, n), C(p.k2, p.x2, n)],
      short_strangle: () => [P(p.k1, p.x1, -n), C(p.k2, p.x2, -n)],
      iron_condor: () => [P(p.k1, p.x1, n), P(p.k2, p.x2, -n), C(p.k3, p.x3, -n), C(p.k4, p.x4, n)],
      iron_butterfly: () => [P(p.k1, p.x1, n), P(p.k2, p.x2, -n), C(p.k2, p.x3, -n), C(p.k3, p.x4, n)],
      long_call_butterfly: () => [C(p.k1, p.x1, n), C(p.k2, p.x2, -2 * n), C(p.k3, p.x3, n)],
    };
    if (!T[name]) throw new RangeError("unknown template");
    return T[name]();
  }

  // ------------------------------------------------------------ income calculators
  function annualize(ret, days) {
    if (!(days > 0)) throw new RangeError("no solution: days must be above zero");
    if (ret < -1.0) throw new RangeError("no solution: a loss cannot exceed 100%");
    const simple = ret * 365.0 / days;
    const compound = ret > -1.0 ? Math.pow(1.0 + ret, 365.0 / days) - 1.0 : -1.0;
    return [simple, compound];
  }
  function coveredCall(stock, strike, premium, days) {
    if (!(stock > 0 && strike > 0 && premium > 0)) throw new RangeError("no solution: stock price, strike and premium must be above zero");
    if (premium >= stock) throw new RangeError("no solution: premium must be below the stock price");
    const net = stock - premium;
    const stat = frac(premium, net), called = frac(strike - stock + premium, net);
    const o = { net_debit: net, breakeven: net, max_profit: strike - stock + premium,
      downside_protection: frac(premium, stock), static_return: stat, if_called_return: called };
    [o.static_simple, o.static_compound] = annualize(fnum(stat), days);
    [o.called_simple, o.called_compound] = annualize(fnum(called), days);
    return o;
  }
  function cashSecuredPut(strike, premium, days) {
    if (!(strike > 0 && premium > 0)) throw new RangeError("no solution: strike and premium must be above zero");
    if (premium >= strike) throw new RangeError("no solution: premium must be below the strike");
    const ret = frac(premium, strike);
    const o = { cash_secured: strike, breakeven: strike - premium, effective_buy_price: strike - premium, return_on_cash: ret };
    [o.simple, o.compound] = annualize(fnum(ret), days);
    return o;
  }
  function roll(stockBasis, premiumsCollected, buyback, newPremium, newStrike, newDays) {
    if (!(stockBasis > 0 && newStrike > 0)) throw new RangeError("no solution: stock basis and new strike must be above zero");
    const netRoll = newPremium - buyback, total = premiumsCollected + netRoll, netBasis = stockBasis - total;
    if (netBasis <= 0) throw new RangeError("no solution: premiums exceed the stock basis");
    const called = frac(newStrike - stockBasis + total, netBasis);
    const o = { net_roll: netRoll, total_premium: total, breakeven: netBasis, if_called_return: called };
    [o.called_simple, o.called_compound] = annualize(fnum(called), newDays);
    return o;
  }

  // ------------------------------------------------------------ wash-sale window (IRC s.1091)
  function isoDay(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError("date must be YYYY-MM-DD");
    const [y, m, d] = s.split("-").map(Number);
    const t = Date.UTC(y, m - 1, d);
    if (new Date(t).toISOString().slice(0, 10) !== s) throw new RangeError("not a calendar date");
    return t / 86400000;
  }
  const dayIso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  function washSaleWindow(saleDate, others) {
    const d = isoDay(saleDate), a = d - 30, b = d + 30;
    return [dayIso(a), dayIso(b), (others || []).filter((x) => { const v = isoDay(x); return v >= a && v <= b; })];
  }

  return { VERSION, TICKS, parsePrice, roundHalfAway, ticksToCents, fmtCents, frac, fstr,
    pnlExpiry, netPremium, analyze, normCdf, normPdf, bs, impliedVol, pnlModel,
    checkLegs, TEMPLATES, template, annualize, coveredCall, cashSecuredPut, roll, washSaleWindow };
});
