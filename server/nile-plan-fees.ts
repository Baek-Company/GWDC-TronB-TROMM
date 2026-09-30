import { toBaseUnits } from '../shared/markets';
import { calculateLiquidity } from '../shared/planning';
import type { Plan, Source, UserNeeds } from '../shared/schemas';
import { normalizeTronAddress } from '../shared/tron-address';
import type { NileDepositState } from './transactions';

const UINT = /^\d+$/;
const EXCHANGE_SCALE = 10n ** 18n;
const DEPOSIT_QUOTE_AGE_MS = 180_000;

export type NileFeeScenario = {
  planId: string;
  status: 'reference_scenario' | 'partial' | 'unknown';
  basis: 'representative_simulation' | 'historical_reference' | 'unknown';
  referenceAccountAddress: string | null;
  referenceTxIds: string[];
  amountSun: string;
  jTokenAmountRaw: string | null;
  depositFeeSun: string | null;
  estimatedRedeemFeeSun: string | null;
  stressRedeemFeeSun: string | null;
  estimatedRoundTripFeeSun: string | null;
  stressRoundTripFeeSun: string | null;
  feeReserveSun: string | null;
  postReserveInvestableSun: string | null;
  reserveStatus: 'ready' | 'insufficient' | 'unknown';
  /** Cost-only sizing result. It is never an approved investment or a verified profit quote. */
  economicDepositSun: string | null;
  economicFeeReserveSun: string | null;
  economicSizingStatus: 'ready' | 'insufficient' | 'unknown';
  sourceUrl: string | null;
  fetchedAt: string | null;
  validUntil: string | null;
  reason: string | null;
  assumptions: string[];
};

export type NileRedeemReferenceLike = {
  status: 'ready' | 'unknown';
  basis: 'representative_simulation' | 'historical_reference' | 'unknown';
  estimatedFeeSun: string | null;
  stressFeeSun: string | null;
  source: Source | null;
  validUntil: string | null;
  reason: string | null;
  contractAddress?: string;
  jtrxAmountRaw?: string;
  representativeAddress?: string | null;
  referenceTxIds?: string[];
  assumptions?: string[];
};

export type NileFeeReaders = {
  readDepositState: (input: { address: string; amountSun: string; contractAddress: string }) => Promise<NileDepositState>;
  readRedeemReference: (input: { jtrxAmountRaw: string; contractAddress: string; excludeWalletAddress: string }) => Promise<NileRedeemReferenceLike>;
  now?: () => number;
};

function validUint(value: unknown): value is string {
  return typeof value === 'string' && UINT.test(value);
}

function validSource(source: Source | null | undefined, now: number, maxAgeMs: number): source is Source {
  if (!source || source.chain !== 'nile' || source.mode !== 'live') return false;
  const fetched = Date.parse(source.fetchedAt);
  return Number.isFinite(fetched) && fetched <= now + 60_000 && now - fetched <= maxAgeMs
    && /^https:\/\//.test(source.sourceUrl);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function unknownScenario(plan: Plan, reason: string): NileFeeScenario {
  return {
    planId: plan.id, status: 'unknown', basis: 'unknown',
    referenceAccountAddress: null, referenceTxIds: [],
    amountSun: toBaseUnits(plan.allocation.invested, 6), jTokenAmountRaw: null,
    depositFeeSun: null, estimatedRedeemFeeSun: null, stressRedeemFeeSun: null,
    estimatedRoundTripFeeSun: null, stressRoundTripFeeSun: null, feeReserveSun: null,
    postReserveInvestableSun: null, reserveStatus: 'unknown', sourceUrl: null, fetchedAt: null,
    economicDepositSun: null, economicFeeReserveSun: null, economicSizingStatus: 'unknown',
    validUntil: null, reason, assumptions: [],
  };
}

