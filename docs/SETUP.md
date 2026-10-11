# Local setup

[README](../README.md) · [Demo guide](DEMO.md) · [Operations](OPERATIONS.md)

## Requirements

- Node.js **24.x**, as required by [package.json](../package.json).
- npm and a modern browser.
- TronLink and Nile test assets only if you intend to use the optional testnet signing workflow.

Run all commands from the repository root. The development launcher starts both the API and Vite, and loads `.env.local` when that file exists.

## Install and run

```sh
npm ci
npm run dev
```

On macOS, the existing wrapper selects `/opt/homebrew/opt/node@24/bin` when available:

```sh
./scripts/run ci
./scripts/run run dev
```

| Service | Default URL |
| --- | --- |
| Web interface | http://127.0.0.1:5173 |
| API health | http://127.0.0.1:8787/api/health |
| API capabilities | http://127.0.0.1:8787/api/capabilities |

Use **Ctrl+C** in the launching terminal to stop the API and Vite together. The illustrative USDT calculator works without keys or a connected wallet; external research calls still depend on provider availability.

## Configuration

Create `.env.local` **beside `package.json`** by copying [.env.example](../.env.example). Keep existing local settings when the file already exists. Restart the development server after changing configuration.

| Variable | Purpose | Required for |
| --- | --- | --- |
| `NVIDIA_API_KEY` | Server-side NVIDIA NIM key; the configured model is `openai/gpt-oss-20b` | Live language-model extraction; otherwise the template fallback is used |
| `TRONGRID_API_KEY` | Optional authentication header for TRON reads | Provider access where authentication is needed |
| `SUN_API_KEY` | Optional authentication header for SUN.io API reads | Provider access where authentication is needed |
| `JUSTLEND_MCP_ENTRY` | Absolute path to a reviewed local JustLend MCP server entry file | Optional JustLend MCP reads |
| `NILE_WALLET_ADDRESS` | Public Nile wallet address used by `doctor` | Optional wallet diagnostics |
| `GWDC_APPROVAL_LEDGER_KEY_HEX` | 32 random bytes encoded as **64 hexadecimal characters** | Nile approval-ledger initialization |
| `GWDC_APPROVAL_LEDGER_PATH` | Encrypted ledger location; defaults to `tmp/nile-approval.sqlite` | Optional custom storage location |
| `UI_PORT` | Web port; defaults to `5173` | Optional port change |
| `API_PORT` | API port; defaults to `8787` | Optional port change |

These names match the current server. Legacy settings such as `NIM_API_KEY`, `LLM_PROVIDER`, `DATA_MODE`, and `ENABLE_NILE_EXECUTION` do not configure the current implementation. The NIM endpoint and model ID are currently defined in [conversation.ts](../server/llm/conversation.ts).

The repository's [.gitignore](../.gitignore) excludes local environment files and the default ledger directory. If you choose a ledger location elsewhere inside the repository, add that location to the ignore rules before committing.

## Optional Nile approval ledger

1. Generate a random 32-byte key locally. For example, run this command on your own machine:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. Put the generated value in `GWDC_APPROVAL_LEDGER_KEY_HEX` in `.env.local`.
3. Restart the server and check `nileApprovalLedgerReady` in `/api/health`.
4. Connect the intended wallet in TronLink and select Nile before requesting a transaction preview.

Without a valid ledger key, Nile approval endpoints return **503**. Ledger readiness only confirms local storage initialization; wallet, network, contract, funds, fees, and transaction readiness are checked separately. Keep the same key and ledger file throughout a test session so unresolved signed payloads remain recoverable.

The USDD MCP server is not started automatically. The current application uses RPC reads for PSM because the MCP startup may initialize a local wallet. A JustLend MCP entry is optional, not a prerequisite for the illustrative calculator.

## Development checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript validation |
| `npm run test` | Automated Vitest suite |
| `npm run build` | Type checking and production frontend bundle |
| `npm run check` | Tests followed by the build |
| `npm run doctor` | Live provider and environment diagnostics; makes external reads |
| `npm run snapshot` | Fetch and export a data snapshot; makes external reads |

On macOS, each command can also be invoked through the wrapper, for example `./scripts/run run check`.

A production frontend bundle does not deploy the API. `doctor` reports configuration and read readiness; it does not prove transaction success or guaranteed investment availability. Tests using fixtures or mocked providers do not establish live-chain outcomes.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Node version error | Select Node.js 24 before installation or execution; use the macOS wrapper when applicable |
| Port 5173 or 8787 already in use | Stop the earlier development process in its original terminal, or choose unused `UI_PORT` and `API_PORT` values and restart |
| Local-origin validation fails | Open the configured local UI address and ensure `UI_PORT` matches Vite's actual port |
| Model falls back to templates | Check `NVIDIA_API_KEY`, restart, and inspect the provider status; key presence alone does not establish a successful model response |
| A quote or cost is unavailable | Inspect source diagnostics; preserve the unavailable status rather than substituting a sample as live evidence |
| An interrupted Nile action remains unresolved | Follow [transaction recovery](OPERATIONS.md#recovery-after-interruption) using the stored original txID |
