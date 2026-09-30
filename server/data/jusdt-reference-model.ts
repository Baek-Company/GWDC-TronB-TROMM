import { bytesToHex } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { TronWeb, utils as tronUtils } from 'tronweb';
import { actionCostSampleSetSchema, type ActionCostSampleSet, type CostEvidence,
  type Source } from '../../shared/schemas';

const MAX_REFERENCE_AGE_MS = 30 * 86_400_000;
const MAX_SAMPLES = 20;
type Action = CostEvidence['action'];

export type ReferenceCandidate = {
  action: Action;
  contractAddress: string;
  selector: string;
  spenderAddress: string | null;
  transaction: unknown;
  solidifiedReceipt: unknown;
  currentCodeIdentity: string;
  historicalCodeIdentity: string | null;
  source: Source;
  now: Date;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function addressEqual(a: unknown, b: string): boolean {
  const address = typeof a === 'string' && /^[0-9a-fA-F]{40}$/.test(a) ? `41${a}` : a;
  return typeof address === 'string' && TronWeb.isAddress(address) && TronWeb.isAddress(b)
    && TronWeb.address.toHex(address).toLowerCase() === TronWeb.address.toHex(b).toLowerCase();
}
function firstWord(value: unknown): bigint | null {
  return typeof value === 'string' && /^[0-9a-fA-F]{64,}$/.test(value)
    ? BigInt(`0x${value.slice(0, 64)}`) : null;
}
function topic(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature)));
}
function selector(signature: string): string { return topic(signature).slice(0, 8); }
function eventMatches(action: Action, logs: unknown, contractAddress: string, owner: string,
  spender: string | null, amount: bigint): boolean {
  if (!Array.isArray(logs)) return false;
  const signature = action === 'approve' || action === 'approve_zero'
    ? 'Approval(address,address,uint256)'
    : action === 'mint' ? 'Mint(address,uint256,uint256)' : 'Redeem(address,uint256,uint256)';
  const expectedTopic = topic(signature);
  for (const raw of logs) {
    const log = object(raw);
    if (!log || !addressEqual(log.address, contractAddress) || !Array.isArray(log.topics)
      || String(log.topics[0]).toLowerCase() !== expectedTopic) continue;
    const data = typeof log.data === 'string' && /^[0-9a-fA-F]+$/.test(log.data) ? log.data : '';
    if (action === 'approve' || action === 'approve_zero') {
      if (!spender || log.topics.length !== 3 || data.length < 64
        || firstWord(data) !== amount) continue;
      const ownerTopic = String(log.topics[1]);
      const spenderTopic = String(log.topics[2]);
      if (ownerTopic.length !== 64 || spenderTopic.length !== 64) continue;
      if (ownerTopic.slice(-40).toLowerCase() === TronWeb.address.toHex(owner).slice(2).toLowerCase()
        && spenderTopic.slice(-40).toLowerCase() === TronWeb.address.toHex(spender).slice(2).toLowerCase()) return true;
    } else {
      // Compound/JustLend Mint and Redeem events contain account, token amount,
      // and underlying amount. Require an exact raw underlying amount match.
      if (log.topics.length !== 1 || data.length < 192) continue;
      const eventOwner = data.slice(24, 64).toLowerCase();
      // Both Mint(minter,mintAmount,mintTokens) and
      // Redeem(redeemer,redeemAmount,redeemTokens) put the underlying amount
      // in the second ABI word, after the non-indexed account address.
      const eventAmount = firstWord(data.slice(64, 128));
      if (eventOwner === TronWeb.address.toHex(owner).slice(2).toLowerCase()
        && eventAmount === amount) return true;
    }
  }
  return false;
}