/** Reference economics only. Never modifies Plan.roundTripCost, Plan.netYield, or execution eligibility. */
export async function readNilePlanFeeScenarios(needs: UserNeeds, plans: readonly Plan[], walletAddress: string,
  exchangeRateRaw: string | null, readers: NileFeeReaders): Promise<NileFeeScenario[]> {
  if (needs.chain !== 'nile' || needs.asset.symbol !== 'TRX') throw new Error('Nile TRX 조건이 필요합니다.');
  const now = (readers.now ?? Date.now)();
  const investableSun = BigInt(toBaseUnits(calculateLiquidity(needs).investableAmount, 6));
  const memo = new Map<string, Promise<NileFeeScenario>>();

  async function readAmount(plan: Plan, sizedAmountSun?: string): Promise<NileFeeScenario> {
    const contractAddress = plan.quote?.marketAddress;
    if (plan.chain !== 'nile' || plan.kind !== 'justlend_jtrx' || !contractAddress ||
        plan.quote?.source.chain !== 'nile' || !validSource(plan.quote.source, now, 15 * 60_000)) {
      return unknownScenario(plan, '같은 Nile jTRX의 최신 상품 근거가 없습니다.');
    }
    const amountSun = sizedAmountSun ?? toBaseUnits(plan.allocation.invested, 6);
    if (!validUint(amountSun) || BigInt(amountSun) === 0n) {
      return unknownScenario(plan, '운용액이 0 TRX라 환매 금액을 계산하지 않았습니다.');
    }
    const reasons: string[] = [];
    let deposit: NileDepositState | null = null;
    try {
      const state = await readers.readDepositState({ address: walletAddress, amountSun, contractAddress });
      if (state.chain !== 'nile' || state.contractAddress !== contractAddress || state.amountSun !== amountSun ||
          !validUint(state.estimatedFeeSun) || !validUint(state.maxFeeSun) ||
          !validUint(state.exchangeRateRaw) || BigInt(state.exchangeRateRaw) === 0n ||
          !validSource(state.source, now, DEPOSIT_QUOTE_AGE_MS)) {
        throw new Error('예치 비용·환율의 계정, 수량 또는 조회 시각이 일치하지 않습니다.');
      }
      deposit = state;
    } catch (error) { reasons.push(`현재 예치 비용: ${errorText(error, '조회 실패')}`); }

    const rate = deposit?.exchangeRateRaw ?? exchangeRateRaw;
    const rateSourceValid = deposit !== null || validSource(plan.quote.source, now, 15 * 60_000);
    const jTokenAmountRaw = rateSourceValid && validUint(rate) && BigInt(rate) > 0n
      ? (BigInt(amountSun) * EXCHANGE_SCALE / BigInt(rate)).toString() : null;
    let reference: NileRedeemReferenceLike | null = null;
    if (jTokenAmountRaw !== null && BigInt(jTokenAmountRaw) > 0n) {
      try {
        const result = await readers.readRedeemReference({ jtrxAmountRaw: jTokenAmountRaw,
          contractAddress, excludeWalletAddress: walletAddress });
        if (result.contractAddress !== contractAddress || result.jtrxAmountRaw !== jTokenAmountRaw) {
          throw new Error('기준 환매 비용의 계약 또는 수량이 현재 후보와 다릅니다.');
        }
        const distinctHistoricalTxIds = result.referenceTxIds
          && new Set(result.referenceTxIds.map(id => id.toLowerCase())).size >= 6
          && result.referenceTxIds.every(id => /^[a-f\d]{64}$/i.test(id));
        const validBasis = result.basis === 'representative_simulation'
          ? !!result.representativeAddress
            && normalizeTronAddress(result.representativeAddress) !== null
            && normalizeTronAddress(result.representativeAddress) !== normalizeTronAddress(walletAddress)
          : result.basis === 'historical_reference' && distinctHistoricalTxIds;
        if (result.status === 'ready' && result.basis !== 'unknown' &&
            validBasis &&
            validUint(result.estimatedFeeSun) && validUint(result.stressFeeSun) &&
            validSource(result.source, now, 10 * 60_000) && result.validUntil !== null &&
            Number.isFinite(Date.parse(result.validUntil)) && Date.parse(result.validUntil) > now &&
            result.contractAddress === contractAddress && result.jtrxAmountRaw === jTokenAmountRaw) {
          reference = result;
        } else reasons.push(result.reason || '같은 금액의 기준 계정 또는 과거 거래 근거가 검증되지 않았습니다.');
      } catch (error) { reasons.push(`환매 참고 비용: ${errorText(error, '조회 실패')}`); }
    } else reasons.push('현재 환율로 양수 jTRX 예상 수량을 계산할 수 없습니다.');

    const depositFeeSun = deposit?.estimatedFeeSun ?? null;
    const estimatedRedeemFeeSun = reference?.estimatedFeeSun ?? null;
    const stressRedeemFeeSun = reference?.stressFeeSun ?? null;
    const estimatedRoundTripFeeSun = depositFeeSun !== null && estimatedRedeemFeeSun !== null
      ? (BigInt(depositFeeSun) + BigInt(estimatedRedeemFeeSun)).toString() : null;
    const stressRoundTripFeeSun = depositFeeSun !== null && stressRedeemFeeSun !== null
      ? (BigInt(depositFeeSun) + BigInt(stressRedeemFeeSun)).toString() : null;
    // Entry is budgeted at its current fee_limit + Bandwidth allowance; exit uses a zero-resource stress scenario.
    const feeReserveSun = deposit !== null && stressRedeemFeeSun !== null
      ? (BigInt(deposit.maxFeeSun) + BigInt(stressRedeemFeeSun)).toString() : null;
    const postReserve = feeReserveSun === null ? null
      : investableSun > BigInt(feeReserveSun) ? investableSun - BigInt(feeReserveSun) : 0n;
    const reserveStatus = postReserve === null ? 'unknown'
      : postReserve >= BigInt(amountSun) ? 'ready' : 'insufficient';
    const depositExpiry = deposit ? Date.parse(deposit.source.fetchedAt) + DEPOSIT_QUOTE_AGE_MS : null;
    const referenceExpiry = reference ? Date.parse(reference.validUntil!) : null;
    const validUntilMs = depositExpiry !== null && referenceExpiry !== null
      ? Math.min(depositExpiry, referenceExpiry) : depositExpiry ?? referenceExpiry;
    const evidenceSource = reference?.source ?? deposit?.source ?? null;
    const status = deposit !== null && reference !== null ? 'reference_scenario'
      : deposit !== null || reference !== null ? 'partial' : 'unknown';
    const scenario: NileFeeScenario = {
      planId: plan.id,
      status, basis: reference?.basis ?? 'unknown', amountSun, jTokenAmountRaw,
      referenceAccountAddress: reference?.representativeAddress ?? null,
      referenceTxIds: reference?.referenceTxIds ?? [],
      depositFeeSun, estimatedRedeemFeeSun, stressRedeemFeeSun,
      estimatedRoundTripFeeSun, stressRoundTripFeeSun, feeReserveSun,
      postReserveInvestableSun: postReserve?.toString() ?? null, reserveStatus,
      economicDepositSun: null, economicFeeReserveSun: null, economicSizingStatus: 'unknown',
      sourceUrl: evidenceSource?.sourceUrl ?? null, fetchedAt: evidenceSource?.fetchedAt ?? null,
      validUntil: validUntilMs === null ? null : new Date(validUntilMs).toISOString(),
      reason: reasons.length ? reasons.join(' · ') : null,
      assumptions: [
        deposit ? '환매 jTRX 수량은 현재 계정의 예치 모의 실행 환율로 환산했으며 실제 발행량과 다를 수 있습니다.'
          : '환매 jTRX 수량은 상품 조회 당시 환율로 환산했으며 실제 발행량과 다를 수 있습니다.',
        '환매 참고치는 미래 무료 자원을 0으로 두고 현재 Nile 단가를 적용합니다.',
        '수수료 예비액은 현재 예치 비용 예산과 환매 스트레스 시나리오의 합계이며 미래 상한이 아닙니다.',
        ...(reference?.assumptions ?? []),
      ],
    };
    if (sizedAmountSun !== undefined || scenario.status !== 'reference_scenario') return scenario;

    // This is only a cost-aware, read-only cap. Re-quote the smaller amount because the
    // redemption path and its fee can change with size. Never spend protected expenses.
    let current = scenario;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      if (current.feeReserveSun === null) break;
      const reserve = BigInt(current.feeReserveSun);
      const currentAmount = BigInt(current.amountSun);
      const affordable = investableSun > reserve ? investableSun - reserve : 0n;
      if (affordable >= currentAmount) {
        scenario.economicDepositSun = current.amountSun;
        scenario.economicFeeReserveSun = current.feeReserveSun;
        scenario.economicSizingStatus = 'ready';
        if (current !== scenario) {
          scenario.validUntil = new Date(Math.min(Date.parse(scenario.validUntil!),
            Date.parse(current.validUntil!))).toISOString();
          scenario.fetchedAt = new Date(Math.min(Date.parse(scenario.fetchedAt!),
            Date.parse(current.fetchedAt!))).toISOString();
        }
        break;
      }
      if (affordable === 0n) {
        scenario.economicSizingStatus = 'insufficient';
        break;
      }
      const next = await readAmount(plan, affordable.toString());
      if (next.status !== 'reference_scenario' || next.feeReserveSun === null ||
          next.basis !== scenario.basis || next.referenceAccountAddress !== scenario.referenceAccountAddress ||
          next.sourceUrl !== scenario.sourceUrl ||
          JSON.stringify(next.referenceTxIds) !== JSON.stringify(scenario.referenceTxIds)) {
        scenario.reason = [scenario.reason, `축소 금액 ${affordable} SUN의 수수료 재검증 실패: ${next.reason ?? '근거 없음'}`]
          .filter(Boolean).join(' · ');
        break;
      }
      current = next;
    }
    if (scenario.economicSizingStatus === 'unknown' && scenario.reason === null) {
      scenario.reason = '수수료 예비액을 반영한 금액이 제한된 재계산 횟수 안에 안정되지 않았습니다.';
    }
    return scenario;
  }

  return Promise.all(plans.filter(plan => plan.kind === 'justlend_jtrx').map(async plan => {
    const amountKey = `${plan.quote?.marketAddress ?? ''}:${plan.allocation.invested}`;
    let pending = memo.get(amountKey);
    if (!pending) { pending = readAmount(plan); memo.set(amountKey, pending); }
    return { ...await pending, planId: plan.id };
  }));
}
