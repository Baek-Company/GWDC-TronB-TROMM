# GWDC 2026 · TRON Challenge B

An AI-assisted TRON asset-planning prototype that starts with a simple question: **when will the money be needed?**

The app collects a holder's balance, planned expenses, emergency buffer, time horizon, and risk preference. Its deterministic planner divides the balance into date-based buckets, compares holding USDT with JustLend jUSDT, the USDD PSM → jUSDD route, and TRX Stake 2.0 with SR voting, then recommends the highest positive net-return allocation that still preserves liquidity for each date.

The LLM extracts stated input and explains verified results. It does not calculate returns, choose allocations, create transactions, or sign them.

## What makes the prototype different

- **Dated liquidity ladder**: every scheduled expense, emergency buffer, and final balance is evaluated separately.
- **Three-route allocation**: a multi-start numerical search allocates each dated bucket among jUSDT, jUSDD, and TRX Stake 2.0, with holding available when it improves the modeled result. It evaluates fees, swap slippage, and exit timing. Balanced profiles cap total USDD exposure at 50%; aggressive profiles cap it at 75%. The search finds the best candidate it tests; it is not a proof of a global optimum.
- **Exit preparation**: a funded bucket begins withdrawal preparation two days before its use date.
- **Stake 2.0 timing gate**: a bucket can use TRX staking only when its dynamic unfreeze delay and a one-day action buffer both fit before withdrawal preparation. The plan schedules its unstake request explicitly.
- **Conversion-aware staking**: the staking route estimates USDT → TRX → USDT conversion through the current SunSwap V2 pool snapshot and includes conversion and network costs.
- **Net return, not headline APY**: the planner includes entry, withdrawal, PSM conversion, and estimated network costs.
- **Guardrails**: unavailable data, negative net return, insufficient liquidity, and declined USDD risk lead to holding instead of a forced deposit.
- **Re-evaluation**: a selected plan is recalculated every five minutes while the browser is open. The app suggests keeping, reviewing, or pausing the plan; it never executes a Mainnet transaction automatically.
- **Focused product flow**: the user sees requirements, one recommended plan, and monitoring. Comparison baselines and raw sources are available as details instead of separate product areas.

## User flow

1. Enter requirements in Korean conversation or the form.
2. Confirm the extracted requirements.
3. Review the date-based allocation and its withdrawal or unstake schedule.
4. Start monitoring the recommended plan.
5. Re-evaluate it when market data or the spending schedule changes.

## Architecture

```text
shared/
  needs.ts       input validation and dates
  planning.ts    A/B/C/hold baselines and recommendation
  ladder.ts      dated allocation search across three routes
  monitor.ts     deterministic keep/review/pause decision
  schemas.ts     shared API contracts

server/
  data/          TRON, JustLend, USDD, SunSwap, and Stake 2.0 data readers
  llm/           NIM adapter and safe template fallback
  index.ts       local API

src/
  features/      requirements, plans, and monitoring
```

## Run locally

```bash
git clone https://github.com/<your-username>/GWDC.git
cd GWDC
cp .env.example .env.local   # fill in your keys
pnpm install                  # or npm install
sh scripts/run dev
```

Open `http://127.0.0.1:5173/`. Stop the process with `Control+C`.

```bash
sh scripts/run typecheck
sh scripts/run test
sh scripts/run build
sh scripts/run doctor
```

Copy `.env.example` to `.env.local` before configuring external keys. Do not commit `.env.local`.

`DATA_MODE=synthetic` is the default demo mode. It must be visibly treated as synthetic. Use `DATA_MODE=live` only when the configured data sources are available and restart the server after changing it.

## Scope and limits

- Mainnet is read-only analysis. It does not create, sign, or broadcast Mainnet transactions.
- Projected returns use a snapshot of rates, liquidity, and estimated costs. They are not guaranteed returns.
- Incentive rewards are excluded unless independently verified.
- The two-day withdrawal preparation window and one-day stake action buffer are product safety policies, not protocol guarantees.
- The staking route assumes the current SunSwap pool price remains unchanged at the planned exits. It does not forecast TRX price movements.
- Mainnet plans accept USDT or TRX holdings and USDT or TRX expenses. TRX expenses are reserved in TRX at the start; the remaining planning budget is valued in USDT using a SunSwap pool quote. Entry swap slippage and estimated network costs are included in the reported USDT net return. A displayed TRX equivalent uses the current fixed quote; future TRX price moves are not forecast.
- The optimizer works on the converted USDT budget. Direct staking of the original TRX before conversion is not modeled, so the searched mix is not a global optimum across every possible transaction path.
- Nile testnet code remains as a development-only transaction test harness.
