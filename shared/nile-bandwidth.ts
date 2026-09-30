import { utils } from 'tronweb';

const SIGNATURE_HEX = /^(?:0x)?[0-9a-f]{130}$/i;
const RESULT_OVERHEAD_BYTES = 64;

/**
 * Serialize the signed TRON transaction with the installed TronWeb protobuf writer.
 * TRON includes the transaction result in Bandwidth; it is not present before broadcast.
 * https://developers.tron.network/docs/faq#how-do-i-calculate-bandwidth-and-energy-for-a-contract-call-or-deployment
 */
export function signedNileBandwidthBytes(value: unknown): bigint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Nile 서명 거래 원문이 필요합니다.');
  }
  const transaction = value as Record<string, unknown>;
  if (!Array.isArray(transaction.signature) || transaction.signature.length !== 1 ||
      !SIGNATURE_HEX.test(transaction.signature[0])) {
    throw new Error('Nile 거래의 단일 서명 크기를 확인할 수 없습니다.');
  }
  try {
    const pb = utils.transaction.txJsonToPb(transaction);
    const signature = String(transaction.signature[0]).replace(/^0x/i, '');
    const bytes = Uint8Array.from({ length: 65 }, (_, index) =>
      Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16));
    pb.addSignature(bytes);
    const size = pb.serializeBinary().length + RESULT_OVERHEAD_BYTES;
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('invalid size');
    return BigInt(size);
  } catch {
    throw new Error('Nile 서명 거래의 protobuf 크기를 확인할 수 없습니다.');
  }
}

type NileBandwidthBudget = {
  estimatedBandwidthBytes?: string; bandwidthPriceSun: string;
  bandwidthFeeUpperBoundSun: string; feeLimitSun: string; maxFeeSun: string;
};

export function assertNileBandwidthBudgetEvidence(state: NileBandwidthBudget): void {
  const unsigned = (input: unknown): input is string =>
    typeof input === 'string' && /^\d+$/.test(input);
  const estimatedBytes = state.estimatedBandwidthBytes;
  if (!unsigned(estimatedBytes) || !unsigned(state.bandwidthPriceSun) ||
      !unsigned(state.bandwidthFeeUpperBoundSun) || !unsigned(state.feeLimitSun) ||
      !unsigned(state.maxFeeSun) || BigInt(estimatedBytes) === 0n ||
      BigInt(state.bandwidthPriceSun) === 0n ||
      BigInt(estimatedBytes) * BigInt(state.bandwidthPriceSun) !==
        BigInt(state.bandwidthFeeUpperBoundSun) ||
      BigInt(state.feeLimitSun) + BigInt(state.bandwidthFeeUpperBoundSun) !==
        BigInt(state.maxFeeSun)) {
    throw new Error('Nile 환매 미리보기의 Bandwidth 예산 근거가 없습니다. 새 미리보기를 발급해 주세요.');
  }
}

export function assertNileWithdrawalBandwidthBudget(value: unknown, state: NileBandwidthBudget): void {
  assertNileBandwidthBudgetEvidence(state);
  const allowedBytes = state.estimatedBandwidthBytes;
  if (allowedBytes === undefined) throw new Error('Nile 환매 Bandwidth 예산이 없습니다.');
  const signedBytes = signedNileBandwidthBytes(value);
  if (signedBytes > BigInt(allowedBytes)) {
    throw new Error('서명된 Nile 환매 거래 크기가 미리보기 Bandwidth 예산을 초과했습니다. 새 미리보기를 발급해 주세요.');
  }
}
