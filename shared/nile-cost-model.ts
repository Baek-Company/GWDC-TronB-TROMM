import { z } from 'zod';
import { normalizeTronAddress } from './tron-address';
import { instantSchema, positiveUint256StringSchema, sourceSchema, uint256StringSchema } from './schemas';

const addressSchema = z.string().refine(value => normalizeTronAddress(value) !== null);
const hashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/);
const nileSourceSchema = sourceSchema.refine(source => source.chain === 'nile' && source.mode === 'live');

/** A reference is deliberately separate from a wallet-specific withdrawal preview. */
export const nileRedeemReferenceSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'), basis: z.enum(['representative_simulation', 'historical_reference']),
    chain: z.literal('nile'), contractAddress: addressSchema, contractCodeHash: hashSchema,
    jtrxAmountRaw: positiveUint256StringSchema, representativeAddress: addressSchema.nullable(),
    representativeBalanceRaw: uint256StringSchema.nullable(), expectedUnderlyingSun: positiveUint256StringSchema.nullable(),
    energyUnits: positiveUint256StringSchema, bandwidthBytes: positiveUint256StringSchema,
    energyPriceSun: positiveUint256StringSchema, bandwidthPriceSun: positiveUint256StringSchema,
    // Both scenarios assume zero free resources. Stress is a 2x *current price*
    // scenario, not a maximum future fee or an execution approval.
    estimatedFeeSun: positiveUint256StringSchema, stressFeeSun: positiveUint256StringSchema,
    referenceTxIds: z.array(hashSchema).max(20), source: nileSourceSchema,
    validUntil: instantSchema, reason: z.null(), assumptions: z.array(z.string().min(1)).min(1),
  }).strict().superRefine((value, ctx) => {
    if (value.basis === 'representative_simulation' &&
      (value.representativeAddress === null || value.representativeBalanceRaw === null || value.referenceTxIds.length)) {
      ctx.addIssue({ code: 'custom', message: '기준 계정 모의 실행에는 계정·잔고가 필요하고 과거 txID는 사용할 수 없습니다.' });
    }
    if (value.basis === 'historical_reference' &&
      (value.representativeAddress !== null || value.representativeBalanceRaw !== null || value.referenceTxIds.length < 6)) {
      ctx.addIssue({ code: 'custom', message: '과거 모델에는 독립적인 확정 거래 6건이 필요합니다.' });
    }
    if (Date.parse(value.validUntil) <= Date.parse(value.source.fetchedAt)
      || BigInt(value.stressFeeSun) < BigInt(value.estimatedFeeSun)) {
      ctx.addIssue({ code: 'custom', message: '수수료·유효기간이 근거와 맞지 않습니다.' });
    }
  }),
  z.object({
    status: z.literal('unknown'), basis: z.literal('unknown'), chain: z.literal('nile'),
    contractAddress: addressSchema.optional(), jtrxAmountRaw: uint256StringSchema.optional(),
    estimatedFeeSun: z.null(), stressFeeSun: z.null(), energyUnits: z.null(),
    bandwidthBytes: z.null(), source: nileSourceSchema, validUntil: z.null(),
    reason: z.string().min(1),
  }).strict(),
]);
export type NileRedeemReference = z.infer<typeof nileRedeemReferenceSchema>;

export function unknownNileRedeemReference(input: {
  contractAddress: string | null; jtrxAmountRaw: string | null;
  source: z.infer<typeof sourceSchema>; reason: string;
}): NileRedeemReference {
  return nileRedeemReferenceSchema.parse({ status: 'unknown', basis: 'unknown', chain: 'nile',
    ...(input.contractAddress ? { contractAddress: input.contractAddress } : {}),
    ...(input.jtrxAmountRaw ? { jtrxAmountRaw: input.jtrxAmountRaw } : {}),
    estimatedFeeSun: null, stressFeeSun: null, energyUnits: null, bandwidthBytes: null,
    source: input.source, validUntil: null, reason: input.reason });
}

