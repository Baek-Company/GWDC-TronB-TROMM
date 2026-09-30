import DecimalBase from 'decimal.js';
import { sameToken } from '../../../shared/eligibility';
import { isCurrentLiveSource } from '../../../shared/provenance';
import type { AgentRequestState } from '../../../shared/agent-request';
import type { DatedAllocation, Plan, Source, Token, UserNeeds } from '../../../shared/schemas';

const Decimal = DecimalBase.clone({ precision: 128 });
export const GOAL_MONITOR_INTERVAL_MS = 5 * 60 * 1000;

export type GoalMonitorAction = 'maintain' | 'hold_new_deposit' | 'review';
export type DatedPositionState = 'uninvested' | 'confirmed_jusdt' | 'unknown';
export type GoalMonitorWallet = {
  address: string;
  balance: string | null;
  balanceToken: Token | null;
  balanceSource: Source | null;
  position: {
    status: 'ready' | 'unknown' | 'unavailable';
    receiptToken: Token;
    receiptBalanceBaseUnits?: string | null;
    marketVerified?: boolean;
    underlyingToken: Token;
    underlyingValue: string | null;
    source: Source | null;
  } | null;
};

/** A live receipt balance proves current holdings, not which past trade created them. */
export function datedPositionState(allocation: DatedAllocation | null, wallet: GoalMonitorWallet | null,
  now: Date): DatedPositionState {
  const bundle = allocation?.selectedBundleQuote;
  const position = wallet?.position;
  if (!bundle || !wallet || !position || position.status !== 'ready'
    || !position.marketVerified || position.receiptBalanceBaseUnits === null
    || position.receiptBalanceBaseUnits === undefined
    || !/^\d+$/.test(position.receiptBalanceBaseUnits)
    || position.receiptToken.symbol !== 'jUSDT' || position.receiptToken.address !== bundle.marketAddress
    || position.receiptToken.decimals !== 8 || position.underlyingToken.symbol !== 'USDT'
    || position.underlyingToken.address !== bundle.inputTokenAddress
    || position.underlyingToken.decimals !== 6
    || !isCurrentLiveSource(position.source, 'mainnet', now, 60_000)) return 'unknown';
  return BigInt(position.receiptBalanceBaseUnits) > 0n ? 'confirmed_jusdt' : 'uninvested';
}
export type GoalMonitorDecision = {
  action: GoalMonitorAction;
  reasons: string[];
  latestNetYield: string | null;
};

export function agentRequestChanged(original: AgentRequestState, latest: AgentRequestState | null): boolean {
  if (latest === null) return false;
  return latest.version !== original.version
    || latest.confirmedVersion !== original.confirmedVersion
    || latest.intent !== original.intent
    || JSON.stringify(latest.explicitFacts) !== JSON.stringify(original.explicitFacts)
    || JSON.stringify(latest.evidence) !== JSON.stringify(original.evidence);
}

export function seoulDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Keep the same goal and balances while shortening only the unelapsed earning period. */
export function remainingMonitorNeeds(needs: UserNeeds, now: Date): UserNeeds | null {
  const today = seoulDate(now);
  if (today >= needs.endDate || needs.expenses.some(expense => expense.date <= today)) return null;
  return today > needs.startDate ? { ...needs, startDate: today } : needs;
}

function changedMarketTerms(original: Plan, latest: Plan): boolean {
  if (!original.quote || !latest.quote) return true;
  if (original.quote.baseRate && (!latest.quote.baseRate
    || latest.quote.baseRate.kind !== original.quote.baseRate.kind
    || new Decimal(latest.quote.baseRate.rate).lt(original.quote.baseRate.rate))) return true;
  if (original.quote.reward?.verified && (!latest.quote.reward?.verified
    || latest.quote.reward.kind !== original.quote.reward.kind
    || new Decimal(latest.quote.reward.rate).lt(original.quote.reward.rate))) return true;
  if (original.roundTripCost !== null && (latest.roundTripCost === null
    || new Decimal(latest.roundTripCost).gt(original.roundTripCost))) return true;
  if (original.conversionImpact !== null && (latest.conversionImpact === null
    || new Decimal(latest.conversionImpact).lt(original.conversionImpact))) return true;
  return false;
}

