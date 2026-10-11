# Demo guide

[README](../README.md) · [Setup](SETUP.md) · [Implementation status](IMPLEMENTATION_STATUS.md)

This guide presents the current application. The read-only walkthrough can be demonstrated without signing a transaction. Optional Nile actions use test assets and require additional configuration.

## 1. Show the expense-based question

Open `/usdt-demo` and explain the relationship:

```text
Deployable amount = declared holdings − protected expenses − reserve
```

Use an example of **1,000 USDT**, a **200 USDT** expense in seven days, no additional reserve, and a **30-day** horizon. The protected amount is 200 USDT and the illustrative deployable amount is 800 USDT.

## 2. Extract and confirm the conditions

Open `/needs`. For a Korean walkthrough, enter:

> 1000 USDT를 보유하고 있고 30일간 운용하고 싶어. 7일 후 200 USDT가 필요해. 추가 예비액은 0 USDT이고 위험 성향은 보수적이야. USDD는 제외해줘.

With `NVIDIA_API_KEY` configured, the server attempts NIM extraction. Otherwise it uses the template parser. Answer any follow-up questions, review the amounts and dates, and confirm the requirements. Edit one field to demonstrate that changed conditions require reconfirmation.

## 3. Explain the calculation basis

Open `/plans` and distinguish the fixed example from the separate evidence assessment. The current illustrative calculation is:

```text
800 × ((1 + 0.05)^(30/365) − 1) ≈ 3.21 USDT
```

This is **pre-cost interest under an assumed 5% APY**. It is not measured yield, net profit, or an executable Mainnet recommendation. Show how unavailable round-trip costs or exit evidence leave a verified decision unresolved.

## 4. Show research and monitoring

1. Open `/markets` and refresh the JustLend market data.
2. Show the source, network, query timestamp, and unavailable source-update timestamp when the provider does not supply one.
3. Open `/connections` to inspect separate provider and alternative-route diagnostics.
4. Save a read-only plan baseline where the assessment panel permits it.
5. Open `/review` to show monitoring and the distinction between a saved hypothetical plan and transaction evidence.
6. Export a session and replay it to demonstrate reproducible review without sending transactions.

Provider failure is a valid demonstration outcome: show the diagnosis and the resulting withheld decision. Monitoring runs on open, on focus, and every five minutes while the application is active.

## 5. Optional Nile jTRX workflow

Prepare Node.js 24, TronLink on **Nile**, the correct test assets, and the approval ledger described in [setup](SETUP.md#optional-nile-approval-ledger).

1. Open `/` or `/nile` and inspect the network and wallet state.
2. Use the new-session example of 100 TRX with a 20 TRX expense in seven days, or enter your own test conditions. Existing sessions retain their saved inputs.
3. Confirm the requirements and inspect the capped 80/20 and 50/50 jTRX scenarios.
4. Request a current preview. Check protected expenses, contract, balance, liquidity, and the TRX fee budget.
5. Confirm the preview, sign the wallet ownership message, and then separately sign the proposed transaction in TronLink.
6. Follow the original txID through receipt and position checks. Broadcast acceptance alone is insufficient.
7. For redemption, use the position linked to the confirmed deposit and repeat the preview and approval sequence.

If a check fails, use its reported reason and stop at that stage. A Nile technical transaction is not proof that a Mainnet product offers a profitable route.

## 6. Optional Nile PSM workflow

Use the separate PSM panel. Inspect the **exact token contract addresses**, balances, allowances, capacity, and step costs before each action. USDD or USDT with the same ticker but another contract cannot substitute for the expected token.

Each token approval and conversion requires its own user confirmation, signature, original txID, receipt, and refreshed balance. Do not present the PSM round trip as a verified achievement until its actual evidence has been recorded.

## Evidence to retain after a live test

Record the date, commit, chain, wallet address, contract addresses, original txIDs, solidified receipts, and before/after position balances. For redemption or conversion, record the actual received asset and amount. Keep API keys, private keys, recovery phrases, and signed payloads out of the public evidence report.

No video, screenshots of the current walkthrough, or original live transaction records are created by this guide. The [implementation status](IMPLEMENTATION_STATUS.md) identifies the evidence currently absent from the repository.
