import DecimalBase from 'decimal.js';
import { executionRecordSchema, observationSchema, planSchema, positionFlowSchema,
  type ExecutionRecord, type Observation, type Plan, type PositionFlow, type Token } from '../../shared/schemas';
import type { NileWithdrawalPreview } from '../../server/transactions';
import { normalizeTronAddress } from '../../shared/tron-address';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });

function sameToken(left: Token, right: Token) {
  return left.symbol === right.symbol && left.address === right.address && left.decimals === right.decimals;
}

/** Returns only a deposit movement backed by a solidified receipt and increased jTRX position. */
export function confirmedNileDepositFlow(rawPlan: Plan, rawRecord: ExecutionRecord,
  rawOpening: Observation | null, rawClosing: Observation | null): PositionFlow | null {
  if (rawOpening === null || rawClosing === null) return null;
  const plan = planSchema.parse(rawPlan);
  const record = executionRecordSchema.parse(rawRecord);
  const opening = observationSchema.parse(rawOpening);
  const closing = observationSchema.parse(rawClosing);
  const source = record.confirmationSource;
  if (plan.chain !== 'nile' || plan.kind !== 'justlend_jtrx' || !plan.quote?.receiptToken ||
      record.action !== 'deposit' || record.chain !== 'nile' || record.planId !== plan.id ||
      record.status !== 'confirmed' || record.txId === null || record.confirmedAt === null ||
      record.submittedAt === null || !record.approvalIntentId ||
      record.actualFeeBaseUnits === null || !record.amountBaseUnits ||
      !record.contractAddress || !source || source.chain !== 'nile' || source.mode !== 'live' ||
      source.accessMethod !== 'rpc' || Date.parse(source.fetchedAt) < Date.parse(record.confirmedAt) ||
      opening.planId !== plan.id || opening.chain !== 'nile' || opening.source.chain !== 'nile' ||
      opening.source.mode !== 'live' || opening.walletAddress !== record.walletAddress ||
      opening.positionId !== `nile:${record.walletAddress}:${record.contractAddress}` ||
      Date.parse(opening.source.fetchedAt) > Date.parse(record.submittedAt) ||
      closing.planId !== plan.id || closing.chain !== 'nile' || closing.source.chain !== 'nile' ||
      closing.source.mode !== 'live' || closing.walletAddress !== record.walletAddress ||
      closing.positionId !== opening.positionId ||
      Date.parse(closing.source.fetchedAt) < Date.parse(record.confirmedAt) ||
      BigInt(closing.receiptBalanceBaseUnits) <= BigInt(opening.receiptBalanceBaseUnits) ||
      record.contractAddress !== plan.quote.marketAddress ||
      !sameToken(opening.receiptToken, plan.quote.receiptToken) ||
      !sameToken(opening.underlyingToken, plan.depositToken) ||
      !sameToken(closing.receiptToken, opening.receiptToken) ||
      !sameToken(closing.underlyingToken, opening.underlyingToken) ||
      !sameToken(plan.inputToken, plan.depositToken) ||
      BigInt(record.amountBaseUnits) <= 0n) return null;
  const scale = new Decimal(10).pow(plan.depositToken.decimals);
  // The solidified check time bounds the movement; the block inclusion time is not provided here.
  return positionFlowSchema.parse({
    id: `deposit:${record.txId}`, planId: plan.id, positionId: opening.positionId,
    walletAddress: record.walletAddress, chain: 'nile', txId: record.txId,
    kind: 'deposit', amount: new Decimal(record.amountBaseUnits).div(scale).toFixed(),
    asset: plan.depositToken,
    actualFeeInInputAsset: new Decimal(record.actualFeeBaseUnits).div(scale).toFixed(),
    occurredAt: record.confirmedAt, solidifiedAt: record.confirmedAt, source,
  });
}

/** Bind a revalidated deposit movement to the exact stored transaction before enabling recovery. */
export function matchesConfirmedNileDepositFlow(plan: Plan | null, record: ExecutionRecord | null,
  flow: PositionFlow | null): boolean {
  if (!plan || !record || !flow || !plan.quote?.receiptToken || !record.txId ||
      !record.approvalIntentId ||
      !record.contractAddress || !record.amountBaseUnits || record.actualFeeBaseUnits === null ||
      !record.confirmedAt || !record.confirmationSource) return false;
  const scale = new Decimal(10).pow(plan.inputToken.decimals);
  return plan.chain === 'nile' && plan.kind === 'justlend_jtrx' &&
    record.action === 'deposit' && record.chain === 'nile' && record.status === 'confirmed' &&
    record.planId === plan.id && record.contractAddress === plan.quote.marketAddress &&
    flow.id === `deposit:${record.txId}` && flow.txId === record.txId &&
    flow.kind === 'deposit' && flow.chain === 'nile' && flow.planId === plan.id &&
    flow.walletAddress === record.walletAddress &&
    flow.positionId === `nile:${record.walletAddress}:${record.contractAddress}` &&
    sameToken(flow.asset, plan.inputToken) &&
    flow.amount === new Decimal(record.amountBaseUnits).div(scale).toFixed() &&
    flow.actualFeeInInputAsset === new Decimal(record.actualFeeBaseUnits).div(scale).toFixed() &&
    flow.solidifiedAt === record.confirmedAt && flow.source.chain === 'nile' &&
    flow.source.mode === 'live' && flow.source.accessMethod === 'rpc';
}

