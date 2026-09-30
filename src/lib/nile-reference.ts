import DecimalBase from 'decimal.js';
import type { ExecutionRecord, PositionFlow } from '../../shared/schemas';
import { normalizeTronAddress } from '../../shared/tron-address';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });
const BLOCKS_PER_YEAR_AT_THREE_SECONDS = 10_512_000;
const MANTISSA = '1000000000000000000';
const TX_ID = /^[0-9a-f]{64}$/i;
const UINT = /^\d+$/;
const NONNEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;

/** A simple-interest illustration from a raw block rate, not a verified APY or trade quote. */
export function nileRateScenario(rawRate: string | null, invested: string, days: number): {
  aprPercent: string; grossInterest: string; rawRate: string;
} | null {
  if (rawRate === null || !UINT.test(rawRate) || !NONNEGATIVE_DECIMAL.test(invested)
    || !Number.isInteger(days) || days < 0 || days > 3650) return null;
  const annualRate = new Decimal(rawRate).times(BLOCKS_PER_YEAR_AT_THREE_SECONDS).div(MANTISSA);
  return {
    aprPercent: annualRate.times(100).toFixed(),
    grossInterest: new Decimal(invested).times(annualRate).times(days).div(365).toFixed(),
    rawRate,
  };
}

export interface NileRoundTripReference {
  deposit: PositionFlow;
  withdraw: PositionFlow;
  totalFees: string;
  netCashFlow: string;
}

function nativeTrx(flow: PositionFlow): boolean {
  return flow.asset.symbol === 'TRX' && flow.asset.address === null && flow.asset.decimals === 6;
}

