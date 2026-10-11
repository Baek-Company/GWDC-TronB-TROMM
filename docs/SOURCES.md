# Sources and integrations

[README](../README.md) · [Implementation status](IMPLEMENTATION_STATUS.md)

These are provider references and endpoints used or referenced by the current code. An integration reference identifies a data source; it does not certify live availability or a completed investment route.

## Provider map

| Provider or interface | Reference | Corresponding code | Purpose |
| --- | --- | --- | --- |
| TRON developer documentation | [TRON Developers](https://developers.tron.network/) | [RPC adapter](../server/data/tron-rpc.ts), [transactions](../server/transactions.ts) | Network reads and Nile transaction validation |
| TronGrid Mainnet RPC | [RPC endpoint](https://api.trongrid.io) | [RPC adapter](../server/data/tron-rpc.ts) | Mainnet contract, account, and chain-state reads |
| TronGrid Nile RPC | [RPC endpoint](https://nile.trongrid.io) | [RPC adapter](../server/data/tron-rpc.ts), [Nile costs](../server/data/nile-costs.ts) | Testnet state, fee estimation, receipts, and positions |
| JustLend DAO | [Overview](https://docs.justlend.org/getting_started/overview/) · [Contract directory](https://docs.justlend.org/developers/contracts.json) | [jUSDT market adapter](../server/data/jusdt-market.ts) | Market identity and on-chain state |
| JustLend market REST | [Market endpoint](https://openapi.just.network/lend/jtoken) | [market reader](../server/data.ts), [market parsing](../shared/markets.ts) | Mainnet market display |
| JustLend MCP | [MCP documentation](https://docs.justlend.org/ai_support/mcp_server/) | [MCP registry](../server/mcp/registry.ts), [MCP client](../server/mcp/clients.ts) | Optional local read-only market tools |
| TronGrid MCP | [MCP documentation](https://developers.tron.network/docs/mcp) | [TronGrid MCP client](../server/mcp/trongrid.ts) | Allowed read tools via the remote MCP interface |
| USDD PSM | [Upstream chain configuration](https://github.com/decentralized-usd/mcp-server-usdd/blob/master/src/core/chains.ts) | [USDD adapter](../server/data/usdd.ts), [Nile PSM](../server/nile-psm.ts) | Contract, token, capacity, and fee checks |
| USDD MCP | [MCP documentation](https://docs.usdd.io/ai-support/mcp-server) | [MCP registry](../server/mcp/registry.ts) | Documented integration; automatic startup is disabled in this application |
| TRON Stake 2.0 | [Staking APIs](https://developers.tron.network/docs/staking-apis) | [alternative readers](../server/data/alternatives.ts) | Research and chain-parameter diagnostics |
| SUN.io | [Pool API documentation](https://docs.sun.io/api/get-pools/) · [Pool endpoint](https://open.sun.io/apiv2/pools) | [alternative readers](../server/data/alternatives.ts), [swap pool](../server/data/swap-pool.ts) | Pool research and read-only conversion evidence |
| SUN.io prices | [Price endpoint](https://open.sun.io/apiv2/price) | [jUSDT costs](../server/data/jusdt-costs.ts), [research](../server/agent/research.ts) | Price evidence used in fee conversion and research |
| NVIDIA NIM | [LLM API reference](https://docs.api.nvidia.com/nim/reference/llm-apis) | [conversation extraction](../server/llm/conversation.ts) | Server-side `openai/gpt-oss-20b` extraction |

## Data interpretation

- Preserve source URL, network, query time, and source-update time when supplied.
- Keep `live`, `snapshot`, and `synthetic` modes distinct.
- Identify tokens by contract and decimals as well as ticker.
- Distinguish base interest from incentives, and preserve the rate kind (`APY` or `APR`).
- Keep missing fees, exit evidence, or conversion evidence unresolved.
- Keep Mainnet quotes and Nile test transactions in their respective environments.

The corresponding shared validation is in [provenance](../shared/provenance.ts), [eligibility](../shared/eligibility.ts), and [schemas](../shared/schemas.ts). Runtime connection diagnostics are available through `npm run doctor` and the `/connections` screen.
