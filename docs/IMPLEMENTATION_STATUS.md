# Implementation and verification status

[README](../README.md) · [Demo guide](DEMO.md) · [Sources](SOURCES.md)

This document describes the repository reviewed on **October 11, 2026**. It separates source implementation, automated coverage, and live execution evidence. Test references identify coverage in the repository; they do not claim that a new test run or live provider verification was performed during this documentation update.

## Implementation map

| Capability | Source | Coverage examples | Current boundary |
| --- | --- | --- | --- |
| Conversation extraction and missing-information questions | [conversation.ts](../server/llm/conversation.ts), [intake.ts](../server/agent/intake.ts) | [conversation tests](../tests/conversation.test.ts), [intake tests](../tests/agent-intake.test.ts) | Live NIM requires `NVIDIA_API_KEY`; template fallback is implemented |
| Confirmed, versioned requirements | [request model](../shared/agent-request.ts), [schemas](../shared/schemas.ts) | [request tests](../tests/conversation-request.test.ts), [conversation UI tests](../tests/conversation-ui.test.ts) | Changes invalidate prior confirmation |
| Protected funds and baseline plans | [planning.ts](../shared/planning.ts) | [planning tests](../tests/planning.test.ts) | General liquidity calculation rejects cross-asset expenses |
| Dated jUSDT allocation and sizing | [jusdt-allocation.ts](../shared/jusdt-allocation.ts), [assessment.ts](../server/agent/assessment.ts) | [allocation tests](../tests/jusdt-allocation.test.ts), [assessment tests](../tests/agent-assessment.test.ts) | Selection depends on complete, fresh, amount-specific evidence; expense investment requires explicit liquidity-risk acceptance |
| Illustrative USDT interest | [demo-estimate.ts](../shared/demo-estimate.ts) | [demo estimate tests](../tests/demo-estimate.test.ts) | Fixed synthetic 5% APY; pre-cost output is separate from verified net-return evaluation |
| Mainnet market and alternative reads | [data adapters](../server/data), [MCP registry](../server/mcp/registry.ts) | [market tests](../tests/jusdt-market.test.ts), [alternative tests](../tests/alternatives.test.ts), [MCP tests](../tests/quote-mcp.test.ts) | Provider availability and complete route evidence require runtime checks |
| Goal monitoring | [goal-monitor.ts](../src/features/review/goal-monitor.ts) | [monitor tests](../tests/goal-monitor.test.ts), [diagnostic tests](../tests/monitor-diagnostics.test.ts) | Advisory signals while the browser is active |
| Evidence review and replay | [review.ts](../shared/review.ts), [replay.ts](../shared/replay.ts) | [review tests](../tests/review.test.ts), [replay tests](../tests/sizing-replay.test.ts) | Insufficient evidence leaves realized profit/loss unknown; replay is read-only |
| Nile jTRX approval and recovery | [approval service](../server/agent/approval-service.ts), [coordinator](../server/agent/coordinator.ts), [ledger](../server/agent/ledger.ts) | [approval tests](../tests/approval-service.test.ts), [recovery tests](../tests/nile-approval-recovery.test.ts), [withdrawal tests](../tests/nile-withdrawal-flow.test.ts) | User-approved experimental code; historical receipts are not included |
| Nile PSM approval and conversion | [nile-psm.ts](../server/nile-psm.ts), [psm-approval.ts](../server/psm-approval.ts) | [PSM tests](../tests/nile-psm.test.ts), [PSM approval tests](../tests/psm-approval.test.ts) | Original successful live round-trip evidence is absent |

## Financial scope

The current Mainnet plan entry point requires **USDT holdings**. It constructs hold, JustLend jUSDT, and PSM-to-jUSDD comparison routes, plus a dated allocation result when the required quote/sizing inputs are available. Unsupported or incomplete routes remain unavailable; their presence in a comparison does not establish an executable recommendation.

The Nile entry point requires **TRX holdings** and includes capped 80/20 and 50/50 jTRX examples, a hold baseline, and dated-allocation evaluation. Those two scenario ratios are explicitly constructed in code. They must not be presented as a globally optimized three-product allocation.

Stake 2.0 and SUN.io currently have research/diagnostic adapters. This checkout does not establish a live **USDT + USDD + staking** optimizer or a complete general **TRX ↔ USDT** expense-funding workflow. The current general liquidity function rejects expenses whose asset identity differs from the holdings.

The illustrative calculator's fixed rate does not become a live quote. Missing entry/redemption costs, conversion evidence, exit capacity, or current data cannot be interpreted as zero cost or a verified positive net return. Mainnet execution remains disabled.

## Historical claims requiring original evidence

The earlier README contained the following reports. Their referenced evidence files are absent from this checkout, so they are retained here as historical reports rather than independently verified results.

| Earlier report | Evidence needed to substantiate it |
| --- | --- |
| A 1 TRX Nile deposit and redemption of 89.46435499 jTRX were confirmed | Original deposit/redemption txIDs, solidified receipts, wallet/contract identity, linked position, and actual received TRX |
| Live NIM extraction and some browser flows were checked on September 29, 2026 | Recorded run context, commit, redacted request/response, and corresponding browser evidence |
| A test wallet held 2,000 USDD under a different contract from the PSM-compatible token | Original network, token contracts, block/time, and contract-specific balances |

The absent files included `NILE_A_EVIDENCE.md` and `NILE_PSM_EXECUTION.md`. Links to those missing files have been removed from the README. No replacement transaction IDs or receipts have been invented.

## Recording a reproducible result

For an automated run, record the commit, Node version, exact command, date, and complete pass/fail summary. Use `npm run check` for the current test/build gate.

For a live provider read, retain the chain, source, query timestamp, source-update timestamp when available, response validation, and any missing evidence. Configuration presence alone does not prove a successful provider response.

For a live Nile action, retain the original txID, solidified receipt, account, contracts, plan/intent linkage, and before/after position evidence. For withdrawal or conversion, include the actual received amount. A broadcast response alone is insufficient.

Use these records to update this document after a new verification run. Public reports should exclude credentials, private keys, recovery phrases, and signed raw payloads.

## Pipeline assets

The current README Mermaid diagram describes the implementation reviewed here. Earlier [overview](images/tromm-pipeline.png) and [detailed](images/pipeline_mermaid.png) images remain available as historical design assets. Their labels do not replace current source review or transaction evidence.