function sun(value: unknown): bigint | null {
  if (typeof value === 'string' && UINT.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function receiptFor(record: ExecutionRecord): Record<string, unknown> | null {
  if (!record.receipt || typeof record.receipt !== 'object' || Array.isArray(record.receipt)) return null;
  return record.receipt as Record<string, unknown>;
}

function receivedTrxSun(receipt: Record<string, unknown>, contractAddress: string,
  walletAddress: string): bigint | null {
  if (!Array.isArray(receipt.internal_transactions)) return null;
  const contract = normalizeTronAddress(contractAddress);
  const wallet = normalizeTronAddress(walletAddress);
  if (!contract || !wallet) return null;
  let received = 0n;
  const seen = new Set<string>();
  for (const raw of receipt.internal_transactions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const transfer = raw as Record<string, unknown>;
    if (typeof transfer.hash !== 'string' || !TX_ID.test(transfer.hash)
      || seen.has(transfer.hash.toLowerCase())
      || (transfer.rejected !== undefined && typeof transfer.rejected !== 'boolean')) return null;
    seen.add(transfer.hash.toLowerCase());
    if (transfer.rejected === true ||
        typeof transfer.caller_address !== 'string' ||
        typeof transfer.transferTo_address !== 'string' ||
        normalizeTronAddress(transfer.caller_address) !== contract ||
        normalizeTronAddress(transfer.transferTo_address) !== wallet) continue;
    if (!Array.isArray(transfer.callValueInfo)) return null;
    for (const item of transfer.callValueInfo) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const value = item as Record<string, unknown>;
      if (value.tokenId !== undefined && value.tokenId !== '') continue;
      const amount = sun(value.callValue);
      if (amount === null) return null;
      received += amount;
    }
  }
  return received > 0n ? received : null;
}

function matchingRecord(flow: PositionFlow, records: ExecutionRecord[],
  account: string): ExecutionRecord | null {
  if (!TX_ID.test(flow.txId) || !nativeTrx(flow)
    || flow.chain !== 'nile' || flow.source.chain !== 'nile'
    || flow.source.mode !== 'live' || flow.source.accessMethod !== 'rpc'
    || normalizeTronAddress(flow.walletAddress) !== account
    || flow.actualFeeInInputAsset === null) return null;
  const matches = records.filter(record => record.txId?.toLowerCase() === flow.txId.toLowerCase());
  if (matches.length !== 1) return null;
  const record = matches[0];
  const contract = record.contractAddress && normalizeTronAddress(record.contractAddress);
  const receipt = receiptFor(record);
  const fee = sun(record.actualFeeBaseUnits);
  const receiptFee = receipt && sun(receipt.fee);
  if (!contract || !receipt || fee === null || receiptFee !== fee
    || record.chain !== 'nile' || record.status !== 'confirmed' ||
      record.action !== flow.kind || record.planId !== flow.planId ||
      normalizeTronAddress(record.walletAddress) !== account ||
      flow.positionId !== `nile:${account}:${contract}` ||
      !record.confirmedAt || !record.submittedAt ||
      !record.approvalIntentId || !TX_ID.test(record.approvalIntentId) ||
      Date.parse(record.submittedAt) > Date.parse(record.confirmedAt) ||
      flow.occurredAt !== record.confirmedAt || flow.solidifiedAt !== record.confirmedAt ||
      !record.confirmationSource || record.confirmationSource.chain !== 'nile' ||
      record.confirmationSource.mode !== 'live' ||
      record.confirmationSource.accessMethod !== 'rpc' ||
      record.confirmationSource.fetchedAt !== flow.source.fetchedAt ||
      record.confirmationSource.sourceUrl !== flow.source.sourceUrl ||
      Date.parse(flow.source.fetchedAt) < Date.parse(record.confirmedAt) ||
      typeof receipt.id !== 'string' || receipt.id.toLowerCase() !== flow.txId.toLowerCase() ||
      !receipt.receipt || typeof receipt.receipt !== 'object' || Array.isArray(receipt.receipt) ||
      (receipt.receipt as Record<string, unknown>).result !== 'SUCCESS' ||
      !new Decimal(flow.actualFeeInInputAsset).eq(new Decimal(fee.toString()).div(1_000_000))) return null;
  if (flow.kind === 'deposit') {
    const amount = sun(record.amountBaseUnits);
    if (amount === null || amount <= 0n ||
        !new Decimal(flow.amount).eq(new Decimal(amount.toString()).div(1_000_000))) return null;
  } else if (flow.kind === 'withdraw') {
    const received = receivedTrxSun(receipt, contract, account);
    if (received === null ||
        !new Decimal(flow.amount).eq(new Decimal(received.toString()).div(1_000_000))) return null;
  } else return null;
  return record;
}

/** Historical browser evidence only; never use this as a future fee estimate or recommendation. */
export function findNileRoundTripReference(flows: PositionFlow[], records: ExecutionRecord[],
  walletAddress: string): NileRoundTripReference | null {
  const account = normalizeTronAddress(walletAddress);
  if (!account) return null;
  const groups = new Map<string, PositionFlow[]>();
  for (const flow of flows) {
    if (flow.chain !== 'nile' || normalizeTronAddress(flow.walletAddress) !== account) continue;
    const key = `${flow.planId}\u0000${flow.positionId}`;
    groups.set(key, [...(groups.get(key) ?? []), flow]);
  }
  const references: NileRoundTripReference[] = [];
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const deposit = group.find(flow => flow.kind === 'deposit');
    const withdraw = group.find(flow => flow.kind === 'withdraw');
    if (!deposit || !withdraw || deposit.txId.toLowerCase() === withdraw.txId.toLowerCase() ||
        Date.parse(deposit.solidifiedAt) >= Date.parse(withdraw.occurredAt)) continue;
    const depositRecord = matchingRecord(deposit, records, account);
    const withdrawRecord = matchingRecord(withdraw, records, account);
    if (!depositRecord || !withdrawRecord ||
        normalizeTronAddress(depositRecord.contractAddress!) !==
          normalizeTronAddress(withdrawRecord.contractAddress!) ||
        records.filter(record => record.chain === 'nile' && record.status === 'confirmed' &&
          record.planId === deposit.planId && normalizeTronAddress(record.walletAddress) === account &&
          normalizeTronAddress(record.contractAddress ?? '') ===
            normalizeTronAddress(depositRecord.contractAddress!)).length !== 2) continue;
    const fees = new Decimal(deposit.actualFeeInInputAsset!).plus(withdraw.actualFeeInInputAsset!);
    references.push({ deposit, withdraw, totalFees: fees.toFixed(),
      netCashFlow: new Decimal(withdraw.amount).minus(deposit.amount).minus(fees).toFixed() });
  }
  references.sort((left, right) => Date.parse(right.withdraw.solidifiedAt) - Date.parse(left.withdraw.solidifiedAt));
  return references[0] ?? null;
}