function receivedTrxSun(receiptValue: unknown, txId: string, contractAddress: string,
  walletAddress: string): bigint | null {
  if (!receiptValue || typeof receiptValue !== 'object' || Array.isArray(receiptValue)) return null;
  const receipt = receiptValue as Record<string, unknown>;
  if (typeof receipt.id !== 'string' || receipt.id.toLowerCase() !== txId.toLowerCase() ||
      !receipt.receipt || typeof receipt.receipt !== 'object' || Array.isArray(receipt.receipt) ||
      (receipt.receipt as Record<string, unknown>).result !== 'SUCCESS' ||
      !Array.isArray(receipt.internal_transactions)) return null;

  const contract = normalizeTronAddress(contractAddress);
  const wallet = normalizeTronAddress(walletAddress);
  if (!contract || !wallet) return null;
  const seen = new Set<string>();
  let received = 0n;
  for (const raw of receipt.internal_transactions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const transfer = raw as Record<string, unknown>;
    if (typeof transfer.hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(transfer.hash) ||
        seen.has(transfer.hash.toLowerCase()) ||
        (transfer.rejected !== undefined && typeof transfer.rejected !== 'boolean')) return null;
    seen.add(transfer.hash.toLowerCase());
    if (transfer.rejected === true ||
        typeof transfer.caller_address !== 'string' ||
        typeof transfer.transferTo_address !== 'string' ||
        normalizeTronAddress(transfer.caller_address) !== contract ||
        normalizeTronAddress(transfer.transferTo_address) !== wallet) continue;
    if (!Array.isArray(transfer.callValueInfo)) return null;
    for (const rawValue of transfer.callValueInfo) {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
      const value = rawValue as Record<string, unknown>;
      if (value.tokenId !== undefined && value.tokenId !== '') continue;
      const amount = value.callValue;
      if ((typeof amount !== 'string' || !/^\d+$/.test(amount)) &&
          (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)) return null;
      received += BigInt(amount);
    }
  }
  return received > 0n ? received : null;
}

/** Record a redeem inflow only when the solidified receipt attributes native TRX to this wallet. */
export function confirmedNileWithdrawalFlow(rawPlan: Plan, rawRecord: ExecutionRecord,
  preview: NileWithdrawalPreview, rawObservation: Observation): PositionFlow | null {
  const plan = planSchema.parse(rawPlan);
  const record = executionRecordSchema.parse(rawRecord);
  const observation = observationSchema.parse(rawObservation);
  const source = record.confirmationSource;
  if (plan.chain !== 'nile' || plan.kind !== 'justlend_jtrx' || !plan.quote?.receiptToken ||
      record.action !== 'withdraw' || record.chain !== 'nile' || record.status !== 'confirmed' ||
      !record.txId || !record.confirmedAt || !record.submittedAt ||
      record.actualFeeBaseUnits === null || !source || source.chain !== 'nile' ||
      source.mode !== 'live' || source.accessMethod !== 'rpc' ||
      Date.parse(source.fetchedAt) < Date.parse(record.confirmedAt) ||
      record.planId !== plan.id || preview.planId !== plan.id ||
      record.previewId !== preview.id || record.walletAddress !== preview.walletAddress ||
      record.amountBaseUnits !== preview.amountBaseUnits ||
      record.contractAddress !== preview.contractAddress ||
      preview.contractAddress !== plan.quote.marketAddress ||
      observation.planId !== plan.id || observation.chain !== 'nile' ||
      observation.walletAddress !== record.walletAddress ||
      observation.positionId !== `nile:${record.walletAddress}:${record.contractAddress}` ||
      observation.source.chain !== 'nile' || observation.source.mode !== 'live' ||
      Date.parse(observation.source.fetchedAt) < Date.parse(record.confirmedAt) ||
      !sameToken(observation.receiptToken, plan.quote.receiptToken) ||
      !sameToken(observation.underlyingToken, plan.depositToken) ||
      !sameToken(plan.inputToken, plan.depositToken) ||
      BigInt(observation.receiptBalanceBaseUnits) >= BigInt(preview.state.jtrxBalanceRaw)) return null;
  const received = receivedTrxSun(record.receipt, record.txId, preview.contractAddress, record.walletAddress);
  if (received === null) return null;
  const scale = new Decimal(10).pow(plan.depositToken.decimals);
  return positionFlowSchema.parse({
    id: `withdraw:${record.txId}`, planId: plan.id, positionId: observation.positionId,
    walletAddress: record.walletAddress, chain: 'nile', txId: record.txId,
    kind: 'withdraw', amount: new Decimal(received.toString()).div(scale).toFixed(),
    asset: plan.depositToken,
    actualFeeInInputAsset: new Decimal(record.actualFeeBaseUnits).div(scale).toFixed(),
    occurredAt: record.confirmedAt, solidifiedAt: record.confirmedAt, source,
  });
}