/** Returns null unless body, solidified receipt, event and historical code identity agree. */
export function verifyReferenceCandidate(input: ReferenceCandidate): ActionCostSampleSet['samples'][number] | null {
  const tx = object(input.transaction);
  const info = object(input.solidifiedReceipt);
  if (!tx || !info || !input.currentCodeIdentity || input.currentCodeIdentity !== input.historicalCodeIdentity
    || input.source.chain !== 'mainnet' || input.source.mode !== 'live'
    || typeof tx.txID !== 'string' || !/^[0-9a-fA-F]{64}$/.test(tx.txID)
    || info.id !== tx.txID) return null;
  const receipt = object(info.receipt);
  const txRet = Array.isArray(tx.ret) ? object(tx.ret[0]) : null;
  const contracts = object(tx.raw_data)?.contract;
  const call = Array.isArray(contracts) && contracts.length === 1 ? object(contracts[0]) : null;
  const value = object(object(call?.parameter)?.value);
  if (receipt?.result !== 'SUCCESS' || txRet?.contractRet !== 'SUCCESS'
    || call?.type !== 'TriggerSmartContract' || !value
    || !addressEqual(value.contract_address, input.contractAddress)
    || !addressEqual(value.owner_address, String(value.owner_address))) return null;
  const owner = String(value.owner_address);
  const data = value.data;
  const needsApproval = input.action === 'approve' || input.action === 'approve_zero';
  const expectedSelector = needsApproval ? 'approve(address,uint256)'
    : input.action === 'mint' ? 'mint(uint256)' : 'redeemUnderlying(uint256)';
  if (input.selector !== expectedSelector || typeof data !== 'string'
    || !/^[0-9a-fA-F]+$/.test(data) || data.slice(0, 8).toLowerCase() !== selector(expectedSelector)
    || data.length !== (needsApproval ? 8 + 128 : 8 + 64)) return null;
  const amount = firstWord(needsApproval ? data.slice(72, 136) : data.slice(8, 72));
  if (amount === null || (input.action === 'approve_zero' ? amount !== 0n : amount === 0n)) return null;
  if (needsApproval && (!input.spenderAddress || !addressEqual(`41${data.slice(32, 72)}`, input.spenderAddress))) return null;
  const returns = Array.isArray(info.contractResult) ? info.contractResult : null;
  if (!returns || firstWord(returns[0]) !== (needsApproval ? 1n : 0n)
    || !eventMatches(input.action, info.log, input.contractAddress, owner, input.spenderAddress, amount)) return null;
  const energy = receipt.energy_usage_total;
  if (!((typeof energy === 'string' && /^\d+$/.test(energy))
    || (typeof energy === 'number' && Number.isSafeInteger(energy) && energy > 0))
    || BigInt(energy) === 0n) return null;
  const blockTime = info.blockTimeStamp;
  if (typeof blockTime !== 'number' || !Number.isSafeInteger(blockTime)
    || input.now.getTime() - blockTime < 0
    || input.now.getTime() - blockTime > MAX_REFERENCE_AGE_MS) return null;
  try {
    if (!tronUtils.transaction.txCheck(tx)) return null;
    const signatures = tx.signature;
    if (!Array.isArray(signatures) || signatures.length === 0
      || signatures.some(signature => typeof signature !== 'string' || !/^[0-9a-fA-F]{130}$/.test(signature))) return null;
    const pb = tronUtils.transaction.txJsonToPb(tx);
    for (const signature of signatures) pb.addSignature(Uint8Array.from(Buffer.from(signature, 'hex')));
    const signedBytes = pb.serializeBinary().length;
    if (!Number.isSafeInteger(signedBytes) || signedBytes <= 0) return null;
    return { basis: 'reference_model', amountRaw: amount.toString(), energyUnits: BigInt(energy).toString(),
      signedBytes: String(signedBytes), txId: tx.txID,
      source: { ...input.source, sourceUpdatedAt: new Date(blockTime).toISOString() } };
  } catch { return null; }
}

/** A model exists only when at least five distinct, fully verified receipts exist. */
export function buildReferenceModel(input: {
  action: Action; contractAddress: string; selector: string; currentCodeIdentity: string;
  candidates: ReferenceCandidate[]; now: Date;
}): ActionCostSampleSet | null {
  const unique = new Map<string, ActionCostSampleSet['samples'][number]>();
  for (const candidate of input.candidates.slice(0, MAX_SAMPLES)) {
    if (candidate.action !== input.action || !addressEqual(candidate.contractAddress, input.contractAddress)
      || candidate.selector !== input.selector || candidate.currentCodeIdentity !== input.currentCodeIdentity) continue;
    const sample = verifyReferenceCandidate(candidate);
    if (sample?.txId) unique.set(sample.txId, sample);
  }
  if (unique.size < 5) return null;
  const samples = [...unique.values()];
  const version = bytesToHex(keccak_256(new TextEncoder().encode(JSON.stringify([
    input.action, input.contractAddress, input.selector, input.currentCodeIdentity,
    samples.map(sample => [sample.txId, sample.amountRaw, sample.energyUnits, sample.signedBytes]),
  ]))));
  return actionCostSampleSetSchema.parse({ action: input.action, contractAddress: input.contractAddress,
    selector: input.selector, samples, codeIdentity: input.currentCodeIdentity,
    modelVersion: version, validUntil: new Date(input.now.getTime() + 10 * 60_000).toISOString() });
}
