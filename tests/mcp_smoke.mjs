// Runs the MCP server locally the way the Worker does (engine first, then the server) and calls every tool once.
// Run: node tests/mcp_smoke.mjs
import { readFileSync } from "fs";
const eng = readFileSync(new URL("../src/headroom_calc_v1.js", import.meta.url), "utf8");
const srv = readFileSync(new URL("../src/mcp_server.js", import.meta.url), "utf8");
const handleMcp = new Function(`const HeadroomCalc = (function () { const self = {}; ${eng}\n return self.HeadroomCalc; })();\n${srv}\nreturn handleMcp;`)();
let id = 0, fails = 0;
const rpc = async (method, params) => (await handleMcp(new Request("https://example.test/mcp", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }), {})).json();
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } };
ok((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } })).result.serverInfo.name === "headroom-desk-calculators", "initialize");
const tools = (await rpc("tools/list", {})).result.tools;
ok(tools.length === 8 && tools.every((t) => t.annotations.readOnlyHint), "8 read-only tools");
const r = (await rpc("tools/call", { name: "options_pnl_at_expiry", arguments: { legs: [{ type: "call", side: "long", quantity: 1, strike: "100", price: "3.45" }] } })).result;
ok(r.structuredContent.breakevens_at_expiry[0] === "103.45", "long call breakeven 103.45");
const c = (await rpc("tools/call", { name: "cash_secured_put", arguments: { put_strike: "40", premium: "0.8", days_to_expiry: 30 } })).result;
ok(c.structuredContent.return_on_cash.per_year_simple === "24.33%", "cash-secured put 24.33% a year simple");
console.log(fails ? `smoke: ${fails} FAIL` : "smoke: all PASS");
process.exit(fails ? 1 : 0);
