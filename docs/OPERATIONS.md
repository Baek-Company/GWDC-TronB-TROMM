# Approval, recovery, and data handling

[README](../README.md) · [Setup](SETUP.md) · [Demo guide](DEMO.md)

## Environment boundaries

Mainnet is used for reads and plan assessment. Nile is a separate experimental transaction environment. Quotes, assets, balances, and receipts must retain their chain identity.

The capability endpoints expose:

| Field | Meaning |
| --- | --- |
| `mainnetExecution: false` | Mainnet transaction execution is disabled |
| `nileExperimentalExecution: true` | Experimental Nile workflow code exists; this does not prove a successful transaction |
| `nileApprovalLedgerReady` | Local approval storage is initialized when a valid encryption key is configured |
| Wallet/chain readiness `null` | Readiness is validated for the actual action rather than assumed at API startup |

## User-approved jTRX transaction

1. Review a current preview with the account, chain, contract, method, amount, costs, and exit conditions.
2. Sign a **wallet ownership verification message** in TronLink.
3. The server checks the confirmed input version, protected funds, current preview, and account state before reserving an intent.
4. Sign the **transaction separately** in TronLink.
5. The server validates the signed payload and stores it with the original txID in the encrypted ledger.
6. The browser broadcasts the stored transaction through the approval workflow. Failed ledger storage prevents submission.
7. Reconcile the original txID using the solidified receipt and matching position.

An ownership signature does not authorize a transaction signature. The coordinator checks the signed account, target contract, method, amount, fee limit, expiration, and preview binding.

Redemption is linked to the same account, position, contract, plan, and original server intent as the confirmed deposit. It receives a new preview and separate approval/signature. Actual received TRX must be verified before a completed recovery result is recorded.

Economic evidence can remain incomplete even when a technical test preview is possible. Such tests require explicit confirmation of the displayed limitations and must not be described as profit recommendations.

## PSM steps

The separate PSM workflow uses the same authentication and encrypted-ledger approach. A round trip may require **USDD approval → USDD-to-USDT conversion → USDT approval → USDT-to-USDD conversion**. Each action has its own confirmation, signature, txID, receipt, and balance refresh.

Contract identity is part of the asset identity. Check token contracts, decimals, allowances, capacity, and Energy/Bandwidth costs rather than relying on ticker names.

## Recovery after interruption

Use the first screen's unresolved-server-transaction recovery control when an action's state is unclear.

| State | Recovery behavior |
| --- | --- |
| Reserved but not signed | Confirm server cancellation, then request a new preview |
| Signed or submitted | Query the stored original txID; do not create a replacement signature or manually rebroadcast |
| Input save failed or the business date changed | Existing confirmation/preview cannot be used for signing |
| Another tab has an unresolved action for the same wallet | Resolve the original action before starting another |
| API restarted | Re-authenticate; recover existing intents from the same ledger and key |

The encryption key and ledger file must remain available together. Losing or changing the key prevents recovery of encrypted pending payloads. The local browser record does not replace the server ledger.

## Monitoring and review

Saved goal baselines are reassessed on screen entry, every five minutes, and when the browser regains focus. Outcomes include **maintain**, **pause new deposits**, and **review**. These signals do not authorize transactions.

Record review checks links between deposits, redemptions, receipts, and positions. A balance alone does not identify the trade that created it. Missing transaction evidence leaves realized profit/loss unresolved. Adjustment drafts and snapshot/synthetic replay do not broadcast transactions.

Closed-browser notifications, unattended execution, and automatic background rebalancing are not supported.

## Storage and privacy

| Data | Location or destination |
| --- | --- |
| Declared inputs, confirmation versions, selected plans, monitoring baselines, and browser transaction records | Browser localStorage with version information |
| Approval intents and signed raw transactions | Local encrypted SQLite ledger; default path `tmp/nile-approval.sqlite` |
| Conversation messages | Local API; also NVIDIA when NIM extraction is requested with a configured key |
| Public wallet addresses | Relevant RPC/provider reads when wallet information is requested |
| API keys | Local server environment configuration |
| Private keys and recovery phrases | Never requested or stored by the application; wallet signing happens in TronLink |

Approval authentication uses ten-minute `HttpOnly`, `SameSite=Strict` cookies bound to the local UI origin and Nile account. An API restart requires re-authentication while stored ledger evidence remains available.

Environment files and default ledger storage are excluded by [.gitignore](../.gitignore). Exported session JSON can contain user inputs and public wallet/transaction records; review that content before publishing it.
