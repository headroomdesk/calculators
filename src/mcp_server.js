// Headroom Desk calculators: MCP server. Concatenated after the engine (HeadroomCalc v1.1.0) into the Cloudflare Worker that serves headroomdesk.com.
// Remote MCP over Streamable HTTP at https://headroomdesk.com/mcp: stateless JSON-RPC 2.0, plain JSON replies, no SSE,
// no sessions, no auth, no storage. Every tool is read-only arithmetic on the numbers in the call, using the same engine
// the web calculators use (3,123 test cases). No market data is fetched. A "no solution" is returned as a message, never
// as a number. Usage counts: tool name, client software name and UTC day only (privacy page).
const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MCP_SITE = "https://headroomdesk.com";
const MCP_INFO = { name: "headroom-desk-calculators", title: "Headroom Desk options calculators", version: "1.0.1",
  websiteUrl: MCP_SITE + "/mcp-server/" };
const MCP_INSTRUCTIONS = "Arithmetic on numbers supplied in each call: options P/L at expiry for any combination of calls, puts and shares; " +
  "Black-Scholes value, Greeks and implied volatility; covered call, cash-secured put, covered-call roll and annualized return. " +
  "No market data is fetched and no interest rate, dividend yield or volatility is built in, so every input must come from the user. " +
  "Results at expiry are exact; values before expiry are Black-Scholes model estimates. Prices are per share; one contract is 100 shares.";
const N = {
  exact: "Exact at expiry for the numbers you typed. Not included: fees and commissions, early assignment, dividends, and what your broker does at expiry.",
  model: "Model: Black-Scholes. No early exercise, constant volatility and rate, dividends as a continuous yield. For American options (most US stock options) the price, Greeks and implied volatility are approximations, least reliable for deep in-the-money puts and around dividend dates.",
  know: "This calculator does not know your broker, account type, tax position or fees.",
  test: "Checked against 3,123 test cases (2026-11-20).",
  conv: "Conventions: days/365; continuous compounding; returns on net debit or cash secured.",
  ann: "Per year: assumes the same result repeated; not a forecast.",
};

