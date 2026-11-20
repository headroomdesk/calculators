"""Headroom free calculators: reference engine v1 (Python). Source of record for the JS port.

Scope (v1): options payoff and P/L at expiry (exact), breakevens, max profit/loss,
Black-Scholes value and Greeks on typed IV, implied volatility from a typed price,
P/L before expiry (model), strategy templates, covered call, cash-secured put,
roll, annualized return, and the wash-sale date window.

Design rules (why these tools do not go stale):
- No market data, no dates, no rates and no broker rules are built in. Every price,
  strike, premium, IV, interest rate and dividend yield is typed by the user.
- Money is exact: prices are parsed from decimal strings into integer ticks of
  $0.0001; expiry P/L, breakevens and max P/L are exact integer/rational arithmetic.
- Model values (Black-Scholes, IV, Greeks, P/L before expiry) are floating point and
  labelled "model". The normal CDF uses one fixed algorithm (Hart 1968 / West 2005),
  so the Python and JS ports agree to ~1e-12 relative.
- The only rule-based tool here is the wash-sale window (IRC s.1091: 30 days before
  and after a sale at a loss), which is statute, not a broker setting.

Conventions (shown on every page):
- Time in years = calendar days / 365. Rates and yields are continuously compounded.
- Options contract multiplier 100 unless typed otherwise; stock legs are in shares.
- Covered-call returns are on the net debit (stock price - premium); CSP returns on
  the cash secured (strike). Annualized: simple = r * 365 / days;
  compound = (1 + r) ** (365 / days) - 1.
- Theta is per calendar day (/365); vega per 1 vol point; rho per 1 rate point.
- Model assumptions: European exercise (no early exercise), lognormal prices, constant
  volatility and rate, dividends only as a continuous yield (discrete dividends not modelled).
- No solution is never a number: impossible IV returns None;
  zero/negative inputs, zero time and dates past expiry raise ValueError("no solution: ...").
"""
from fractions import Fraction
import math
import datetime as _dt

TICKS_PER_DOLLAR = 10000
VERSION = "1.1.0"


# ---------------------------------------------------------------- parsing / rounding
def parse_price(s):
    """'12.3456' -> 123456 ticks. Non-negative, at most 4 decimals, plain digits only."""
    if not isinstance(s, str):
        raise ValueError("price must be a string")
    t = s.strip()
    if t == "" or t.count(".") > 1 or not all(c.isdigit() or c == "." for c in t):
        raise ValueError("bad price: %r" % s)
    whole, _, frac = t.partition(".")
    if len(frac) > 4:
        raise ValueError("more than 4 decimals: %r" % s)
    if whole == "" and frac == "":
        raise ValueError("bad price: %r" % s)
    return int(whole or "0") * TICKS_PER_DOLLAR + int((frac + "0000")[:4])


def round_half_away(fr):
    """Fraction -> nearest int, ties away from zero."""
    fr = Fraction(fr)
    sign = -1 if fr < 0 else 1
    a = abs(fr)
    q, rem = divmod(a.numerator, a.denominator)
    if 2 * rem >= a.denominator:
        q += 1
    return sign * q


def ticks_to_cents(tick_shares):
    """integer tick-shares (1e-4 $ x shares) -> integer cents, half away from zero."""
    return round_half_away(Fraction(tick_shares, 100))