function samePlanRoute(original: Plan, latest: Plan): boolean {
  if (!original.quote || !latest.quote) return false;
  const a = original.quote;
  const b = latest.quote;
  return a.id === b.id && a.product === b.product && a.marketAddress === b.marketAddress
    && sameToken(a.inputToken, b.inputToken) && sameToken(a.depositToken, b.depositToken)
    && ((a.receiptToken === null && b.receiptToken === null)
      || (a.receiptToken !== null && b.receiptToken !== null && sameToken(a.receiptToken, b.receiptToken)))
    && (a.conversion?.outputTokenAddress ?? null) === (b.conversion?.outputTokenAddress ?? null);
}

/** Conservative, deterministic advice. It never authorizes a transaction. */
export function evaluateGoalMonitor(input: {
  originalPlan: Plan;
  currentNeeds: UserNeeds | null;
  latestPlan: Plan | null;
  wallet: GoalMonitorWallet | null;
  expectedWalletAddress: string | null;
  originalWalletAddress?: string | null;
  requiresOriginalWallet?: boolean;
  hasConfirmedDeposit: boolean;
  hasConfirmedWithdrawal: boolean;
  requestChanged: boolean;
  dataMode: 'live' | 'mixed_or_unavailable' | null;
  now?: Date;
}): GoalMonitorDecision {
  const { originalPlan, currentNeeds, latestPlan, wallet } = input;
  const latestNetYield = latestPlan?.netYield ?? null;
  const review = (reason: string): GoalMonitorDecision => ({ action: 'review', reasons: [reason], latestNetYield });
  const hold = (reason: string): GoalMonitorDecision => ({ action: 'hold_new_deposit', reasons: [reason], latestNetYield });
  if (input.requestChanged) return review('확인한 목표 조건이 바뀌었습니다. 새 조건을 확인하고 원 계획과 다시 비교해 주세요.');
  if (input.requiresOriginalWallet && !input.originalWalletAddress) {
    return review('원 계획은 지갑 실잔액 없이 보관됐습니다. 지갑 연결 후 다시 평가하고 계획을 선택해 주세요.');
  }
  if (input.originalWalletAddress && input.expectedWalletAddress !== input.originalWalletAddress) {
    return review('원 계획을 선택한 지갑과 현재 연결된 지갑이 다릅니다.');
  }
  if (!currentNeeds || currentNeeds.confirmedVersion !== currentNeeds.inputVersion) {
    return review('현재 목표 조건이 확인되지 않았습니다.');
  }
  if (currentNeeds.inputVersion !== originalPlan.needsVersion || currentNeeds.chain !== originalPlan.chain
    || !sameToken(currentNeeds.asset, originalPlan.inputToken)
    || currentNeeds.endDate !== originalPlan.endDate) {
    return review('원 계획과 현재 조건의 버전·체인·자산이 다릅니다.');
  }
  const today = seoulDate(input.now ?? new Date());
  if (today >= currentNeeds.endDate) return review('계획 종료일이 지났거나 오늘입니다. 남은 자산과 지출을 다시 확인해 주세요.');
  if (currentNeeds.expenses.some(expense => expense.date <= today)) {
    return review('오늘까지 예정된 지출의 실제 지급 여부를 확인해야 합니다.');
  }
  if (input.hasConfirmedWithdrawal) return review('확정된 인출 기록이 있어 현재 포지션과 목표를 다시 확인해야 합니다.');
  if (latestPlan === null) return hold('같은 상품·배분의 새 계획을 조회하지 못했습니다.');
  if (latestPlan.chain !== originalPlan.chain || latestPlan.kind !== originalPlan.kind
    || latestPlan.scenario !== originalPlan.scenario || !sameToken(latestPlan.inputToken, originalPlan.inputToken)) {
    return review('새 조회 결과가 원 계획의 상품·체인·자산과 일치하지 않습니다.');
  }
  if (latestPlan.needsVersion !== currentNeeds.inputVersion || latestPlan.endDate !== currentNeeds.endDate) {
    return review('새 계획이 현재 입력 버전 또는 목표 종료일과 일치하지 않습니다.');
  }
  if (latestPlan.startDate !== (today > currentNeeds.startDate ? today : currentNeeds.startDate)) {
    return hold('남은 운용 기간으로 다시 계산한 계획이 아닙니다.');
  }
  if (!new Decimal(latestPlan.allocation.invested).eq(originalPlan.allocation.invested)
    || !new Decimal(latestPlan.allocation.protected).eq(originalPlan.allocation.protected)) {
    return review('현재 잔액·지출 조건으로 계산한 운용액 또는 보호액이 원 계획과 달라졌습니다.');
  }
  if (originalPlan.kind !== 'hold') {
    if (!samePlanRoute(originalPlan, latestPlan)) {
      return review('선택한 상품의 계약·입출금 토큰이 원 계획과 달라졌습니다.');
    }
    if (!latestPlan.quote || !latestPlan.source
      || !isCurrentLiveSource(latestPlan.source, originalPlan.chain, input.now ?? new Date(), 15 * 60 * 1000)) {
      return hold('같은 상품의 최신 실견적과 원천 갱신 시각이 확인되지 않았습니다.');
    }
    if (latestPlan.eligibility.status !== 'eligible' || latestPlan.netYield === null) {
      return hold('새 견적의 수익·왕복 비용·출금 조건이 모두 검증되지 않았습니다.');
    }
    if (new Decimal(latestPlan.netYield).lte(0)) return hold('새 계획의 예상 순익이 0 이하입니다.');
    if (today > currentNeeds.startDate) {
      if (changedMarketTerms(originalPlan, latestPlan)) {
        return review('원 계획보다 금리·보상·왕복 비용 또는 전환 조건이 불리해졌습니다.');
      }
    } else if (originalPlan.netYield !== null && new Decimal(latestPlan.netYield).lt(originalPlan.netYield)) {
      return review('같은 기간의 새 예상 순익이 원 계획보다 낮아졌습니다.');
    }
  }
  if (!input.expectedWalletAddress || !wallet || wallet.address !== input.expectedWalletAddress) {
    return hold('같은 체인에 연결된 지갑 주소의 현재 잔액을 확인하지 못했습니다.');
  }
  if (wallet.balance === null || wallet.balanceToken === null || !sameToken(wallet.balanceToken, currentNeeds.asset)
    || !isCurrentLiveSource(wallet.balanceSource, currentNeeds.chain, input.now ?? new Date(), 60_000)) {
    return hold('같은 체인·자산의 최신 지갑 잔액을 확인하지 못했습니다.');
  }
  const protectedAmount = new Decimal(latestPlan.allocation.protected);
  if (new Decimal(wallet.balance).lt(protectedAmount)) {
    return review('지갑 실잔액이 지출·예비액 보호 금액보다 적습니다.');
  }
  if (input.hasConfirmedDeposit) {
    const position = wallet.position;
    if (!position || position.status !== 'ready' || !latestPlan.quote?.receiptToken
      || !sameToken(position.receiptToken, latestPlan.quote.receiptToken)
      || !sameToken(position.underlyingToken, latestPlan.depositToken)
      || position.underlyingValue === null || new Decimal(position.underlyingValue).lte(0)
      || !isCurrentLiveSource(position.source, currentNeeds.chain, input.now ?? new Date(), 60_000)) {
      return review('확정 예치의 동일 포지션을 최신 실관측으로 확인하지 못했습니다.');
    }
  } else if (new Decimal(wallet.balance).lt(protectedAmount.plus(latestPlan.allocation.invested))) {
    return review('지갑 실잔액으로 원 계획의 지출 보호액과 운용액을 함께 충당할 수 없습니다.');
  }
  return { action: 'maintain', reasons: ['현재 확인된 조건에서 원 계획을 유지할 수 있습니다. 거래 실행 승인은 아닙니다.'],
    latestNetYield };
}

