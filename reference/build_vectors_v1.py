"""Anchors (must pass) + deterministic vectors for the JS port. Run: python3 -I build_vectors_v1.py"""
import json, math, random, sys
from fractions import Fraction
sys.path.insert(0, ".")
import headroom_calc_reference_v1 as H

fails = []
def check(name, ok):
    if not ok:
        fails.append(name)

# ---------------- anchors
# A1 Hull, Options Futures & Other Derivatives, Example 15.6: call 4.76, put 0.81
c = H.bs("call", 42, 40, 0.5, 0.10, 0.0, 0.20)["price"]
p = H.bs("put", 42, 40, 0.5, 0.10, 0.0, 0.20)["price"]
check("A1 hull call", round(c, 2) == 4.76)
check("A1 hull put", round(p, 2) == 0.81)
# A2 normal CDF vs erfc on a grid
worst = max(abs(H.norm_cdf(x / 100) - 0.5 * math.erfc(-(x / 100) / math.sqrt(2))) for x in range(-900, 901))
check("A2 cdf<1e-14 (worst %.2e)" % worst, worst < 1e-14)
# A3 put-call parity with dividends
for (S, K, T, r, q, s) in [(100, 90, 0.3, 0.04, 0.01, 0.3), (50, 60, 1.2, 0.0, 0.02, 0.55)]:
    cc = H.bs("call", S, K, T, r, q, s)["price"]; pp = H.bs("put", S, K, T, r, q, s)["price"]
    check("A3 parity", abs((cc - pp) - (S * math.exp(-q * T) - K * math.exp(-r * T))) < 1e-10)
# A4 greeks vs finite differences
S, K, T, r, q, s = 100, 105, 0.4, 0.03, 0.01, 0.25
for kind in ("call", "put"):
    g = H.bs(kind, S, K, T, r, q, s)
    f = lambda **kw: H.bs(kind, kw.get("S", S), K, kw.get("T", T), kw.get("r", r), q, kw.get("s", s))["price"]
    h = 1e-4
    check("A4 delta " + kind, abs(g["delta"] - (f(S=S + h) - f(S=S - h)) / (2 * h)) < 1e-6)
    check("A4 gamma " + kind, abs(g["gamma"] - (f(S=S + h) - 2 * f() + f(S=S - h)) / h ** 2) < 1e-4)
    check("A4 vega " + kind, abs(g["vega"] - (f(s=s + h) - f(s=s - h)) / (2 * h) / 100) < 1e-6)
    check("A4 rho " + kind, abs(g["rho"] - (f(r=r + h) - f(r=r - h)) / (2 * h) / 100) < 1e-6)
    check("A4 theta " + kind, abs(g["theta"] - (-(f(T=T + h) - f(T=T - h)) / (2 * h) / 365)) < 1e-6)
# A5 IV round trip
for kind in ("call", "put"):
    pr = H.bs(kind, 100, 95, 0.25, 0.04, 0.0, 0.37)["price"]
    check("A5 iv " + kind, abs(H.implied_vol(kind, pr, 100, 95, 0.25, 0.04, 0.0) - 0.37) < 1e-9)
check("A5 iv below bound -> None", H.implied_vol("call", 0.5, 100, 90, 0.25, 0.0, 0.0) is None)
# A6 long call K=100 premium 5: BE 105, max loss $500, profit unlimited
P_ = H.parse_price
a = H.analyze([{"kind": "call", "qty": 1, "strike": P_("100"), "price": P_("5")}])
check("A6 be", a["breakevens"] == [Fraction(P_("105"))])
check("A6 maxloss", H.ticks_to_cents(a["max_loss"]) == -50000 and a["max_profit"] is None)
# A7 iron condor 90/95/105/110, premiums 1, 2, 2, 1 -> credit 2.00: BEs 93 and 107, max profit 200, max loss 300
ic = H.template("iron_condor", {"k1": P_("90"), "k2": P_("95"), "k3": P_("105"), "k4": P_("110"),
                                "x1": P_("1"), "x2": P_("2"), "x3": P_("2"), "x4": P_("1")})