def fmt_cents(c):
    sign = "-" if c < 0 else ""
    c = abs(c)
    return "%s%d.%02d" % (sign, c // 100, c % 100)


# ---------------------------------------------------------------- legs and expiry P/L
# leg = {"kind": "call"|"put"|"stock", "qty": int (+long/-short; contracts or shares),
#        "strike": ticks (options), "price": ticks (premium per share, or stock entry),
#        "mult": int (default 100 for options, 1 for stock)}
def _mult(leg):
    return leg.get("mult", 1 if leg["kind"] == "stock" else 100)


def leg_pnl_expiry(leg, S):
    q, m = leg["qty"], _mult(leg)
    if leg["kind"] == "call":
        return q * m * (max(S - leg["strike"], 0) - leg["price"])
    if leg["kind"] == "put":
        return q * m * (max(leg["strike"] - S, 0) - leg["price"])
    if leg["kind"] == "stock":
        return q * (S - leg["price"])
    raise ValueError("kind")


def pnl_expiry(legs, S):
    """exact P/L at expiry, integer tick-shares, underlying at S ticks."""
    return sum(leg_pnl_expiry(l, S) for l in legs)


def net_premium(legs):
    """cash at open in tick-shares: + = credit received, - = debit paid."""
    tot = 0
    for l in legs:
        tot -= l["qty"] * _mult(l) * l["price"]
    return tot


def _kinks(legs):
    return sorted({l["strike"] for l in legs if l["kind"] in ("call", "put")})


def _slope_right_of(legs, x):
    """dP/dS just to the right of x (x itself excluded)."""
    m = 0
    for l in legs:
        q, mu = l["qty"], _mult(l)
        if l["kind"] == "stock":
            m += q
        elif l["kind"] == "call" and l["strike"] <= x:
            m += q * mu
        elif l["kind"] == "put" and l["strike"] > x:
            m -= q * mu
    return m


def check_legs(legs):
    """No solution for an empty position, a zero quantity, a zero multiplier or a zero strike."""
    if not legs:
        raise ValueError("no solution: add at least one leg")
    for l in legs:
        if l["kind"] not in ("call", "put", "stock"):
            raise ValueError("kind")
        if l["qty"] == 0 or _mult(l) <= 0:
            raise ValueError("no solution: quantity and multiplier must not be zero")
        if l["kind"] != "stock" and l["strike"] <= 0:
            raise ValueError("no solution: strike must be above zero")
        if l["kind"] == "stock" and l["price"] <= 0:
            raise ValueError("no solution: stock price must be above zero")


def analyze(legs):
    """Exact analysis at expiry over S in [0, inf).

    Returns dict: breakevens (list of Fraction, ticks), zero_ranges (list of [a, b|None]),
    max_profit / max_loss (int tick-shares, or None when unlimited), net_premium."""
    check_legs(legs)
    pts = [0] + _kinks(legs)
    segs = []
    for i, a in enumerate(pts):
        b = pts[i + 1] if i + 1 < len(pts) else None
        m = _slope_right_of(legs, a)
        c = pnl_expiry(legs, a) - m * a          # P(S) = m*S + c on [a, b]
        segs.append((a, b, m, c))
    bes, zero_ranges = [], []
    for a, b, m, c in segs:
        if m == 0:
            if c == 0:
                zero_ranges.append([a, b])
            continue
        root = Fraction(-c, m)
        if root >= a and (b is None or root <= b):
            if root not in bes:
                bes.append(root)
    vals = [pnl_expiry(legs, x) for x in pts]
    last_m = segs[-1][2]
    max_profit = None if last_m > 0 else max(vals)
    max_loss = None if last_m < 0 else min(vals)
    # breakevens that sit inside a flat zero range are reported as the range only
    bes = [r for r in bes if not any(r >= a and (b is None or r <= b) for a, b in zero_ranges)]
    return {"breakevens": sorted(bes), "zero_ranges": zero_ranges,
            "max_profit": max_profit, "max_loss": max_loss, "net_premium": net_premium(legs)}


# ---------------------------------------------------------------- normal distribution
def norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def norm_cdf(x):
    """Hart (1968) algorithm 5666 as given by West (2005); double precision."""
    xa = abs(x)
    if xa > 37.0:
        c = 0.0
    else:
        e = math.exp(-xa * xa / 2.0)
        if xa < 7.07106781186547:
            b = 3.52624965998911e-02 * xa + 0.700383064443688
            b = b * xa + 6.37396220353165
            b = b * xa + 33.912866078383
            b = b * xa + 112.079291497871
            b = b * xa + 221.213596169931
            b = b * xa + 220.206867912376
            c = e * b
            b = 8.83883476483184e-02 * xa + 1.75566716318264
            b = b * xa + 16.064177579207
            b = b * xa + 86.7807322029461
            b = b * xa + 296.564248779674
            b = b * xa + 637.333633378831
            b = b * xa + 793.826512519948
            b = b * xa + 440.413735824752
            c = c / b
        else:
            b = xa + 0.65
            b = xa + 4.0 / b
            b = xa + 3.0 / b
            b = xa + 2.0 / b
            b = xa + 1.0 / b
            c = e / b / 2.506628274631
    return 1.0 - c if x > 0 else c


# ---------------------------------------------------------------- Black-Scholes (model)
def bs(kind, S, K, T, r, q, sigma):
    """kind 'call'|'put'; S, K in dollars (float); T years; r, q, sigma as decimals.
    Returns dict price, delta, gamma, theta (per day), vega (per vol point), rho (per rate point)."""
    if kind not in ("call", "put"):
        raise ValueError("kind")
    if not (S > 0 and K > 0):
        raise ValueError("no solution: price and strike must be above zero")
    if not (T > 0):
        raise ValueError("no solution: time to expiry must be above zero")
    if not (sigma > 0):
        raise ValueError("no solution: volatility must be above zero")
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq)
    d2 = d1 - sigma * sq
    dq, dr = math.exp(-q * T), math.exp(-r * T)
    pdf1 = norm_pdf(d1)
    gamma = dq * pdf1 / (S * sigma * sq)
    vega = S * dq * pdf1 * sq / 100.0
    if kind == "call":
        price = S * dq * norm_cdf(d1) - K * dr * norm_cdf(d2)
        delta = dq * norm_cdf(d1)
        theta = (-S * dq * pdf1 * sigma / (2 * sq) - r * K * dr * norm_cdf(d2) + q * S * dq * norm_cdf(d1)) / 365.0
        rho = K * T * dr * norm_cdf(d2) / 100.0
    elif kind == "put":
        price = K * dr * norm_cdf(-d2) - S * dq * norm_cdf(-d1)
        delta = -dq * norm_cdf(-d1)
        theta = (-S * dq * pdf1 * sigma / (2 * sq) + r * K * dr * norm_cdf(-d2) - q * S * dq * norm_cdf(-d1)) / 365.0
        rho = -K * T * dr * norm_cdf(-d2) / 100.0
    else:
        raise ValueError("kind")
    return {"price": price, "delta": delta, "gamma": gamma, "theta": theta, "vega": vega, "rho": rho}