export function quoteNileRedeemScenario(input: {
  basis: 'representative_simulation' | 'historical_reference';
  contractAddress: string; contractCodeHash: string; jtrxAmountRaw: string;
  representativeAddress: string | null; representativeBalanceRaw: string | null;
  expectedUnderlyingSun: string | null; energyUnits: string; bandwidthBytes: string;
  energyPriceSun: string; bandwidthPriceSun: string; referenceTxIds: string[];
  source: z.infer<typeof sourceSchema>; validUntil: string; assumptions: string[];
}): NileRedeemReference {
  const energy = BigInt(input.energyUnits);
  const bytes = BigInt(input.bandwidthBytes);
  const energyPrice = BigInt(input.energyPriceSun);
  const bandwidthPrice = BigInt(input.bandwidthPriceSun);
  const currentPriceFee = energy * energyPrice + bytes * bandwidthPrice;
  return nileRedeemReferenceSchema.parse({ ...input, status: 'ready', chain: 'nile', reason: null,
    estimatedFeeSun: currentPriceFee.toString(), stressFeeSun: (currentPriceFee * 2n).toString() });
}

// The model cannot create evidence. Its caller must independently verify each
// solidified receipt and the implementation code at that receipt's block.
export const nileHistoricalRedeemSampleSchema = z.object({
  chain: z.literal('nile'), action: z.literal('redeem(uint256)'),
  contractAddress: addressSchema, txId: hashSchema, jtrxAmountRaw: positiveUint256StringSchema,
  energyUsageTotal: positiveUint256StringSchema, signedBytes: positiveUint256StringSchema,
  actualFeeSun: uint256StringSchema, energyFeeSun: uint256StringSchema,
  netFeeSun: uint256StringSchema, blockNumber: positiveUint256StringSchema,
  blockAt: instantSchema, receiptSource: nileSourceSchema,
  implementationProof: z.object({
    kind: z.literal('historical_block_code'), blockNumber: positiveUint256StringSchema,
    implementationAddressAtExecution: addressSchema,
    implementationAddressNow: addressSchema,
    codeHashAtExecution: hashSchema, codeHashNow: hashSchema,
    source: nileSourceSchema,
  }).strict(),
}).strict().superRefine((sample, ctx) => {
  const proof = sample.implementationProof;
  if (proof.blockNumber !== sample.blockNumber
    || proof.implementationAddressAtExecution !== proof.implementationAddressNow
    || proof.codeHashAtExecution.toLowerCase() !== proof.codeHashNow.toLowerCase()
    || proof.source.sourceUrl === sample.receiptSource.sourceUrl
    || Date.parse(sample.blockAt) > Date.parse(sample.receiptSource.fetchedAt)
    || Date.parse(sample.blockAt) > Date.parse(proof.source.fetchedAt)) {
    ctx.addIssue({ code: 'custom', message: '확정 영수증과 독립적인 당시 실행 코드 증거가 일치하지 않습니다.' });
  }
  if (BigInt(sample.actualFeeSun) !== BigInt(sample.energyFeeSun) + BigInt(sample.netFeeSun)) {
    ctx.addIssue({ code: 'custom', message: '영수증 실제 수수료를 Energy와 Bandwidth 비용으로 설명할 수 없습니다.' });
  }
});
export type NileHistoricalRedeemSample = z.infer<typeof nileHistoricalRedeemSampleSchema>;

