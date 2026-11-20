<img src="assets/icon-512.png" alt="Headroom Desk" width="96" height="96">

# Headroom Desk options calculators (MCP server)

Exact options arithmetic for AI assistants: P/L at expiry and breakevens for up to 8 legs, Black-Scholes value, Greeks and implied volatility, covered call, cash-secured put, covered-call roll and annualized return. A free remote MCP server, read-only, no sign-in, nothing stored.

**Endpoint:** `https://headroomdesk.com/mcp` (Streamable HTTP, JSON-RPC 2.0, no authentication)
**Docs:** https://headroomdesk.com/mcp-server/
**Official MCP Registry:** `io.github.headroomdesk/calculators`

## Add it to your assistant

| Client | How |
|---|---|
| Claude (web, desktop, mobile) | Settings, Connectors: add a custom connector with the endpoint above. |
| Claude Code | `claude mcp add --transport http headroom-desk https://headroomdesk.com/mcp` |
| ChatGPT | In developer mode, create a connector with the endpoint above and no authentication. |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "headroom-desk": { "url": "https://headroomdesk.com/mcp" } } }` |
| VS Code | `.vscode/mcp.json`: `{ "servers": { "headroom-desk": { "type": "http", "url": "https://headroomdesk.com/mcp" } } }` |
| Windsurf | `mcp_config.json`: `{ "mcpServers": { "headroom-desk": { "serverUrl": "https://headroomdesk.com/mcp" } } }` |
| Gemini CLI | `settings.json`: `{ "mcpServers": { "headroom-desk": { "httpUrl": "https://headroomdesk.com/mcp" } } }` |

## Tools

| Tool | What it returns |
|---|---|
| `options_pnl_at_expiry` | Net premium, breakevens, highest and lowest P/L at expiry (or "Unlimited"), P/L at each strike, for up to 8 legs of calls, puts and shares. |
| `options_pnl_before_expiry` | Black-Scholes model estimate of a position's P/L on a later day at a given underlying price. |
| `black_scholes` | Model value per share and per contract, delta, gamma, theta per day, vega, rho. |
| `implied_volatility` | The volatility at which the model value equals a given price, or a message when none fits. |
| `covered_call` | Net debit, breakeven, return if called and if not, each with per-year figures beside it. |
| `cash_secured_put` | Cash secured, breakeven and return on cash, with per-year figures. |
| `covered_call_roll` | What a roll adds or takes away, the new breakeven and the return if called at the new strike. |
| `annualized_return` | A return over any number of days as simple and compounded per-year figures, beside the period return. |

No quote, interest rate, dividend yield or volatility is built in: tools that need them ask for them. When an input has no answer (a loss over 100%, a date after expiry, a price no volatility can produce), the tool returns a message, never a number.

What every answer carries:
- Exact at expiry for the numbers you typed. Not included: fees and commissions, early assignment, dividends, and what your broker does at expiry.
- Model: Black-Scholes. No early exercise, constant volatility and rate, dividends as a continuous yield. For American options (most US stock options) the price, Greeks and implied volatility are approximations, least reliable for deep in-the-money puts and around dividend dates.
- The tools do not know your broker, account type, tax position or fees.

## What is in this repository

| Path | What it is |
|---|---|
| `src/headroom_calc_v1.js` | The engine (HeadroomCalc v1.1.0), the same file the web calculators load. Money in exact $0.0001 ticks. |
| `src/mcp_server.js` | The MCP server. The Worker concatenates it after the engine. |
| `reference/headroom_calc_reference_v1.py` | An independent Python reference of the same arithmetic. |
| `reference/build_vectors_v1.py` | Checks the reference against published anchors (for example Hull's 4.76 / 0.81 Black-Scholes example) and writes the test vectors. |
| `tests/headroom_calc_vectors_v1.json` | 3,123 test cases from the reference. |
| `tests/run_vectors_v1.js` | Replays the vectors against the JS engine. |
| `tests/mcp_smoke.mjs` | Runs the server locally and calls the tools. |

Check it yourself (Python 3 and Node 18+):

```
cd reference && python3 -I build_vectors_v1.py && cd ..   # anchors pass; vectors regenerate byte-equal
node tests/run_vectors_v1.js tests/headroom_calc_vectors_v1.json src/headroom_calc_v1.js
node tests/mcp_smoke.mjs
```

Checked against 3,123 test cases (2026-11-20). The live server's tests also run on every deploy.

## Privacy

The server works only on the numbers in each request and keeps none of them. For each tool used it counts the tool's name, the client software's name and the date, with no IP address, identifier or input value. https://headroomdesk.com/privacy/

## Support

Questions or a wrong result: desk@headroomdesk.com. Not financial advice: arithmetic on the numbers you supply.

## Licence

MIT, see `LICENSE`.