/** A dated allocation is only a saved comparison target, never an execution plan. */
export function evaluateDatedAllocationMonitor(input: {
  original: DatedAllocation;
  latest: DatedAllocation | null;
  currentNeeds: UserNeeds | null;
  wallet: GoalMonitorWallet | null;
  expectedWalletAddress: string | null;
  originalWalletAddress: string | null;
  requiresOriginalWallet?: boolean;
  simulationOnly?: boolean;
  positionState?: DatedPositionState;
  requestChanged: boolean;
  dataMode: 'live' | 'mixed_or_unavailable' | null;
  now?: Date;
}): GoalMonitorDecision {
  const latestNetYield = input.latest?.expectedNetYield ?? null;
  const review = (reason: string): GoalMonitorDecision => ({ action: 'review', reasons: [reason], latestNetYield });
  const hold = (reason: string): GoalMonitorDecision => ({ action: 'hold_new_deposit', reasons: [reason], latestNetYield });
  const { original, latest, currentNeeds, wallet } = input;
  if (input.requestChanged) return review('확인한 목표 조건이 바뀌어 날짜별 배분을 다시 선택해야 합니다.');
  if (input.requiresOriginalWallet && !input.originalWalletAddress) {
    return review('원 날짜별 배분안은 지갑 실잔액 없이 보관됐습니다. 지갑 연결 후 다시 평가하고 선택해 주세요.');
  }
  if (input.originalWalletAddress && input.expectedWalletAddress !== input.originalWalletAddress) {
    return review('원 배분안을 선택한 지갑과 현재 연결된 지갑이 다릅니다.');
  }
  if (!currentNeeds || currentNeeds.confirmedVersion !== currentNeeds.inputVersion
    || currentNeeds.inputVersion !== original.inputVersion || currentNeeds.chain !== original.chain
    || !sameToken(currentNeeds.asset, original.asset)) {
    return review('원 배분안과 현재 목표 조건의 버전·체인·자산이 다릅니다.');
  }
  const today = seoulDate(input.now ?? new Date());
  if (today >= currentNeeds.endDate) return review('계획 종료일이 도래해 남은 자산과 지출을 다시 확인해야 합니다.');
  if (currentNeeds.expenses.some(expense => expense.date <= today)) {
    return review('오늘까지 예정된 지출의 실제 지급 여부를 확인해야 합니다.');
  }
  const originalBundle = original.selectedBundleQuote;
  if (originalBundle) {
    if (input.simulationOnly) return hold('가상 시연 배분안은 실제 운용 유지 판단에 사용할 수 없습니다.');
    if (!input.expectedWalletAddress || !wallet || wallet.address !== input.expectedWalletAddress
      || wallet.balance === null || !wallet.balanceToken || !sameToken(wallet.balanceToken, original.asset)
      || !isCurrentLiveSource(wallet.balanceSource, original.chain, input.now ?? new Date(), 60_000)) {
      return hold('같은 지갑의 최신 유동 USDT 잔액을 확인하지 못했습니다.');
    }
    if (input.positionState === 'unknown' || input.positionState === undefined) {
      return review('예치 여부와 jUSDT 포지션을 확인하지 못했습니다. 원 계획의 USDT 보유 상태를 가정할 수 없습니다.');
    }
    if (input.positionState === 'confirmed_jusdt') {
      const position = wallet.position;
      if (!position || position.underlyingValue === null || new Decimal(position.underlyingValue).lte(0)) {
        return review('관측된 jUSDT의 기초 자산 가치를 확인하지 못했습니다.');
      }
      if (new Decimal(wallet.balance).lt(original.totalHeld)) {
        return review('예치 후 유동 USDT가 보유·지출 예정액에 부족합니다. 회수 가능성을 확인해 주세요.');
      }
      if (new Decimal(position.underlyingValue).lt(original.totalInvested)) {
        return review('관측된 jUSDT 가치가 원래 운용액보다 적습니다. 포지션과 회수 조건을 검토해 주세요.');
      }
      return hold('jUSDT 보유는 관측했으나 현재 계정의 환매 성공·비용 견적은 확인되지 않았습니다. 추가 예치를 보류하고 회수 조건을 검토해 주세요.');
    }
    if (new Decimal(wallet.balance).lt(original.amount)) {
      return review('예치 전 지갑 USDT가 원 날짜별 보유·운용 총액보다 적습니다.');
    }
  }
  if (latest === null) return hold('날짜별 배분의 최신 계산 결과를 조회하지 못했습니다.');
  if (latest.chain !== original.chain || !sameToken(latest.asset, original.asset)
    || latest.inputVersion !== currentNeeds.inputVersion || latest.endDate !== original.endDate
    || latest.startDate !== (today > currentNeeds.startDate ? today : currentNeeds.startDate)) {
    return review('새 날짜별 배분안의 체인·자산·기간이 원 배분안과 다릅니다.');
  }
  if (!new Decimal(latest.amount).eq(original.amount)
    || !new Decimal(latest.totalInvested).eq(original.totalInvested)
    || !new Decimal(latest.totalHeld).eq(original.totalHeld)) {
    return review('현재 잔액 또는 시장 조건에 따라 날짜별 운용·보유 총액이 달라졌습니다.');
  }
  if (latest.legs.length !== original.legs.length) return review('지출일별 분할 건수가 달라졌습니다.');
  for (const leg of original.legs) {
    const fresh = latest.legs.find(item => item.purpose === leg.purpose && item.dueDate === leg.dueDate);
    if (!fresh || !new Decimal(fresh.amount).eq(leg.amount)
      || fresh.decision !== leg.decision || fresh.product !== leg.product
      || !new Decimal(fresh.invested).eq(leg.invested)) {
      return review(`${leg.dueDate} 배분 경로 또는 금액이 바뀌었습니다.`);
    }
    if (leg.decision === 'invest' && (!leg.routeIdentity || !fresh.routeIdentity
      || leg.routeIdentity !== fresh.routeIdentity || leg.quoteId !== fresh.quoteId)) {
      return review(`${leg.dueDate} 상품 계약·입출금 토큰이 원 배분안과 달라졌습니다.`);
    }
    if (fresh.eligibility === 'unverified') return hold(`${leg.dueDate} 배분의 수익·출금 근거가 미확인입니다.`);
    if (fresh.decision === 'invest' && (!fresh.source
      || !isCurrentLiveSource(fresh.source, original.chain, input.now ?? new Date(), 15 * 60 * 1000)
      || fresh.expectedNetYield === null
      || (!originalBundle && new Decimal(fresh.expectedNetYield).lte(0)))) {
      return hold(`${leg.dueDate} 운용 경로의 최신 실견적 또는 양의 순익이 확인되지 않았습니다.`);
    }
  }
  if (originalBundle) {
    const freshBundle = latest.selectedBundleQuote;
    if (!freshBundle || freshBundle.status !== 'scenario_only'
      || freshBundle.marketAddress !== originalBundle.marketAddress
      || freshBundle.inputTokenAddress !== originalBundle.inputTokenAddress
      || freshBundle.stressNetYieldUsdt === null || new Decimal(freshBundle.stressNetYieldUsdt).lte(0)
      || Date.parse(freshBundle.validUntil) <= (input.now ?? new Date()).getTime()) {
      return hold('동일 경로의 최신 묶음 견적·스트레스 순익 또는 만료 시각을 확인하지 못했습니다.');
    }
  }
  if (!input.expectedWalletAddress || !wallet || wallet.address !== input.expectedWalletAddress
    || wallet.balance === null || !wallet.balanceToken || !sameToken(wallet.balanceToken, original.asset)
    || !isCurrentLiveSource(wallet.balanceSource, original.chain, input.now ?? new Date(), 60_000)) {
    return hold('같은 체인·자산의 최신 지갑 실잔액을 확인하지 못했습니다.');
  }
  if (!originalBundle && new Decimal(wallet.balance).lt(original.amount)) {
    return review('지갑 실잔액이 원 날짜별 배분 총액보다 적습니다.');
  }
  if (input.simulationOnly) {
    return hold('가상 시연 배분안은 실제 운용 유지 판단에 사용할 수 없습니다. 명시 정보와 실잔액으로 새 평가를 확인해 주세요.');
  }
  return { action: 'maintain', reasons: ['현재 근거에서 원 날짜별 배분 경로를 유지할 수 있습니다. 각 구간의 거래 승인은 아닙니다.'],
    latestNetYield };
}