// ------------------------------------------------------------------ input reading (actionable messages)
class Ask extends Error {}
function mHas(a, k) { return a != null && Object.prototype.hasOwnProperty.call(a, k) && a[k] !== null && a[k] !== undefined && a[k] !== ""; }
function mPrice(a, k, label) {
  if (!mHas(a, k)) throw new Ask(`${label || k}: required, a price in dollars per share such as "2.35".`);
  let v = a[k];
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Ask(`${label || k}: must be a finite number.`); v = String(v); }
  if (typeof v !== "string") throw new Ask(`${label || k}: give the price as a string such as "2.35".`);
  v = v.trim().replace(/^\$/, "");
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(v)) v = v.replace(/,/g, "");
  try { return HeadroomCalc.parsePrice(v); }
  catch (e) { throw new Ask(`${label || k}: "${String(a[k]).slice(0, 20)}" is not a price; use digits with a dot, at most 4 decimals, no minus sign.`); }
}
function mPriceOr0(a, k, label) { return mHas(a, k) ? mPrice(a, k, label) : 0; }
function mInt(a, k, label, min, dflt) {
  if (!mHas(a, k)) { if (dflt !== undefined) return dflt; throw new Ask(`${label || k}: required, a whole number.`); }
  const v = typeof a[k] === "string" ? Number(a[k]) : a[k];
  if (!Number.isInteger(v) || v < min || v > 1e6) throw new Ask(`${label || k}: a whole number from ${min} to 1,000,000.`);
  return v;
}
function mNum(a, k, label) {
  if (!mHas(a, k)) throw new Ask(`${label || k}: required; type the value you want to use (0 is allowed). Nothing is filled in for you.`);
  const v = typeof a[k] === "string" ? Number(a[k].trim()) : a[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Ask(`${label || k}: must be a number.`);
  return v;
}
function mEnum(a, k, vals, label) {
  const v = a == null ? undefined : a[k];
  if (!vals.includes(v)) throw new Ask(`${label || k}: one of ${vals.map((x) => `"${x}"`).join(", ")}.`);
  return v;
}

// ------------------------------------------------------------------ formatting (exact money stays exact)
const mGrp = (w) => w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function mCents(c, sign) { const t = HeadroomCalc.fmtCents(c), neg = t[0] === "-", p = t.replace("-", "").split("."); return (neg ? "-" : (sign && c > 0 ? "+" : "")) + mGrp(p[0]) + "." + p[1]; }
const mTs = (ts, sign) => mCents(HeadroomCalc.ticksToCents(ts), sign);           // tick-shares -> dollars
function mTk(t) {                                                                 // ticks per share -> dollars
  const neg = t < 0; t = Math.abs(t); const w = Math.floor(t / 10000); let f = String(t % 10000).padStart(4, "0");
  if (f.endsWith("00")) f = f.slice(0, 2);
  return (neg ? "-" : "") + mGrp(String(w)) + "." + f;
}
const mFr = (f) => f[1] === 1 ? mTk(f[0]) : "about " + mTk(HeadroomCalc.roundHalfAway(f));
const mPct = (x, d = 2) => (x * 100).toFixed(d) + "%";
const mFp = (f) => mPct(f[0] / f[1]);
const mF = (x, d) => Number(x.toFixed(d));
function mAnn(f, days) { const a = HeadroomCalc.annualize(f[0] / f[1], days); return { over_the_period: mFp(f), per_year_simple: mPct(a[0]), per_year_compounded: mPct(a[1]) }; }

function mLegs(a, needModel) {
  const L = a && a.legs;
  if (!Array.isArray(L) || L.length < 1 || L.length > 8) throw new Ask("legs: a list of 1 to 8 legs.");
  return L.map((l, i) => {
    const n = `legs[${i}]`;
    const kind = mEnum(l, "type", ["call", "put", "stock"], n + ".type");
    const side = mEnum(l, "side", ["long", "short"], n + ".side");
    const q = mInt(l, "quantity", n + ".quantity", 1);
    const leg = { kind, qty: side === "short" ? -q : q, price: mPrice(l, "price", n + ".price") };
    if (kind !== "stock") {
      leg.strike = mPrice(l, "strike", n + ".strike");
      if (mHas(l, "multiplier")) leg.mult = mInt(l, "multiplier", n + ".multiplier", 1);
      if (needModel) { leg.days = mInt(l, "days_to_expiry", n + ".days_to_expiry", 0); leg.iv = mNum(l, "volatility_pct", n + ".volatility_pct") / 100; }
    }
    return leg;
  });
}
function mPrices(a, k) {
  if (!mHas(a, k)) return [];
  if (!Array.isArray(a[k]) || a[k].length > 20) throw new Ask(`${k}: a list of up to 20 prices.`);
  return a[k].map((_, i) => mPrice(a[k], i, `${k}[${i}]`));
}
const page = (p) => MCP_SITE + p;

// ------------------------------------------------------------------ tools
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PRICE = { type: ["string", "number"], description: "Dollars per share, at most 4 decimals, for example \"2.35\"." };
const LEG = { type: "object", additionalProperties: false, required: ["type", "side", "quantity", "price"], properties: {
  type: { type: "string", enum: ["call", "put", "stock"], description: "The leg: a call option, a put option, or shares of the underlying stock." },
  side: { type: "string", enum: ["long", "short"], description: "long = bought (premium paid), short = written or sold short (premium received)." },
  quantity: { type: "integer", minimum: 1, description: "Contracts for an option, shares for stock." },
  strike: { ...PRICE, description: "Strike per share (options only)." },
  price: { ...PRICE, description: "Premium per share for an option, or the price paid per share for stock." },
  multiplier: { type: "integer", minimum: 1, description: "Shares per contract; default 100." } } };
const LEGM = { ...LEG, required: ["type", "side", "quantity", "price"], properties: { ...LEG.properties,
  days_to_expiry: { type: "integer", minimum: 0, description: "Calendar days from now to this option's expiry (options only)." },
  volatility_pct: { type: "number", description: "Volatility per year in percent for this option, for example 30 (options only)." } } };
const KIND = { type: "string", enum: ["call", "put"], description: "Option type: call or put." };
const PCT = (d) => ({ type: "number", description: d });

const TOOLS = [
  { name: "options_pnl_at_expiry", title: "Options P/L at expiry",
    description: "Exact P/L at expiry for a position of up to 8 legs (calls, puts, shares, long or short): net premium (debit or credit), breakevens, highest and lowest P/L at expiry (or Unlimited), and the P/L at each strike and at any underlying prices given. Covers spreads, straddles, strangles, iron condors, butterflies, covered calls and collars. Uses only the numbers supplied.",
    inputSchema: { type: "object", additionalProperties: false, required: ["legs"], properties: { legs: { type: "array", minItems: 1, maxItems: 8, items: LEG, description: "The position: 1 to 8 legs (calls, puts or shares, long or short)." },
      prices_at_expiry: { type: "array", maxItems: 20, items: PRICE, description: "Optional underlying prices at expiry to evaluate." } } },
    run(a) {
      const legs = mLegs(a, false), r = HeadroomCalc.analyze(legs), np = r.netPremium;
      const at = [...new Set(legs.filter((l) => l.kind !== "stock").map((l) => l.strike).concat(mPrices(a, "prices_at_expiry")))].sort((x, y) => x - y);
      return { net_premium: { amount: mTs(Math.abs(np)), kind: np < 0 ? "debit paid" : np > 0 ? "credit received" : "zero" },
        highest_pnl_at_expiry: r.maxProfit === null ? "Unlimited gain" : mTs(r.maxProfit, true),
        lowest_pnl_at_expiry: r.maxLoss === null ? "Unlimited loss" : mTs(r.maxLoss, true),
        breakevens_at_expiry: r.breakevens.length ? r.breakevens.map(mFr) : "None: the P/L at expiry never crosses zero.",
        zero_pnl_ranges: r.zeroRanges.map((z) => ({ from: mTk(z[0]), to: z[1] === null ? "any higher price" : mTk(z[1]) })),
        pnl_at_expiry: at.map((s) => ({ underlying: mTk(s), pnl: mTs(HeadroomCalc.pnlExpiry(legs, s), true) })),
        notes: [N.exact, N.know, N.test], page: page("/calculators/options-profit-calculator/") };
    } },
  { name: "options_pnl_before_expiry", title: "Options P/L before expiry (model estimate)",
    description: "Black-Scholes model estimate of a position's P/L a given number of days from now at a given underlying price, for up to 8 legs. Each option leg needs its days to expiry and volatility. The interest rate and dividend yield must be supplied; nothing is built in.",
    inputSchema: { type: "object", additionalProperties: false, required: ["legs", "underlying_price", "days_from_now", "rate_pct", "dividend_yield_pct"], properties: {
      legs: { type: "array", minItems: 1, maxItems: 8, items: LEGM, description: "The position: 1 to 8 legs; each option leg also needs days_to_expiry and volatility_pct." }, underlying_price: PCT("Underlying price in dollars at which to value the position."),
      days_from_now: { type: "integer", minimum: 0, description: "Calendar days from now; not after any leg's expiry." },
      rate_pct: PCT("Interest rate per year in percent, continuously compounded (0 is allowed)."), dividend_yield_pct: PCT("Dividend yield per year in percent, continuous (0 is allowed).") } },
    run(a) {
      const legs = mLegs(a, true), S = mNum(a, "underlying_price"), d = mInt(a, "days_from_now", "days_from_now", 0);
      const r = mNum(a, "rate_pct") / 100, q = mNum(a, "dividend_yield_pct") / 100;
      return { model_pnl: mF(HeadroomCalc.pnlModel(legs, S, d, r, q), 2), at_underlying: S, days_from_now: d, label: "model estimate",
        notes: [N.model, N.know, N.test], page: page("/calculators/options-profit-calculator/") };
    } },
  { name: "black_scholes", title: "Black-Scholes value and Greeks",
    description: "Black-Scholes model value of one European-style call or put per share and per 100-share contract, with delta, gamma, theta per calendar day, vega per volatility point and rho per rate point. All inputs, including the interest rate and dividend yield, must be supplied.",
    inputSchema: { type: "object", additionalProperties: false, required: ["option_type", "underlying_price", "strike", "days_to_expiry", "volatility_pct", "rate_pct", "dividend_yield_pct"], properties: {
      option_type: KIND, underlying_price: PCT("Underlying price in dollars."), strike: PCT("Strike in dollars."), days_to_expiry: PCT("Calendar days to expiry (above zero)."),
      volatility_pct: PCT("Volatility per year in percent, for example 30."), rate_pct: PCT("Interest rate per year in percent (0 is allowed)."), dividend_yield_pct: PCT("Dividend yield per year in percent (0 is allowed).") } },
    run(a) {
      const k = mEnum(a, "option_type", ["call", "put"]);
      const o = HeadroomCalc.bs(k, mNum(a, "underlying_price"), mNum(a, "strike"), mNum(a, "days_to_expiry") / 365, mNum(a, "rate_pct") / 100, mNum(a, "dividend_yield_pct") / 100, mNum(a, "volatility_pct") / 100);
      return { value_per_share: mF(o.price, 4), value_per_contract: mF(o.price * 100, 2), delta: mF(o.delta, 6), gamma: mF(o.gamma, 6), theta_per_day: mF(o.theta, 6),
        vega_per_vol_point: mF(o.vega, 6), rho_per_rate_point: mF(o.rho, 6), label: "model estimate", notes: [N.model, N.conv, N.know, N.test], page: page("/calculators/black-scholes-calculator/") };
    } },
  { name: "implied_volatility", title: "Implied volatility from an option price",
    description: "The Black-Scholes volatility at which the model value equals a given option price, or a message when no volatility fits that price. All inputs, including the interest rate and dividend yield, must be supplied.",
    inputSchema: { type: "object", additionalProperties: false, required: ["option_type", "option_price", "underlying_price", "strike", "days_to_expiry", "rate_pct", "dividend_yield_pct"], properties: {
      option_type: KIND, option_price: PCT("Option price per share in dollars."), underlying_price: PCT("Underlying price in dollars."), strike: PCT("Strike in dollars."),
      days_to_expiry: PCT("Calendar days to expiry (above zero)."), rate_pct: PCT("Interest rate per year in percent (0 is allowed)."), dividend_yield_pct: PCT("Dividend yield per year in percent (0 is allowed).") } },
    run(a) {
      const k = mEnum(a, "option_type", ["call", "put"]), days = mNum(a, "days_to_expiry");
      if (!(days > 0)) throw new RangeError("no solution: time to expiry must be above zero");
      const iv = HeadroomCalc.impliedVol(k, mNum(a, "option_price"), mNum(a, "underlying_price"), mNum(a, "strike"), days / 365, mNum(a, "rate_pct") / 100, mNum(a, "dividend_yield_pct") / 100);
      return { implied_volatility: iv === null ? "No implied volatility fits this price" : mPct(iv), label: "model estimate", notes: [N.model, N.know, N.test], page: page("/calculators/black-scholes-calculator/") };
    } },
  { name: "covered_call", title: "Covered call returns",
    description: "For 100 shares per contract with one call written against them: net debit, breakeven at expiry, return if called and if not called (each with its per-year figures), highest and lowest P/L at expiry.",
    inputSchema: { type: "object", additionalProperties: false, required: ["share_price", "call_strike", "premium", "days_to_expiry"], properties: {
      share_price: { ...PRICE, description: "Price per share paid for the stock (or its price now), in dollars, e.g. \"50\"." }, call_strike: { ...PRICE, description: "Strike of the call written against the shares, in dollars." },
      premium: { ...PRICE, description: "Premium received per share for the call." }, days_to_expiry: { type: "integer", minimum: 1, description: "Calendar days until the call expires." }, contracts: { type: "integer", minimum: 1, default: 1, description: "Number of contracts; each covers 100 shares. Default 1." } } },
    run(a) {
      const st = mPrice(a, "share_price"), k = mPrice(a, "call_strike"), pr = mPrice(a, "premium"), d = mInt(a, "days_to_expiry", null, 1), n = mInt(a, "contracts", null, 1, 1);
      const o = HeadroomCalc.coveredCall(st, k, pr, d), sh = 100 * n;
      return { net_debit_per_share: mTk(o.net_debit), breakeven_at_expiry: mTk(o.breakeven), premium_share_of_price: mFp(o.downside_protection),
        highest_pnl_at_expiry: mTs(o.max_profit * sh, true), lowest_pnl_at_expiry: mTs(-o.net_debit * sh, true),
        return_if_not_called: mAnn(o.static_return, d), return_if_called: mAnn(o.if_called_return, d),
        notes: [N.exact, N.ann, N.conv, N.know, N.test], page: page("/calculators/covered-call-calculator/") };
    } },
  { name: "cash_secured_put", title: "Cash-secured put returns",
    description: "For a put written with cash set aside to take 100 shares per contract at the strike: cash secured, breakeven and cost per share if assigned, return on the cash with its per-year figures, highest and lowest P/L at expiry.",
    inputSchema: { type: "object", additionalProperties: false, required: ["put_strike", "premium", "days_to_expiry"], properties: {
      put_strike: { ...PRICE, description: "Strike of the put written, in dollars." }, premium: { ...PRICE, description: "Premium received per share for the put." },
      days_to_expiry: { type: "integer", minimum: 1, description: "Calendar days until the put expires." }, contracts: { type: "integer", minimum: 1, default: 1, description: "Number of contracts; each secures 100 shares. Default 1." } } },
    run(a) {
      const k = mPrice(a, "put_strike"), pr = mPrice(a, "premium"), d = mInt(a, "days_to_expiry", null, 1), n = mInt(a, "contracts", null, 1, 1);
      const o = HeadroomCalc.cashSecuredPut(k, pr, d), sh = 100 * n;
      return { cash_secured: mTs(o.cash_secured * sh), breakeven_and_cost_if_assigned: mTk(o.breakeven), return_on_cash: mAnn(o.return_on_cash, d),
        highest_pnl_at_expiry: mTs(pr * sh, true), lowest_pnl_at_expiry: mTs(-o.breakeven * sh, true),
        notes: [N.exact, N.ann, N.conv, N.know, N.test], page: page("/calculators/cash-secured-put-calculator/") };
    } },
  { name: "covered_call_roll", title: "Covered call roll",
    description: "Closing a written call and writing a new one: net credit or debit of the roll, total premium kept, new breakeven, return if called at the new strike with its per-year figures, highest and lowest P/L at the new expiry.",
    inputSchema: { type: "object", additionalProperties: false, required: ["share_cost", "new_premium", "new_strike", "days_to_new_expiry"], properties: {
      share_cost: { ...PRICE, description: "What the shares cost per share, in dollars." }, premiums_received_so_far: { ...PRICE, description: "Premiums kept so far per share (default 0)." }, cost_to_close: { ...PRICE, description: "Cost per share to close the current call (default 0)." },
      new_premium: { ...PRICE, description: "Premium per share received for the new call." }, new_strike: { ...PRICE, description: "Strike of the new call, in dollars." },
      days_to_new_expiry: { type: "integer", minimum: 1, description: "Calendar days until the new call expires." }, contracts: { type: "integer", minimum: 1, default: 1, description: "Number of contracts; each covers 100 shares. Default 1." } } },
    run(a) {
      const b = mPrice(a, "share_cost"), got = mPriceOr0(a, "premiums_received_so_far"), cl = mPriceOr0(a, "cost_to_close"), np = mPrice(a, "new_premium"), nk = mPrice(a, "new_strike");
      const d = mInt(a, "days_to_new_expiry", null, 1), n = mInt(a, "contracts", null, 1, 1), o = HeadroomCalc.roll(b, got, cl, np, nk, d), sh = 100 * n;
      return { net_from_roll_per_share: { amount: mTk(Math.abs(o.net_roll)), kind: o.net_roll >= 0 ? "credit" : "debit" }, total_premium_per_share: mTk(o.total_premium),
        new_breakeven: mTk(o.breakeven), return_if_called: mAnn(o.if_called_return, d),
        highest_pnl_at_new_expiry: mTs((nk - o.breakeven) * sh, true), lowest_pnl_at_new_expiry: mTs(-o.breakeven * sh, true),
        notes: [N.exact, N.ann, N.conv, N.know, N.test], page: page("/calculators/covered-call-roll-calculator/") };
    } },
  { name: "annualized_return", title: "Annualized return",
    description: "Turns a return over a number of calendar days into per-year figures, simple and compounded, shown beside the period return.",
    inputSchema: { type: "object", additionalProperties: false, required: ["return_pct", "days"], properties: {
      return_pct: PCT("Return over the period in percent; a loss with a minus, not below -100."), days: { type: "integer", minimum: 1, description: "Calendar days the return took." } } },
    run(a) {
      const r = mNum(a, "return_pct") / 100, d = mInt(a, "days", null, 1), x = HeadroomCalc.annualize(r, d);
      return { over_the_period: mPct(r), days: d, per_year_simple: mPct(x[0]), per_year_compounded: mPct(x[1]), notes: [N.ann, N.know, N.test], page: page("/calculators/annualized-return-calculator/") };
    } },
];
for (const t of TOOLS) t.annotations = { title: t.title, ...RO };
const TOOL_BY = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------------ JSON-RPC
function rpcOk(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }; }
function callTool(p, used) {
  const t = p && TOOL_BY[p.name];
  if (!t) return { err: [-32602, `Unknown tool: ${String(p && p.name).slice(0, 64)}`] };
  used.push(t.name);
  try {
    const out = t.run(p.arguments || {});
    return { result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false } };
  } catch (e) {
    if (e instanceof Ask || e instanceof RangeError || e instanceof TypeError) {
      const msg = e instanceof TypeError ? "unexpected input type: " + e.message : e.message;
      return { result: { content: [{ type: "text", text: msg }], isError: true } };
    }
    return { result: { content: [{ type: "text", text: "The calculation failed on these inputs; check each value and try again." }], isError: true } };
  }
}
function rpcOne(m, used, client) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcErr(m && m.id, -32600, "Invalid JSON-RPC request");
  const note = !("id" in m);
  switch (m.method) {
    case "initialize": {
      const asked = m.params && m.params.protocolVersion;
      if (m.params && m.params.clientInfo && typeof m.params.clientInfo.name === "string") client.name = m.params.clientInfo.name;
      return rpcOk(m.id, { protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_INFO, instructions: MCP_INSTRUCTIONS });
    }
    case "ping": return note ? null : rpcOk(m.id, {});
    case "tools/list": return rpcOk(m.id, { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case "tools/call": { const r = callTool(m.params, used); return r.err ? rpcErr(m.id, r.err[0], r.err[1]) : rpcOk(m.id, r.result); }
    case "resources/list": return rpcOk(m.id, { resources: [] });
    case "prompts/list": return rpcOk(m.id, { prompts: [] });
    default:
      if (note || m.method.startsWith("notifications/")) return null;
      return rpcErr(m.id, -32601, `Method not found: ${m.method.slice(0, 64)}`);
  }
}
const MCP_HDR = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, authorization, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version", "x-content-type-options": "nosniff", "cache-control": "no-store",
  "referrer-policy": "strict-origin-when-cross-origin", "strict-transport-security": "max-age=31536000" };