def implied_vol(kind, price, S, K, T, r, q):
    """Bisection on [1e-6, 5.0], 200 steps. None when the price is outside no-arbitrage bounds."""
    if T <= 0 or price <= 0:
        return None
    dq, dr = math.exp(-q * T), math.exp(-r * T)
    lo_b = max(S * dq - K * dr, 0.0) if kind == "call" else max(K * dr - S * dq, 0.0)
    hi_b = S * dq if kind == "call" else K * dr
    if not (lo_b < price < hi_b):
        return None
    lo, hi = 1e-6, 5.0
    if bs(kind, S, K, T, r, q, hi)["price"] < price:
        return None
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if bs(kind, S, K, T, r, q, mid)["price"] < price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def pnl_model(legs, S, t_days, r, q):
    """Model P/L in dollars at underlying S (dollars) after t_days from now.
    Each option leg carries 'days' (to expiry from now) and 'iv' (decimal).
    On a leg's expiry day its value is intrinsic; after it, no solution."""
    check_legs(legs)
    if not (S > 0) or t_days < 0:
        raise ValueError("no solution: price must be above zero and the date not in the past")
    tot = 0.0
    for l in legs:
        if l["kind"] == "stock":
            tot += l["qty"] * (S - l["price"] / TICKS_PER_DOLLAR)
            continue
        if t_days > l["days"]:
            raise ValueError("no solution: date is after this leg's expiry")
        K = l["strike"] / TICKS_PER_DOLLAR
        if t_days == l["days"]:
            v = max(S - K, 0.0) if l["kind"] == "call" else max(K - S, 0.0)
        else:
            v = bs(l["kind"], S, K, (l["days"] - t_days) / 365.0, r, q, l["iv"])["price"]
        tot += l["qty"] * _mult(l) * (v - l["price"] / TICKS_PER_DOLLAR)
    return tot


# ---------------------------------------------------------------- strategy templates
def template(name, p):
    """p: dict of ticks for k1<k2<k3<k4 and premiums c1.., p1.., stock price s; qty n (contracts).
    Returns legs. Premium keys follow the leg order in each template."""
    n = p.get("n", 1)
    C = lambda k, pr, q: {"kind": "call", "qty": q, "strike": k, "price": pr}
    P = lambda k, pr, q: {"kind": "put", "qty": q, "strike": k, "price": pr}
    St = lambda pr, q: {"kind": "stock", "qty": q, "price": pr}
    T = {
        "long_call": lambda: [C(p["k1"], p["x1"], n)],
        "long_put": lambda: [P(p["k1"], p["x1"], n)],
        "short_call": lambda: [C(p["k1"], p["x1"], -n)],
        "short_put": lambda: [P(p["k1"], p["x1"], -n)],
        "covered_call": lambda: [St(p["s"], 100 * n), C(p["k1"], p["x1"], -n)],
        "protective_put": lambda: [St(p["s"], 100 * n), P(p["k1"], p["x1"], n)],
        "collar": lambda: [St(p["s"], 100 * n), P(p["k1"], p["x1"], n), C(p["k2"], p["x2"], -n)],
        "bull_call_spread": lambda: [C(p["k1"], p["x1"], n), C(p["k2"], p["x2"], -n)],
        "bear_call_spread": lambda: [C(p["k1"], p["x1"], -n), C(p["k2"], p["x2"], n)],
        "bull_put_spread": lambda: [P(p["k1"], p["x1"], n), P(p["k2"], p["x2"], -n)],
        "bear_put_spread": lambda: [P(p["k1"], p["x1"], -n), P(p["k2"], p["x2"], n)],
        "long_straddle": lambda: [C(p["k1"], p["x1"], n), P(p["k1"], p["x2"], n)],
        "short_straddle": lambda: [C(p["k1"], p["x1"], -n), P(p["k1"], p["x2"], -n)],
        "long_strangle": lambda: [P(p["k1"], p["x1"], n), C(p["k2"], p["x2"], n)],
        "short_strangle": lambda: [P(p["k1"], p["x1"], -n), C(p["k2"], p["x2"], -n)],
        "iron_condor": lambda: [P(p["k1"], p["x1"], n), P(p["k2"], p["x2"], -n),
                                C(p["k3"], p["x3"], -n), C(p["k4"], p["x4"], n)],
        "iron_butterfly": lambda: [P(p["k1"], p["x1"], n), P(p["k2"], p["x2"], -n),
                                   C(p["k2"], p["x3"], -n), C(p["k3"], p["x4"], n)],
        "long_call_butterfly": lambda: [C(p["k1"], p["x1"], n), C(p["k2"], p["x2"], -2 * n),
                                        C(p["k3"], p["x3"], n)],
    }
    if name not in T:
        raise ValueError("unknown template")
    return T[name]()


