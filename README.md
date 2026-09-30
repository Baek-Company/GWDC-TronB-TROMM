# 🌊 GWDC 2026 · TRON Asset Planning

**TROMM** is a pre-development and demonstration app for GWDC 2026 Challenge B. It organizes user requirements and provides virtual asset planning calculations, market lookups, and user-approved transactions on the Nile testnet.

> ⚠️ **Mainnet is used for lookups and plan comparisons, while Nile is a separate technical testing environment.**
> Nile TRX/jTRX deposit and redemption transactions have been empirically verified. Nile PSM live transactions and executable Mainnet plans have not been verified. Asset, interest-rate, and transaction evidence from the two environments must not be combined.

## 🗂️ Table of Contents

- [Quick Start](#quick-start)
- [Screens and Key Features](#screens-and-key-features)
- [Data and Verification Scope](#data-and-verification-scope)
- [Environment Configuration](#environment-configuration)
- [Nile Transactions and Recovery](#nile-transactions-and-recovery)
- [Storage and Privacy](#storage-and-privacy)
- [Development and Verification Commands](#development-and-verification-commands)
- [Related Documents](#related-documents)

## 🚀 Quick Start

**Node.js 24 and npm** are required. Run the following commands from the project root.

### 🍎 macOS

```sh
./scripts/run ci
./scripts/run run dev
```

`scripts/run` prioritizes an installed Homebrew Node.js 24 installation.

### 🪟 Windows · PowerShell

```powershell
npm ci
npm run dev
```

| Target | Default Address |
| --- | --- |
| 🌐 App · Nile Demo | http://127.0.0.1:5173 |
| 💚 API Health | http://127.0.0.1:8787/api/health |

If API keys or Nile transaction settings are required, refer to [.env.example](.env.example), create `.env.local`, and restart the development server. See [Environment Configuration](#environment-configuration) for details.

## 🧭 Screens and Key Features

| Screen | Key Features |
| --- | --- |
| 🏠 `/` · `/nile` | Check Nile status, wallet network, and transaction evidence; enter virtual TRX holdings and dated expenses; create jTRX plans and run a separate PSM test |
| 🗓️ `/usdt-demo` | 7-day calendar based on Korea Standard Time; calculates deployable funds after subtracting planned expenses and reserves from virtual holdings; displays pre-cost interest based on an assumed rate |
| 🧮 `/plans` | USDT scenario calculations separated from real balances and market lookups; displays unverified costs, net profit, and execution eligibility |
| 📈 `/markets` | Queries JustLend Mainnet REST when the screen is opened or manually refreshed |

The status of PSM, Stake 2.0, SUN.io, and MCP is checked through separate sources and connection screens.

### ✨ Requirement Analysis and Plan Management

- 🧾 **Requirement Analysis:** Extracts explicitly provided information into JSON and provides missing-information questions and a summary. When edited, the information is revalidated. It uses NIM `openai/gpt-oss-20b` for sentence extraction with a template-based fallback path.
- 🧮 **Plan Evaluation:** Supports research for market-related questions, date-based allocation evaluation, and storage of read-only baselines.
- 👀 **Goal Monitoring:** Rechecks stored plans when the screen is opened, every 5 minutes, and when the tab regains focus. It indicates whether to maintain the plan, pause new deposits, or review the plan.
- 🔍 **Record Review:** Verifies links between deposits, redemptions, and positions. Profit/loss conclusions are withheld when evidence is insufficient. Adjustment drafts do not execute transactions.
- 📦 **Export and Replay:** Supports session JSON export and replay using historical (`snapshot`) or virtual (`synthetic`) data. Replay does not execute transactions.

## 📊 Data and Verification Scope

### 🌐 Mainnet · Lookups and Scenario Calculations

The current USDT plan uses a **synthetic 5% annual APY**, not a measured live interest rate. For example, the estimated pre-cost interest for deploying 800 USDT for 30 days is:

```text
800 × ((1 + 0.05)^(30/365) − 1) ≈ 3.21 USDT
```

Entry and redemption costs and net profit have not been verified, and Mainnet execution eligibility is set to `false`. Checking a real Mainnet USDT balance is not a prerequisite for demonstrating the scenario calculation. Minimum deployable amount analysis is also withheld because no server-side evidence currently supports the applicability of a fixed round-trip cost.

Official data is stored together with its source URL, chain, and query timestamp, while query time and source-update time are tracked separately. Sample data, historical snapshots, and live data are clearly distinguished. API failures are not replaced with fabricated live values. JustLend base yield and incentives, APY and APR, holding periods, costs, and withdrawal restrictions are also treated separately.

### 🧪 Nile · User-Approved Technical Testing

| Item | Supported Scope and Verification Record |
| --- | --- |
| 🔄 TRX · jTRX | TRX 80/20 and 50/50 plans, deposit/redemption pre-validation, separate signing, and original transaction tracking |
| ✅ Verified Record | Confirmed a 1 TRX deposit and redemption of 89.46435499 jTRX from a test wallet using the two original txIDs, solidified receipts, matching positions, and the actual received TRX amount |
| 🧪 PSM USDD ↔ USDT | Bidirectional contract, balance, capacity, fee, and step-by-step Energy/Bandwidth validation code; mock tests and read-only verification completed. Successful live transactions have not been verified |

The 2,000 USDD deposited into the test wallet used in the PSM verification record had a **different contract address** from the USDD used by the PSM. Therefore, the PSM-compatible balance was 0 at the time of verification. Tokens with the same name but different contracts and the jUSDD deposit path are not included in the PSM test. Evidence is documented in [TRX/jTRX Verification Record](docs/NILE_A_EVIDENCE.md) and [PSM Verification Record](docs/NILE_PSM_EXECUTION.md).

A new Nile session starts with an example of **100 TRX and a planned expense of 20 TRX seven days later**. Up to 10 dated expenses can be entered. The maximum deployable amount is calculated after excluding protected funds reserved for expenses. Existing sessions preserve the original inputs, while the `Apply example expense: 20 TRX in 7 days` button can be used to select the example. Nile test assets are never treated as Mainnet funds.

On September 29, 2026, the live server-side NIM requirement extraction was confirmed to return the holding amount, expense amount, expense date, and follow-up questions. Virtual date-based allocation storage, goal-monitoring indicators, and some read-only Mainnet wallet queries were also verified in the browser. These results and the Nile demonstrations do not constitute evidence of Mainnet transactions or unattended execution. For environment-specific completed and incomplete items, see [Implementation Status](docs/IMPLEMENTATION_STATUS.md).

## ⚙️ Environment Configuration

Configuration is stored locally in `.env.local`. This file is excluded from Git, and key values must not be recorded in documentation, Git, or chat. Any previously exposed key must not be reused.

| Variable | Purpose |
| --- | --- |
| `NVIDIA_API_KEY` | Used by the server for NIM-based requirement extraction |
| `TRONGRID_API_KEY` | Optional RPC read authentication. May reduce read restrictions but does not replace contract or market verification |
| `JUSTLEND_MCP_ENTRY` | Absolute path to the reviewed local JustLend MCP server entry |
| `NILE_WALLET_ADDRESS` | Optional Nile address used for read-only queries by `doctor` |
| `GWDC_APPROVAL_LEDGER_KEY_HEX` | Encryption key for the ledger used by Nile user-approved transactions. A 64-character hex value representing 32 locally generated random bytes |
| `GWDC_APPROVAL_LEDGER_PATH` | Optional ledger path. Default: `tmp/nile-approval.sqlite` |
| `UI_PORT` · `API_PORT` | UI and API ports. Defaults are `5173` and `8787`, respectively |

All configuration options are listed in [.env.example](.env.example). If a different UI port is used, `UI_PORT` must match the actual UI port so that the API's local-origin validation succeeds. The USDD MCP is not launched automatically because it may create a local wallet during startup. PSM uses read-only RPC access.

### 🔐 Preparing the Nile Approval Ledger

1. Set `GWDC_APPROVAL_LEDGER_KEY_HEX` in `.env.local`.
2. Restart the API.
3. Confirm `nileApprovalLedgerReady: true` at `/api/health`.

If the key is missing, the approval API returns **503**. The ledger file is excluded from Git. If the key is lost, pending signed transaction payloads cannot be recovered, so the key must not be changed during a test session.

`nileApprovalLedgerReady` indicates only whether the local ledger is ready. The actual wallet, balance, preview, signature, and on-chain result are validated separately at each stage.

| API Capability | Meaning |
| --- | --- |
| `mainnetExecution: false` | Mainnet transactions are not supported |
| `nileExperimentalExecution: true` | Nile experimental transaction code is supported |
| Wallet/chain readiness `null` | The server cannot determine readiness in advance, so it is checked on every action |

These capability distinctions are exposed through `/api/health` and `/api/capabilities`.

## 🔄 Nile Transactions and Recovery

### ✍️ User-Approved Transaction Flow

1. 👁️ Review the contract, balance, and fee preview.
2. ✍️ Sign a **wallet ownership verification message** in TronLink.
3. 🛡️ The server revalidates the latest protected-expense amount, quote, and balance, then reserves the transaction.
4. 🔏 The user performs a **separate transaction signature** in TronLink.
5. 🔐 The server stores the original txID and signed raw transaction in the encrypted ledger.
6. 📤 The browser submits the raw transaction. If server-side ledger storage fails, the transaction is not submitted.
7. ✅ The system rechecks the **solidified receipt and matching position** associated with the original txID.

The wallet ownership verification signature does not replace the transaction signature. Even for jTRX technical tests where economic data is insufficient, the system verifies the contract, active market, asset, account, and actual deposit fee, and only requests a signature after displaying detailed risk information and receiving user confirmation. It is not presented as a profit recommendation.

Broadcast acceptance alone is not considered proof of success. Redemption verifies the same account, plan, contract, and server intent ID associated with the confirmed deposit, followed by a separate preview, wallet confirmation, and transaction signature. The recovery flow is recorded only after the actual received TRX has been verified from the receipt.

PSM uses the same server authentication and encrypted ledger. Each step of **USDD approval → USDT receipt → USDT approval → USDD receipt** requires user confirmation, a TronLink signature, the original txID, a solidified receipt, and a refreshed balance check.

### 🧯 Recovery After Interruption or Refresh

If the state is unclear, use **`Check and recover unresolved server transactions`** on the first screen.

- **Before signing:** Confirm server cancellation of the `reserved` reservation, then create a new preview.
- **After signing:** Query the stored original txID. Do not request a new signature or rebroadcast the transaction.
- **Input save failure or Korea Standard Time date change:** Block signing based on an existing confirmation or preview.
- **Another tab using the same wallet has an unresolved transaction:** Block new transactions until the original txID has been checked.

Background transactions and notifications while the browser is closed, as well as unattended B-1/B-2 execution, are outside the supported scope. For a step-by-step demonstration, see the [Demo Script](docs/DEMO.md).

## 🛡️ Storage and Privacy

| Stored or Transmitted Data | Handling |
| --- | --- |
| Virtual inputs, confirmation versions, selected plans, monitoring baselines, and Nile original transaction records | Stored with version information in browser `localStorage` |
| Original intents and signed transactions for user-approved transactions | Stored separately from browser records in the local server's encrypted SQLite ledger |
| Conversation input | Sent to the server when requested. If a NIM key is configured, it is also sent to NVIDIA |
| Private keys and recovery phrases | Never entered into or stored by the app |

Server approval sessions are maintained for 10 minutes using `HttpOnly`, `SameSite=Strict` cookies bound to the same local UI origin and Nile account. Re-authentication is required after an API restart, but transaction evidence already stored in the ledger is preserved.

## 🧰 Development and Verification Commands

| Task | macOS | Windows · PowerShell |
| --- | --- | --- |
| 🖥️ Development server | `./scripts/run run dev` | `npm run dev` |
| 🧪 Tests | `./scripts/run run test` | `npm run test` |
| 🏗️ Type check and build | `./scripts/run run build` | `npm run build` |
| ✅ Full test, type check, and build | `./scripts/run run check` | `npm run check` |
| 🩺 Live connection diagnostics | `./scripts/run run doctor` | `npm run doctor` |

Vite reflects UI changes, while the development server watches configured directories under `server/` and `shared/` and restarts the API when code changes are detected. Environment configuration changes require a manual restart.

`doctor` classifies official read access, key status, and contract verification as `ready`, `unknown`, or `unavailable`. It does not fabricate live values when the network is unavailable.

The technical stack is **React · Vite · TypeScript**, with **Vitest** for testing. Dependencies are managed with npm and `package-lock.json`. Asset amounts and on-chain integer values are handled using strings and Decimal/BigInt.

## 📚 Related Documents

| Document | Description |
| --- | --- |
| 🧭 [Original Project Plan](docs/PROJECT_PLAN.md) | Project goals and chain-separation principles |
| 🧱 [Detailed Implementation Plan](docs/IMPLEMENTATION_PLAN.md) | Feature-by-feature implementation plan |
| 🔗 [Official Sources](docs/SOURCES.md) | Official data and contract references |
| 📌 [Implementation Status](docs/IMPLEMENTATION_STATUS.md) | Environment status and evidence for completed/incomplete features |
| ✅ [Nile User-Approved Verification Evidence](docs/NILE_A_EVIDENCE.md) | Verified TRX/jTRX live transaction records |
| 🧪 [Nile PSM Implementation and Verification Plan](docs/NILE_PSM_EXECUTION.md) | PSM transaction stages and token verification records |
| 🎬 [Demo Script](docs/DEMO.md) | Mainnet scenario calculation and Nile test demonstration flow |