/** Six distinct samples: five calibration receipts and one later holdout. */
export function quoteNileHistoricalRedeem(input: {
  contractAddress: string; contractCodeHash: string; jtrxAmountRaw: string;
  currentImplementationAddress: string; currentImplementationCodeHash: string;
  energyPriceSun: string; bandwidthPriceSun: string;
  samples: NileHistoricalRedeemSample[]; source: z.infer<typeof sourceSchema>;
  validUntil: string;
}): NileRedeemReference {
  const unknown = (reason: string) => unknownNileRedeemReference({
    contractAddress: input.contractAddress, jtrxAmountRaw: input.jtrxAmountRaw,
    source: input.source, reason,
  });
  try {
    if (normalizeTronAddress(input.contractAddress) === null
      || !/^[0-9a-fA-F]{64}$/.test(input.contractCodeHash)
      || normalizeTronAddress(input.currentImplementationAddress) === null
      || !/^[0-9a-fA-F]{64}$/.test(input.currentImplementationCodeHash)
      || !positiveUint256StringSchema.safeParse(input.jtrxAmountRaw).success
      || !positiveUint256StringSchema.safeParse(input.energyPriceSun).success
      || !positiveUint256StringSchema.safeParse(input.bandwidthPriceSun).success
      || input.source.chain !== 'nile' || input.source.mode !== 'live'
      || Date.parse(input.validUntil) <= Date.parse(input.source.fetchedAt)) {
      return unknown('Nile 비용 모델 입력·현재 단가 또는 유효기간을 검증할 수 없습니다.');
    }
    const target = BigInt(input.jtrxAmountRaw);
    const now = Date.parse(input.source.fetchedAt);
    const matching = input.samples.flatMap(raw => {
      const parsed = nileHistoricalRedeemSampleSchema.safeParse(raw);
      if (!parsed.success) return [];
      const sample = parsed.data;
      const age = now - Date.parse(sample.blockAt);
      if (sample.contractAddress !== input.contractAddress || age < 0 || age > 30 * 86_400_000
        || BigInt(sample.jtrxAmountRaw) * 2n < target || BigInt(sample.jtrxAmountRaw) > target * 2n
        || normalizeTronAddress(sample.implementationProof.implementationAddressNow)
          !== normalizeTronAddress(input.currentImplementationAddress)
        || sample.implementationProof.codeHashNow.toLowerCase()
          !== input.currentImplementationCodeHash.toLowerCase()) return [];
      return [sample];
    });
    const unique = [...new Map(matching.map(sample => [sample.txId.toLowerCase(), sample])).values()]
      .sort((a, b) => Date.parse(a.blockAt) - Date.parse(b.blockAt));
    if (unique.length < 6) return unknown('같은 Nile 실행 코드·수량 구간의 독립된 확정 환매 표본 5건과 보류 검증 1건이 없습니다.');
    const calibration = unique.slice(0, 5);
    const holdout = unique[5];
    const energy = calibration.reduce((max, item) => BigInt(item.energyUsageTotal) > max ? BigInt(item.energyUsageTotal) : max, 0n);
    const bytes = calibration.reduce((max, item) => BigInt(item.signedBytes) > max ? BigInt(item.signedBytes) : max, 0n);
    if (BigInt(holdout.energyUsageTotal) > energy || BigInt(holdout.signedBytes) > bytes) {
      return unknown('보류 검증 거래가 보정 표본의 Energy 또는 Bandwidth 범위를 초과했습니다.');
    }
    return quoteNileRedeemScenario({ basis: 'historical_reference', contractAddress: input.contractAddress,
      contractCodeHash: input.contractCodeHash, jtrxAmountRaw: input.jtrxAmountRaw,
      representativeAddress: null, representativeBalanceRaw: null, expectedUnderlyingSun: null,
      energyUnits: energy.toString(), bandwidthBytes: bytes.toString(),
      energyPriceSun: input.energyPriceSun, bandwidthPriceSun: input.bandwidthPriceSun,
      referenceTxIds: unique.slice(0, 6).map(item => item.txId), source: input.source,
      validUntil: input.validUntil,
      assumptions: ['30일 이내 동일 실행 코드·수량 구간의 확정 환매 5건과 보류 검증 1건',
        '미래 무료 자원 0, 현재 자원 단가 및 단가 2배 스트레스 시나리오',
        '미래 Energy 사용량·정책 변동은 상한으로 보증하지 않음'],
    });
  } catch {
    return unknown('Nile 과거 환매 표본과 현재 단가를 검증할 수 없습니다.');
  }
}