TEMPLATES = ["long_call", "long_put", "short_call", "short_put", "covered_call", "protective_put",
             "collar", "bull_call_spread", "bear_call_spread", "bull_put_spread", "bear_put_spread",
             "long_straddle", "short_straddle", "long_strangle", "short_strangle", "iron_condor",
             "iron_butterfly", "long_call_butterfly"]


# ---------------------------------------------------------------- income calculators
def annualize(ret, days):
    """ret decimal over 'days' calendar days -> (simple, compound)."""
    if not (days > 0):
        raise ValueError("no solution: days must be above zero")
    if ret < -1.0:
        raise ValueError("no solution: a loss cannot exceed 100%")
    simple = ret * 365.0 / days
    compound = (1.0 + ret) ** (365.0 / days) - 1.0 if ret > -1.0 else -1.0
    return simple, compound


def covered_call(stock, strike, premium, days):
    """ticks per share. Returns exact parts (ticks / Fractions) and annualized floats."""
    if not (stock > 0 and strike > 0 and premium > 0):
        raise ValueError("no solution: stock price, strike and premium must be above zero")
    if premium >= stock:
        raise ValueError("no solution: premium must be below the stock price")
    net = stock - premium
    static = Fraction(premium, net)
    called = Fraction(strike - stock + premium, net)
    out = {"net_debit": net, "breakeven": net, "max_profit": strike - stock + premium,
           "downside_protection": Fraction(premium, stock),
           "static_return": static, "if_called_return": called}
    out["static_simple"], out["static_compound"] = annualize(float(static), days)
    out["called_simple"], out["called_compound"] = annualize(float(called), days)
    return out


def cash_secured_put(strike, premium, days):
    if not (strike > 0 and premium > 0):
        raise ValueError("no solution: strike and premium must be above zero")
    if premium >= strike:
        raise ValueError("no solution: premium must be below the strike")
    ret = Fraction(premium, strike)
    out = {"cash_secured": strike, "breakeven": strike - premium, "effective_buy_price": strike - premium,
           "return_on_cash": ret}
    out["simple"], out["compound"] = annualize(float(ret), days)
    return out


def roll(stock_basis, premiums_collected, buyback, new_premium, new_strike, new_days):
    """Covered-call roll. All money in ticks per share; premiums_collected = total so far."""
    if not (stock_basis > 0 and new_strike > 0):
        raise ValueError("no solution: stock basis and new strike must be above zero")
    net_roll = new_premium - buyback
    total = premiums_collected + net_roll
    net_basis = stock_basis - total
    if net_basis <= 0:
        raise ValueError("no solution: premiums exceed the stock basis")
    called = Fraction(new_strike - stock_basis + total, net_basis)
    out = {"net_roll": net_roll, "total_premium": total, "breakeven": net_basis,
           "if_called_return": called}
    out["called_simple"], out["called_compound"] = annualize(float(called), new_days)
    return out


# ---------------------------------------------------------------- wash-sale window
def wash_sale_window(sale_date, other_dates=()):
    """IRC s.1091: purchases 30 days before or after a sale at a loss. Calendar days, inclusive.
    Dates as 'YYYY-MM-DD'. Returns (start, end, list of other_dates inside)."""
    d = _dt.date.fromisoformat(sale_date)
    a, b = d - _dt.timedelta(days=30), d + _dt.timedelta(days=30)
    inside = [x for x in other_dates if a <= _dt.date.fromisoformat(x) <= b]
    return a.isoformat(), b.isoformat(), inside