a = H.analyze(ic)
check("A7 be", a["breakevens"] == [Fraction(P_("93")), Fraction(P_("107"))])
check("A7 max", H.ticks_to_cents(a["max_profit"]) == 20000 and H.ticks_to_cents(a["max_loss"]) == -30000)
check("A7 credit", H.ticks_to_cents(a["net_premium"]) == 20000)
# A8 short call: loss unlimited; long put: profit capped at strike - premium
a = H.analyze([{"kind": "call", "qty": -1, "strike": P_("50"), "price": P_("2")}])
check("A8 short call", a["max_loss"] is None and H.ticks_to_cents(a["max_profit"]) == 20000)
a = H.analyze([{"kind": "put", "qty": 1, "strike": P_("50"), "price": P_("2")}])
check("A8 long put", H.ticks_to_cents(a["max_profit"]) == 480000 and a["breakevens"] == [Fraction(P_("48"))])
# A9 covered call: stock 50, strike 55, premium 1
cc = H.covered_call(P_("50"), P_("55"), P_("1"), 30)
check("A9 cc", cc["static_return"] == Fraction(1, 49) and cc["if_called_return"] == Fraction(6, 49)
      and cc["breakeven"] == P_("49"))
# A10 CSP strike 40 premium 0.80 30 days: 2%, simple 24.33%
csp = H.cash_secured_put(P_("40"), P_("0.8"), 30)
check("A10 csp", csp["return_on_cash"] == Fraction(1, 50) and abs(csp["simple"] - 0.02 * 365 / 30) < 1e-15)
# A11 wash-sale window
check("A11 wash", H.wash_sale_window("2026-12-15", ["2026-11-15", "2026-11-14", "2027-01-14"])
      == ("2026-11-15", "2027-01-14", ["2026-11-15", "2027-01-14"]))
# A12 rounding half away from zero
check("A12 round", H.ticks_to_cents(50) == 1 and H.ticks_to_cents(-50) == -1 and H.ticks_to_cents(49) == 0)
# A13 parse
check("A13 parse", P_("0.0001") == 1 and P_("12") == 120000 and P_(".5") == 5000)
for bad in ["", "-1", "1.23456", "1e3", "1.2.3", " ", "."]:
    try:
        P_(bad); check("A13 reject %r" % bad, False)
    except ValueError:
        pass

# A14 no solution is never a number
def raises(f, *a):
    try:
        f(*a)
    except ValueError:
        return True
    return False
L1 = {"kind": "call", "qty": 1, "strike": P_("100"), "price": P_("5"), "days": 10, "iv": 0.3}
NOSOL = [("bs", ["call", 100, 100, 0.0, 0.0, 0.0, 0.3]), ("bs", ["put", 100, 100, 0.5, 0.0, 0.0, 0.0]),
         ("bs", ["call", 0, 100, 0.5, 0.0, 0.0, 0.3]), ("bs", ["put", 100, -1, 0.5, 0.0, 0.0, 0.3]),
         ("analyze", [[]]), ("analyze", [[dict(L1, qty=0)]]), ("analyze", [[dict(L1, strike=0)]]),
         ("analyze", [[dict(L1, mult=0)]]), ("analyze", [[{"kind": "stock", "qty": 100, "price": 0}]]),
         ("pnl_model", [[L1], 100.0, 11, 0.0, 0.0]), ("pnl_model", [[L1], 0.0, 1, 0.0, 0.0]),
         ("pnl_model", [[L1], 100.0, -1, 0.0, 0.0]),
         ("annualize", [0.1, 0]), ("annualize", [-1.5, 30]),
         ("covered_call", [P_("50"), P_("55"), P_("50"), 30]), ("covered_call", [0, P_("55"), P_("1"), 30]),
         ("covered_call", [P_("50"), P_("55"), 0, 30]), ("covered_call", [P_("50"), P_("55"), P_("1"), 0]),
         ("cash_secured_put", [P_("40"), P_("40"), 30]), ("cash_secured_put", [P_("40"), 0, 30]),
         ("roll", [P_("50"), P_("30"), 0, P_("25"), P_("55"), 30]), ("roll", [P_("50"), 0, 0, P_("1"), 0, 30]),
         ("wash_sale_window", ["2026-02-30", []])]
FN = {"bs": H.bs, "analyze": H.analyze, "pnl_model": H.pnl_model, "annualize": H.annualize,
      "covered_call": H.covered_call, "cash_secured_put": H.cash_secured_put, "roll": H.roll,
      "wash_sale_window": H.wash_sale_window}