function mcpCount(env, used, client) {
  if (!env || !env.HD_EVENTS || !used.length) return;
  const c = /^[A-Za-z0-9 ._-]{1,40}$/.test(client.name || "") ? client.name.toLowerCase() : "other";
  const day = new Date().toISOString().slice(0, 10);
  for (const t of used.slice(0, 10)) env.HD_EVENTS.writeDataPoint({ blobs: ["mcp", t, c, day], indexes: ["mcp"] });
}
async function handleMcp(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...MCP_HDR, "access-control-max-age": "86400" } });
  if (request.method !== "POST") return new Response(JSON.stringify(rpcErr(null, -32000, "This MCP endpoint accepts POST only (JSON-RPC over Streamable HTTP, no SSE stream). About it: " + MCP_SITE + "/mcp-server/")),
    { status: 405, headers: { ...MCP_HDR, allow: "POST, OPTIONS", "content-type": "application/json" } });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 65536) return new Response(JSON.stringify(rpcErr(null, -32600, "Request too large")), { status: 413, headers: { ...MCP_HDR, "content-type": "application/json" } });
  let body;
  try { const t = await request.text(); if (t.length > 65536) throw new Error("big"); body = JSON.parse(t); }
  catch (e) { return new Response(JSON.stringify(rpcErr(null, -32700, "Parse error: the body must be JSON-RPC 2.0")), { status: 400, headers: { ...MCP_HDR, "content-type": "application/json" } }); }
  const used = [], client = { name: (request.headers.get("user-agent") || "").split(/[\/ ]/)[0] };
  let out;
  if (Array.isArray(body)) out = body.slice(0, 20).map((m) => rpcOne(m, used, client)).filter((x) => x !== null);
  else out = rpcOne(body, used, client);
  try { mcpCount(env, used, client); } catch (e) {}
  const pv = MCP_VERSIONS.includes(request.headers.get("mcp-protocol-version")) ? request.headers.get("mcp-protocol-version") : MCP_VERSIONS[0];
  if (out === null || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202, headers: MCP_HDR });
  return new Response(JSON.stringify(out), { status: 200, headers: { ...MCP_HDR, "content-type": "application/json", "mcp-protocol-version": pv } });
}