for name, args in NOSOL:
    check("A14 no solution %s %r" % (name, args), raises(FN[name], *args))
NOIV = [["call", 0.5, 100, 90, 0.25, 0.0, 0.0], ["call", 150, 100, 90, 0.25, 0.0, 0.0],
        ["put", 5, 100, 90, 0.0, 0.0, 0.0], ["put", 0.0, 100, 90, 0.25, 0.0, 0.0]]
for a_ in NOIV:
    check("A14 no iv %r" % (a_,), H.implied_vol(*a_) is None)
check("A14 expiry day = intrinsic", H.pnl_model([L1], 112.0, 10, 0.0, 0.0) == 100 * (12.0 - 5.0))

print("anchors:", "PASS" if not fails else "FAIL", 0 if not fails else len(fails))
for f in fails:
    print("  FAIL", f)
if fails:
    sys.exit(1)

# ---------------- vectors
rng = random.Random(20261119)
def price_str(lo, hi, dec=2):
    v = rng.randint(int(lo * 10 ** dec), int(hi * 10 ** dec))
    return ("%d.%0" + str(dec) + "d") % (v // 10 ** dec, v % 10 ** dec)
fr = lambda x: None if x is None else "%d/%d" % (Fraction(x).numerator, Fraction(x).denominator)

V = {"version": H.VERSION, "nosolution": [{"fn": n, "args": a} for n, a in NOSOL],
     "noiv": NOIV, "analyze": [], "bs": [], "iv": [], "model": [], "cc": [], "csp": [],
     "roll": [], "annualize": [], "wash": [], "parse": []}

for i in range(600):
    nlegs = rng.randint(1, 5)
    legs = []
    for _ in range(nlegs):
        kind = rng.choice(["call", "put", "call", "put", "stock"])
        leg = {"kind": kind, "qty": rng.choice([-3, -2, -1, 1, 1, 2, 3]),
               "price": P_(price_str(0.01, 30, rng.choice([2, 2, 4])))}
        if kind == "stock":
            leg["qty"] *= 100
            leg["price"] = P_(price_str(5, 200))
        else:
            leg["strike"] = P_(price_str(1, 200, rng.choice([0, 1, 2])))
            if rng.random() < 0.1:
                leg["mult"] = 10
        legs.append(leg)
    a = H.analyze(legs)
    samples = sorted({0} | {rng.randint(0, P_("260")) for _ in range(6)} | {l["strike"] for l in legs if "strike" in l})
    V["analyze"].append({"legs": legs, "breakevens": [fr(b) for b in a["breakevens"]],
                         "breakevens_ticks": [H.round_half_away(b) for b in a["breakevens"]],
                         "zero_ranges": a["zero_ranges"], "max_profit": a["max_profit"], "max_loss": a["max_loss"],
                         "net_premium": a["net_premium"],
                         "samples": [[s, H.pnl_expiry(legs, s), H.ticks_to_cents(H.pnl_expiry(legs, s))] for s in samples]})

for name in H.TEMPLATES:
    for _ in range(10):
        base = rng.randint(30, 150)
        steps = sorted(rng.sample(range(1, 40), 4))
        p = {"k%d" % (j + 1): P_(str(base + steps[j])) for j in range(4)}
        p.update({"x%d" % (j + 1): P_(price_str(0.05, 9)) for j in range(4)})
        p["s"] = P_(price_str(base, base + 40)); p["n"] = rng.randint(1, 3)
        legs = H.template(name, p)
        a = H.analyze(legs)
        V["analyze"].append({"template": name, "params": p, "legs": legs,
                             "breakevens": [fr(b) for b in a["breakevens"]],
                             "breakevens_ticks": [H.round_half_away(b) for b in a["breakevens"]],
                             "zero_ranges": a["zero_ranges"], "max_profit": a["max_profit"],
                             "max_loss": a["max_loss"], "net_premium": a["net_premium"], "samples": []})

for _ in range(800):
    kind = rng.choice(["call", "put"])
    S = rng.uniform(1, 500); K = S * rng.uniform(0.5, 1.6); T = rng.uniform(1 / 365, 3)
    r = rng.choice([0.0, rng.uniform(-0.01, 0.08)]); q = rng.choice([0.0, rng.uniform(0, 0.06)])
    s = rng.uniform(0.03, 2.5)
    V["bs"].append({"in": [kind, S, K, T, r, q, s], "out": H.bs(kind, S, K, T, r, q, s)})

for _ in range(300):
    kind = rng.choice(["call", "put"])
    S = rng.uniform(5, 500); K = S * rng.uniform(0.6, 1.4); T = rng.uniform(2 / 365, 2)
    r = rng.uniform(0, 0.06); q = rng.uniform(0, 0.03); s = rng.uniform(0.05, 1.8)
    price = H.bs(kind, S, K, T, r, q, s)["price"] * rng.choice([1.0, 1.0, 0.3, 3.0])
    V["iv"].append({"in": [kind, price, S, K, T, r, q], "out": H.implied_vol(kind, price, S, K, T, r, q)})

for _ in range(200):
    legs = []
    for _ in range(rng.randint(1, 4)):
        kind = rng.choice(["call", "put", "stock"])
        if kind == "stock":
            legs.append({"kind": "stock", "qty": 100 * rng.choice([-1, 1]), "price": P_(price_str(20, 200))})
        else:
            legs.append({"kind": kind, "qty": rng.choice([-2, -1, 1, 2]), "strike": P_(price_str(20, 200, 0)),
                         "price": P_(price_str(0.1, 20)), "days": rng.randint(1, 400), "iv": rng.uniform(0.1, 1.2)})
    opt_days = [l["days"] for l in legs if "days" in l]
    S = rng.uniform(10, 260); t = rng.randint(0, min(opt_days) if opt_days else 420)
    r = rng.uniform(0, 0.06); q = rng.uniform(0, 0.03)
    V["model"].append({"legs": legs, "in": [S, t, r, q], "out": H.pnl_model(legs, S, t, r, q)})

for _ in range(200):
    st = P_(price_str(5, 400)); k = st + rng.randint(-st // 5, st // 4); pr = rng.randint(1, st // 8); d = rng.randint(1, 400)
    o = H.covered_call(st, k, pr, d)
    V["cc"].append({"in": [st, k, pr, d], "out": {kk: (fr(vv) if isinstance(vv, Fraction) else vv) for kk, vv in o.items()}})
for _ in range(200):
    k = P_(price_str(5, 400)); pr = rng.randint(1, k // 6); d = rng.randint(1, 400)
    o = H.cash_secured_put(k, pr, d)
    V["csp"].append({"in": [k, pr, d], "out": {kk: (fr(vv) if isinstance(vv, Fraction) else vv) for kk, vv in o.items()}})
for _ in range(200):
    b = P_(price_str(10, 300)); col = rng.randint(0, b // 10); bb = rng.randint(0, b // 10); nw = rng.randint(0, b // 8)
    nk = b + rng.randint(-b // 10, b // 4); d = rng.randint(1, 365)
    try:
        o = H.roll(b, col, bb, nw, nk, d)
    except ValueError:
        continue
    V["roll"].append({"in": [b, col, bb, nw, nk, d], "out": {kk: (fr(vv) if isinstance(vv, Fraction) else vv) for kk, vv in o.items()}})
for _ in range(200):
    r_ = rng.uniform(-0.5, 0.8); d = rng.randint(1, 1000)
    V["annualize"].append({"in": [r_, d], "out": list(H.annualize(r_, d))})
import datetime as dt
for _ in range(200):
    base = dt.date(2020, 1, 1) + dt.timedelta(days=rng.randint(0, 4000))
    others = [(base + dt.timedelta(days=rng.randint(-45, 45))).isoformat() for _ in range(5)]
    V["wash"].append({"in": [base.isoformat(), others], "out": list(H.wash_sale_window(base.isoformat(), others))})
for s_ in ["0", "0.0001", "1", "12.34", "999.9999", ".25", "10.", "7.5"]:
    V["parse"].append({"in": s_, "out": P_(s_)})
for s_ in ["", "-1", "1.23456", "1e3", "abc", " ", ".", "1,000"]:
    V["parse"].append({"in": s_, "out": None})

n = sum(len(v) for k, v in V.items() if isinstance(v, list))
with open("headroom_calc_vectors_v1.json", "w") as f:
    json.dump(V, f, sort_keys=True, separators=(",", ":"))
print("vectors:", n)
