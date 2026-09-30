import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { proposeAdjustment, reviewPlanPosition } from '../../../shared/review';
import { findMinimumBreakEvenAllocation } from '../../../shared/sizing';
import { isCurrentLiveSource } from '../../../shared/provenance';
import type { AgentRequestState } from '../../../shared/agent-request';
import type { DatedAllocation, ExecutionRecord, Observation, Plan, PositionFlow, UserNeeds } from '../../../shared/schemas';
import type { Session } from '../../lib/session';
import { agentRequestChanged, evaluateDatedAllocationMonitor, evaluateGoalMonitor, GOAL_MONITOR_INTERVAL_MS,
  remainingMonitorNeeds } from './goal-monitor';
import { readGoalMonitor, type GoalMonitorRead } from './monitor-read';
import { monitorBlockers, safeMonitorError } from './monitor-diagnostics';

const reviewMessages: readonly (readonly [string, string])[] = [
  ["확인한 목표 조건이 바뀌었습니다. 새 조건을 확인하고 원 계획과 다시 비교해 주세요.", "Your confirmed goals have changed. Confirm the new inputs and compare them with the original plan."],
  ["원 계획은 지갑 실잔액 없이 보관됐습니다. 지갑 연결 후 다시 평가하고 계획을 선택해 주세요.", "The original plan was saved without a live wallet balance. Connect your wallet, reassess, and select a plan."],
  ["원 계획을 선택한 지갑과 현재 연결된 지갑이 다릅니다.", "The connected wallet differs from the wallet used to select the original plan."],
  ["현재 목표 조건이 확인되지 않았습니다.", "Your current goals are not confirmed."],
  ["원 계획과 현재 조건의 버전·체인·자산이 다릅니다.", "The version, chain, or asset differs between the original plan and current inputs."],
  ["계획 종료일이 지났거나 오늘입니다. 남은 자산과 지출을 다시 확인해 주세요.", "The plan ends today or has already ended. Review remaining assets and expenses."],
  ["오늘까지 예정된 지출의 실제 지급 여부를 확인해야 합니다.", "Verify whether all expenses due through today have been paid."],
  ["확정된 인출 기록이 있어 현재 포지션과 목표를 다시 확인해야 합니다.", "A confirmed withdrawal exists. Review the current position and goals."],
  ["같은 상품·배분의 새 계획을 조회하지 못했습니다.", "A new plan for the same product and allocation could not be retrieved."],
  ["새 조회 결과가 원 계획의 상품·체인·자산과 일치하지 않습니다.", "The new result does not match the original product, chain, and asset."],
  ["새 계획이 현재 입력 버전 또는 목표 종료일과 일치하지 않습니다.", "The new plan does not match the current input version or target end date."],
  ["남은 운용 기간으로 다시 계산한 계획이 아닙니다.", "This plan was not recalculated for the remaining investment period."],
  ["현재 잔액·지출 조건으로 계산한 운용액 또는 보호액이 원 계획과 달라졌습니다.", "Current balances and expenses change the invested or protected amount from the original plan."],
  ["선택한 상품의 계약·입출금 토큰이 원 계획과 달라졌습니다.", "The selected product contract or deposit/withdrawal tokens have changed from the original plan."],
  ["같은 상품의 최신 실견적과 원천 갱신 시각이 확인되지 않았습니다.", "A current live quote and source update time for the same product are unverified."],
  ["새 견적의 수익·왕복 비용·출금 조건이 모두 검증되지 않았습니다.", "The new quote's yield, round-trip costs, and withdrawal conditions are not fully verified."],
  ["새 계획의 예상 순익이 0 이하입니다.", "The new plan's estimated net yield is zero or negative."],
  ["원 계획보다 금리·보상·왕복 비용 또는 전환 조건이 불리해졌습니다.", "Rates, rewards, round-trip costs, or conversion conditions have worsened from the original plan."],
  ["같은 기간의 새 예상 순익이 원 계획보다 낮아졌습니다.", "The new estimated net yield for the same period is below the original plan."],
  ["같은 체인에 연결된 지갑 주소의 현재 잔액을 확인하지 못했습니다.", "The current balance of the connected wallet on the same chain could not be verified."],
  ["같은 체인·자산의 최신 지갑 잔액을 확인하지 못했습니다.", "The current wallet balance for the same chain and asset could not be verified."],
  ["지갑 실잔액이 지출·예비액 보호 금액보다 적습니다.", "The live wallet balance is below the protected expenses and reserve."],
  ["확정 예치의 동일 포지션을 최신 실관측으로 확인하지 못했습니다.", "A current live observation could not verify the confirmed deposit's position."],
  ["지갑 실잔액으로 원 계획의 지출 보호액과 운용액을 함께 충당할 수 없습니다.", "The live wallet balance cannot fund both the original plan's protected expenses and investment."],
  ["현재 확인된 조건에서 원 계획을 유지할 수 있습니다. 거래 실행 승인은 아닙니다.", "The original plan can be maintained under currently verified conditions. This is not transaction approval."],
  ["확인한 목표 조건이 바뀌어 날짜별 배분을 다시 선택해야 합니다.", "Your confirmed goals changed. Select a dated allocation again."],
  ["원 날짜별 배분안은 지갑 실잔액 없이 보관됐습니다. 지갑 연결 후 다시 평가하고 선택해 주세요.", "The original dated allocation was saved without a live wallet balance. Connect your wallet, reassess, and select it again."],
  ["원 배분안을 선택한 지갑과 현재 연결된 지갑이 다릅니다.", "The connected wallet differs from the wallet used to select the original allocation."],
  ["원 배분안과 현재 목표 조건의 버전·체인·자산이 다릅니다.", "The version, chain, or asset differs between the original allocation and current goals."],
  ["계획 종료일이 도래해 남은 자산과 지출을 다시 확인해야 합니다.", "The plan has reached its end date. Review remaining assets and expenses."],
  ["가상 시연 배분안은 실제 운용 유지 판단에 사용할 수 없습니다.", "A hypothetical demo allocation cannot justify maintaining a real investment."],
  ["같은 지갑의 최신 유동 USDT 잔액을 확인하지 못했습니다.", "The current liquid USDT balance of the same wallet could not be verified."],
  ["예치 여부와 jUSDT 포지션을 확인하지 못했습니다. 원 계획의 USDT 보유 상태를 가정할 수 없습니다.", "Deposit status and the jUSDT position could not be verified. The original plan's USDT holdings cannot be assumed."],
  ["관측된 jUSDT의 기초 자산 가치를 확인하지 못했습니다.", "The underlying value of observed jUSDT could not be verified."],
  ["예치 후 유동 USDT가 보유·지출 예정액에 부족합니다. 회수 가능성을 확인해 주세요.", "After deposit, liquid USDT is insufficient for holdings and scheduled expenses. Verify redemption availability."],
  ["관측된 jUSDT 가치가 원래 운용액보다 적습니다. 포지션과 회수 조건을 검토해 주세요.", "Observed jUSDT value is below the original investment. Review the position and redemption conditions."],
  ["jUSDT 보유는 관측했으나 현재 계정의 환매 성공·비용 견적은 확인되지 않았습니다. 추가 예치를 보류하고 회수 조건을 검토해 주세요.", "jUSDT holdings were observed, but redemption success and cost estimates for the current account are unverified. Withhold additional deposits and review redemption conditions."],
  ["예치 전 지갑 USDT가 원 날짜별 보유·운용 총액보다 적습니다.", "Before deposit, wallet USDT is below the original dated allocation's total holdings and investment."],
  ["날짜별 배분의 최신 계산 결과를 조회하지 못했습니다.", "The latest dated allocation calculation could not be retrieved."],
  ["새 날짜별 배분안의 체인·자산·기간이 원 배분안과 다릅니다.", "The new dated allocation's chain, asset, or period differs from the original."],
  ["현재 잔액 또는 시장 조건에 따라 날짜별 운용·보유 총액이 달라졌습니다.", "Current balances or market conditions have changed total dated investments and holdings."],
  ["지출일별 분할 건수가 달라졌습니다.", "The number of expense-date allocations has changed."],
  ["{0} 배분 경로 또는 금액이 바뀌었습니다.", "The allocation route or amount for {0} has changed."],
  ["{0} 상품 계약·입출금 토큰이 원 배분안과 달라졌습니다.", "The product contract or deposit/withdrawal tokens for {0} differ from the original allocation."],
  ["{0} 배분의 수익·출금 근거가 미확인입니다.", "Yield and withdrawal evidence for the {0} allocation is unverified."],
  ["{0} 운용 경로의 최신 실견적 또는 양의 순익이 확인되지 않았습니다.", "A current live quote or positive net yield for the {0} route is unverified."],
  ["동일 경로의 최신 묶음 견적·스트레스 순익 또는 만료 시각을 확인하지 못했습니다.", "The latest bundle quote, stress net yield, or expiry for the same route could not be verified."],
  ["같은 체인·자산의 최신 지갑 실잔액을 확인하지 못했습니다.", "The current live wallet balance for the same chain and asset could not be verified."],
  ["지갑 실잔액이 원 날짜별 배분 총액보다 적습니다.", "The live wallet balance is below the original dated allocation total."],
  ["가상 시연 배분안은 실제 운용 유지 판단에 사용할 수 없습니다. 명시 정보와 실잔액으로 새 평가를 확인해 주세요.", "A hypothetical demo allocation cannot justify maintaining a real investment. Reassess using explicit inputs and a live balance."],
  ["현재 근거에서 원 날짜별 배분 경로를 유지할 수 있습니다. 각 구간의 거래 승인은 아닙니다.", "Current evidence supports maintaining the original dated allocation routes. This does not approve transactions for any period."],
  ["입력한 목표 조건을 다시 확인해 주세요.", "Reconfirm your goals."],
  ["지갑과 상품의 네트워크를 일치시켜 주세요.", "Use the same network for the wallet and product."],
  ["지갑 자산과 상품 입력 자산을 확인해 주세요.", "Check the wallet asset and product input asset."],
  ["지출 자산과 운용 자산의 전환 경로를 확인해 주세요.", "Verify conversion between the expense asset and investment asset."],
  ["상품 견적을 조회하지 못했습니다. 연결 상태를 확인하고 다시 평가해 주세요.", "The product quote could not be retrieved. Check the connection and reassess."],
  ["상품 원천 갱신 시각이 확인되지 않거나 오래됐습니다. 최신 온체인 근거를 확인해 주세요.", "The product source update time is unknown or stale. Check current on-chain evidence."],
  ["현재 실자료가 아니므로 라이브 자료가 확보된 뒤 다시 평가해 주세요.", "This is not current live data. Reassess after live data is available."],
  ["상품 시장이 비활성 상태입니다. 다른 경로를 검토해 주세요.", "The product market is inactive. Consider another route."],
  ["시장 활성 상태를 온체인에서 확인해 주세요.", "Verify market activity on-chain."],
  ["시장 계약과 입출금 토큰 주소를 확인해 주세요.", "Verify the market contract and deposit/withdrawal token addresses."],
  ["검증된 현재 수익률을 확보해야 합니다.", "A verified current yield rate is required."],
  ["승인·예치·출금·네트워크 비용의 왕복 견적을 확인해야 합니다.", "Verify round-trip approval, deposit, withdrawal, and network costs."],
  ["PSM 양방향 전환율과 토큰·출구를 확인해야 합니다.", "Verify PSM conversion rates in both directions, tokens, and exit route."],
  ["PSM 진입 가능량을 확인하거나 금액을 줄여야 합니다.", "Verify PSM entry capacity or reduce the amount."],
  ["PSM 출구 가능량을 확인하거나 금액을 줄여야 합니다.", "Verify PSM exit capacity or reduce the amount."],
  ["필요일에 필요한 시장 인출 유동성이 부족합니다.", "Market withdrawal liquidity is insufficient for the required date."],
  ["필요일보다 앞서 환매할 수 있는 경로가 필요합니다.", "A route that permits redemption before the required date is needed."],
  ["USDD 위험을 수용하지 않는 조건입니다. 다른 상품을 검토해 주세요.", "These inputs do not accept USDD risk. Consider another product."],
  ["현재 위험 성향에 맞는 상품을 검토해 주세요.", "Consider products that match your current risk preference."],
  ["같은 네트워크의 TronLink 지갑을 연결하고 실잔액을 다시 조회해 주세요.", "Connect a TronLink wallet on the same network and refresh its live balance."],
  ["실잔액으로 지출 보호액과 계획 운용액을 충당할 수 있는지 확인해 주세요.", "Verify that the live balance can fund protected expenses and the planned investment."],
  ["거래 수수료용 TRX와 필요 리소스를 확인해 주세요.", "Verify TRX fee funds and required resources."],
  ["거래 수수료 예비액을 확보하거나 운용액을 줄여야 합니다.", "Provide a transaction fee reserve or reduce the investment."],
  ["지출·예비액을 제외한 운용 가능액이 없습니다.", "No investable funds remain after expenses and reserves."],
  ["시장 출금 유동성과 지연 시간을 확인해야 합니다.", "Verify market withdrawal liquidity and delays."],
  ["오늘 필요한 자금입니다. 먼저 지급 여부를 확인해 주세요.", "These funds are needed today. First check whether payment is complete."],
  ["이 기간에는 비용 차감 후 이익이 없어 보유가 우선입니다.", "Holding takes priority because this period has no profit after costs."],
  ["여러 지출일을 합친 출구·전환 가능량을 확인해야 합니다.", "Verify combined exit and conversion capacity across expense dates."],
  ["토큰 소수 자릿수에 맞게 금액을 확인해 주세요.", "Check the amount against the token's decimal precision."],
  ["운용 시작일을 오늘 기준으로 다시 평가해 주세요.", "Reassess with today as the investment start date."],
  ["JustLend 시장 API", "JustLend market API"],
  ["PSM 양방향 경로", "PSM two-way route"],
  ["Nile jTRX 연환산 수익률", "Nile jTRX annualized yield"],
  ["조회 한도(HTTP 429)에 걸렸습니다. 잠시 후 다시 평가하고 서버의 API 키·호출량을 확인해 주세요.", "The request limit (HTTP 429) was reached. Reassess shortly and check the server API key and request volume."],
  ["조회 인증을 확인해야 합니다. 서버의 API 키와 권한을 확인해 주세요.", "Authentication requires verification. Check the server API key and permissions."],
  ["조회 접근이 제한됐습니다. 서버의 API 키·권한과 호출량을 확인해 주세요.", "Read access is restricted. Check the server API key, permissions, and request volume."],
  ["응답 시간이 초과됐습니다. 연결을 확인한 뒤 다시 평가해 주세요.", "The response timed out. Check the connection and reassess."],
  ["제공자 주소에 연결할 수 없습니다. 네트워크를 확인해 주세요.", "The provider address could not be reached. Check the network."],
  ["PSM 양방향 전환 가능량과 왕복 비용을 검증해야 합니다.", "Verify PSM conversion capacity in both directions and round-trip costs."],
  ["Nile 블록당 금리를 연환산할 검증된 기준이 필요합니다.", "A verified basis for annualizing the Nile per-block rate is required."],
  ["조건이 확인되지 않았습니다. 원천 상태를 확인하고 다시 평가해 주세요.", "Conditions are unverified. Check the source status and reassess."],
  ["조회할 수 없습니다. 원천 상태를 확인하고 다시 평가해 주세요.", "Data is unavailable. Check the source status and reassess."],
  ["지갑 잔액 RPC 조회 한도(HTTP 429)에 걸렸습니다. 잠시 후 다시 평가하고 서버 API 키·호출량을 확인해 주세요.", "The wallet balance RPC request limit (HTTP 429) was reached. Reassess shortly and check the server API key and request volume."],
  ["지갑 실잔액이 지출 보호액에 부족합니다. 조건과 잔액을 다시 확인해 주세요.", "The live wallet balance cannot cover protected expenses. Recheck the inputs and balance."],
  ["같은 네트워크·자산의 지갑 실잔액을 확인하지 못했습니다. 지갑 연결과 RPC 상태를 확인해 주세요.", "The live wallet balance for the same network and asset could not be verified. Check the wallet connection and RPC status."],
  ["조회 한도(HTTP 429)에 걸렸습니다. 잠시 후 다시 시도해 주세요.", "The request limit (HTTP 429) was reached. Try again shortly."],
  ["에이전트 세션이 만료됐습니다. 화면을 새로고침해 주세요.", "The agent session expired. Refresh the page."],
  ["이미 도래한 지출의 지급 여부를 확인해 주세요.", "Check whether expenses already due have been paid."],
  ["확인한 계획 조건을 다시 점검해 주세요.", "Recheck the confirmed plan inputs."],
  ["상품 또는 지갑 자료 조회에 실패했습니다. 연결 상태를 확인하고 다시 평가해 주세요.", "Product or wallet data retrieval failed. Check the connection and reassess."],
  ["관측의 계획·체인·지갑이 원 거래와 일치하지 않습니다.", "The observation's plan, chain, or wallet does not match the original transaction."],
  ["관측의 영수증/기초 자산이 원 계획과 일치하지 않습니다.", "The observation's receipt or underlying asset does not match the original plan."],
  ["원 Nile 견적의 jTRX 주소가 시장 주소와 다릅니다.", "The original Nile quote's jTRX address differs from the market address."],
  ["관측의 Nile jTRX 포지션이 원 계획과 일치하지 않습니다.", "The observed Nile jTRX position does not match the original plan."],
  ["Nile jTRX 잔고·환율·기초자산 가치가 일치하지 않습니다.", "Nile jTRX balance, exchange rate, and underlying value are inconsistent."],
  ["거래 상품의 원 계획과 견적이 필요합니다.", "The product's original plan and quote are required."],
  ["원 계획과 거래의 ID 또는 체인이 일치하지 않습니다.", "The original plan and transaction have different IDs or chains."],
  ["확정 거래 근거가 부족합니다.", "Confirmed transaction evidence is insufficient."],
  ["원 거래 확정보다 앞선 관측은 결과로 사용할 수 없습니다.", "An observation before confirmation of the original transaction cannot be used as a result."],
  ["거래 전 동일 포지션의 실제 관측이 필요합니다.", "A live observation of the same position before the transaction is required."],
  ["중복된 포지션 현금흐름 ID가 있습니다.", "Duplicate position cash-flow IDs exist."],
  ["포지션 현금흐름의 계획·체인·계정·자산·기간이 일치하지 않습니다.", "The position cash flow's plan, chain, account, asset, or period does not match."],
  ["원 거래 수수료가 확정 영수증과 현금흐름 기록에서 다릅니다.", "The original transaction fee differs between the confirmed receipt and cash-flow record."],
  ["같은 거래 ID의 수수료 값이 다릅니다.", "Fee values differ for the same transaction ID."],
  ["다른 체인이나 시작 자산으로 원 계획을 조정할 수 없습니다.", "The original plan cannot be adjusted to a different chain or starting asset."],
  ["새 견적의 상품과 체인이 원 계획과 다릅니다.", "The new quote's product or chain differs from the original plan."],
  ["입력 또는 견적 버전이 원 계획보다 새롭지 않습니다.", "The input or quote version is not newer than the original plan."],
  ["원 Nile 시나리오의 새 견적이 필요합니다.", "A new quote for the original Nile scenario is required."],
];

const allocationProductText: Record<NonNullable<DatedAllocation['legs'][number]['product']>, string> = {
  justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
};
export function ReviewPanel({ selectedPlan, monitorPlan = null, datedAllocation = null, records, observations, openingObservations,
  positionFlows, flowCoverages, currentNeeds, agentRequest = null, currentAgentRequest = null,
  walletAddress = null, originalWalletAddress = null, onExport }: {
  selectedPlan: Plan | null;
  monitorPlan?: Plan | null;
  datedAllocation?: DatedAllocation | null;
  records: ExecutionRecord[];
  observations: Observation[];
  openingObservations: Session['openingObservations'];
  positionFlows: PositionFlow[];
  flowCoverages: Session['flowCoverages'];
  currentNeeds: UserNeeds | null;
  agentRequest?: AgentRequestState | null;
  currentAgentRequest?: AgentRequestState | null;
  walletAddress?: string | null;
  originalWalletAddress?: string | null;
  onExport: () => void;
}) {
  const { t, locale } = useI18n();
  const displayMessage = (message: string): string => {
    const translated = localizeKnownText(message, t, reviewMessages);
    if (translated !== message) return translated;
    return message.split(': ').map(part => localizeKnownText(part, t, reviewMessages)).join(': ');
  };
  const statusText = {
    not_executed: t("거래 전", "Before execution"), unconfirmed: t("원 거래 확인 중", "Original transaction pending confirmation"), awaiting_observation: t("포지션 조회 대기", "Awaiting position observation"),
    non_live_observation: t("현재 실관측 아님", "Not a current live observation"), observed: t("포지션 관측됨", "Position observed"), comparable: t("계획 대비 비교 가능", "Comparable with plan"),
  };
  function allocationPath(product: DatedAllocation['legs'][number]['product']): string {
    return product ? allocationProductText[product] : t("보유", "Hold");
  }

  const baselinePlan = datedAllocation ? null : monitorPlan ?? selectedPlan;
  const [monitor, setMonitor] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error';
    read: GoalMonitorRead | null; error: string }>({ status: 'idle', read: null, error: '' });
  const refreshRef = useRef<() => void>(() => {});
  const needsKey = JSON.stringify(currentNeeds);
  const agentKey = JSON.stringify(currentAgentRequest ?? agentRequest);
  const originalAgentKey = JSON.stringify(agentRequest);
  const requestHasChanged = agentRequest ? agentRequestChanged(agentRequest, currentAgentRequest) : false;
  const effectiveRequest = currentAgentRequest ?? agentRequest;
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const refresh = () => {
      if (controller || (!baselinePlan && !datedAllocation) || !currentNeeds ||
        (effectiveRequest && effectiveRequest.confirmedVersion !== effectiveRequest.version)) return;
      if (remainingMonitorNeeds(currentNeeds, new Date()) === null) {
        setMonitor({ status: 'idle', read: null, error: '' });
        return;
      }
      controller = new AbortController();
      const requestController = controller;
      setMonitor({ status: 'loading', read: null, error: '' });
      void readGoalMonitor({ originalPlan: baselinePlan, originalAllocation: datedAllocation, currentNeeds,
        agentRequest: effectiveRequest, address: walletAddress, signal: requestController.signal })
        .then(read => { if (active) setMonitor({ status: 'ready', read, error: '' }); })
        .catch(cause => {
          if (active && !requestController.signal.aborted) setMonitor({ status: 'error', read: null,
            error: safeMonitorError(cause) });
        }).finally(() => { if (controller === requestController) controller = null; });
    };
    refreshRef.current = refresh;
    setMonitor({ status: 'idle', read: null, error: '' });
    refresh();
    const refreshWhileVisible = () => { if (!document.hidden) refresh(); };
    const interval = window.setInterval(refreshWhileVisible, GOAL_MONITOR_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshWhileVisible);
    return () => { active = false; window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhileVisible); controller?.abort();
      if (refreshRef.current === refresh) refreshRef.current = () => {}; };
  }, [baselinePlan?.id, datedAllocation?.id, needsKey, agentKey, originalAgentKey,
    walletAddress, originalWalletAddress]);
  const matchingRecords = selectedPlan ? records.filter(item => item.planId === selectedPlan.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const record = matchingRecords.find(item => item.action !== 'withdraw');
  const withdrawal = matchingRecords.find(item => item.action === 'withdraw');
  const monitorRecord = baselinePlan?.id === selectedPlan?.id ? record : undefined;
  const monitorWithdrawal = baselinePlan?.id === selectedPlan?.id ? withdrawal : undefined;
  const observation = record ? observations.filter(item => item.planId === record.planId
    && item.walletAddress === record.walletAddress).sort((a, b) => b.source.fetchedAt.localeCompare(a.source.fetchedAt))[0] : undefined;
  const opening = record ? openingObservations.find(item => item.recordId === record.id)?.observation : undefined;
  const matchingFlows = record && opening ? positionFlows.filter(item => item.planId === record.planId
    && item.positionId === opening.positionId && item.walletAddress === record.walletAddress) : [];
  const coverage = record && opening ? flowCoverages.find(item => item.planId === record.planId
    && item.positionId === opening.positionId && item.walletAddress === record.walletAddress)?.coverage : undefined;
  const monitorDecision = datedAllocation ? evaluateDatedAllocationMonitor({ original: datedAllocation,
      latest: monitor.read?.datedAllocation ?? null, currentNeeds,
      wallet: monitor.read?.wallet ?? null, expectedWalletAddress: walletAddress,
      originalWalletAddress, requiresOriginalWallet: agentRequest !== null,
      requestChanged: requestHasChanged,
      dataMode: monitor.read?.dataMode ?? null, simulationOnly: agentRequest === null,
      positionState: monitor.read?.positionState ?? 'unknown' }) : baselinePlan ? evaluateGoalMonitor({ originalPlan: baselinePlan,
    currentNeeds, latestPlan: monitor.read?.latestPlan ?? null, wallet: monitor.read?.wallet ?? null,
    expectedWalletAddress: walletAddress, originalWalletAddress: originalWalletAddress ?? monitorRecord?.walletAddress ?? null,
    requiresOriginalWallet: agentRequest !== null,
    hasConfirmedDeposit: monitorRecord?.status === 'confirmed', hasConfirmedWithdrawal: monitorWithdrawal?.status === 'confirmed',
    requestChanged: requestHasChanged,
    dataMode: monitor.read?.dataMode ?? null }) : null;
  const blockers = monitor.read ? monitorBlockers({
    originalPlan: baselinePlan, originalAllocation: datedAllocation,
    latestPlan: monitor.read.latestPlan, latestAllocation: monitor.read.datedAllocation,
    diagnostics: monitor.read.diagnostics,
    balanceReason: monitor.read.positionState === 'confirmed_jusdt' ? null : monitor.read.balanceReason,
    walletIssue: monitor.read.walletIssue,
  }) : [];
  const reviewed = useMemo(() => {
    if (!selectedPlan || !record) return { value: null, error: '' };
    try { return { value: reviewPlanPosition({ plan: selectedPlan, record, observation,
      openingObservation: opening, positionFlows: matchingFlows, flowCoverage: coverage }), error: '' }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : t("기록 검증 실패", "Record verification failed") }; }
  }, [selectedPlan, record, observation, opening, positionFlows, flowCoverages, t]);
  const evidenceGaps = record?.status === 'confirmed' ? [
    !opening && t("예치 전 같은 포지션의 실관측이 없습니다.", "There is no live observation of the same position before the deposit."),
    !matchingFlows.some(item => item.kind === 'deposit' && item.txId === record.txId)
      && t("확정된 예치 투입액·수수료 현금흐름이 없습니다.", "Confirmed cash flows for the deposit amount and fees are missing."),
    withdrawal?.status === 'confirmed' && !matchingFlows.some(item => item.kind === 'withdraw' && item.txId === withdrawal.txId)
      && t("환매 영수증에서 실제 수령 TRX가 검증되지 않아 환매 현금흐름을 만들 수 없습니다.", "Actual TRX received is unverified in the redemption receipt, so a redemption cash flow cannot be created."),
    !coverage && t("포지션 기간 전체의 현금흐름 조회 범위가 검증되지 않았습니다.", "Cash flow coverage for the entire position period is unverified."),
  ].filter((reason): reason is string => typeof reason === 'string') : [];
  const adjustment = useMemo(() => {
    if (monitorPlan || datedAllocation || !selectedPlan || !currentNeeds || selectedPlan.chain !== currentNeeds.chain
      || currentNeeds.inputVersion <= selectedPlan.needsVersion) return { value: null, error: '' };
    if (agentRequest) return { value: null, error: t("에이전트 입력을 다시 확인한 뒤 새 평가 결과를 비교해 주세요.", "Reconfirm the agent inputs before comparing the new assessment.") };
    if (!monitor.read) return { value: null, error: t("최신 상품 견적을 조회한 뒤 조정액을 계산합니다.", "The adjustment will be calculated after retrieving a current product quote.") };
    const remaining = remainingMonitorNeeds(currentNeeds, new Date());
    if (!remaining) return { value: null, error: t("도래한 지출 또는 종료일을 확인한 뒤 새 계획을 계산해 주세요.", "Review due expenses or the end date before calculating a new plan.") };
    try { return { value: proposeAdjustment({ originalPlan: selectedPlan,
      changedNeeds: remaining, newQuote: monitor.read.latestPlan?.quote ?? null }), error: '' }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : t("조정 계산 불가", "Adjustment cannot be calculated") }; }
  }, [selectedPlan, monitorPlan, datedAllocation, currentNeeds, agentRequest, monitor.read, t]);
  const minimum = useMemo(() => {
    if (monitorPlan || datedAllocation || !selectedPlan || agentRequest || !currentNeeds || currentNeeds.inputVersion !== selectedPlan.needsVersion ||
        currentNeeds.chain !== selectedPlan.chain || !monitor.read?.latestPlan?.quote) return null;
    const remaining = remainingMonitorNeeds(currentNeeds, new Date());
    const latest = monitor.read.latestPlan;
    if (!remaining || !latest.source || !isCurrentLiveSource(latest.source, latest.chain, new Date(), 15 * 60 * 1000)) return null;
    try { return findMinimumBreakEvenAllocation({ needs: remaining, quote: latest.quote }); }
    catch { return null; }
  }, [selectedPlan, monitorPlan, datedAllocation, currentNeeds, agentRequest, monitor.read, t]);
  return <section className="review-panel">
    <div className="section-intro"><div><p className="overline">REVIEW / READ ONLY</p><h2>{t("계획·거래·포지션 검토", "Review plans, transactions, and positions")}</h2><p>{t("원 계획과 실제 관측의 체인·자산·계정을 확인한 뒤에만 성과를 비교합니다.", "Performance is compared only after verifying the chain, asset, and account of the original plan and actual observations.")}</p></div><button className="refresh-button" type="button" onClick={onExport}>{t("기록 JSON 내보내기", "Export records as JSON")}</button></div>
    {!baselinePlan && !datedAllocation && <div className="plan-gate"><strong>{t("선택한 계획이 없습니다.", "No plan selected.")}</strong><p>{t("조건을 확인하고 계획을 선택하면 버전이 있는 원 계획을 여기에 보존합니다.", "Confirm your inputs and select a plan to preserve the versioned original plan here.")}</p></div>}
    {baselinePlan && <div className="surface review-summary"><h3>{t("원 감시 계획", "Original monitoring plan")}</h3><p><strong>{baselinePlan.chain.toUpperCase()}</strong> · {baselinePlan.kind} · {baselinePlan.scenario} · {baselinePlan.eligibility.status === 'eligible' ? t("조건 충족", "Conditions met") : t("실행 조건 미충족", "Execution conditions not met")}</p><p>{t("운용액 ", "Investment amount ")}{baselinePlan.allocation.invested} {baselinePlan.inputToken.symbol}{t(" · 종료일 ", " · End date ")}{baselinePlan.endDate}{t(" · 입력 버전 ", " · Input version ")}{baselinePlan.needsVersion}</p><p>{t("계획 ID ", "Plan ID ")}<code>{baselinePlan.id}</code></p><p>{t("원 계획 예상 순익: ", "Original plan estimated net yield: ")}{baselinePlan.netYield === null ? t("미확인", "Unverified") : `${baselinePlan.netYield} ${baselinePlan.inputToken.symbol}`}</p></div>}
    {selectedPlan && selectedPlan !== baselinePlan && <div className="surface review-summary"><h3>{t("기존 거래 기록의 계획", "Plan for existing transaction records")}</h3><p>{selectedPlan.chain.toUpperCase()} · {selectedPlan.kind}{t(" · 계획 ID ", " · Plan ID ")}<code>{selectedPlan.id}</code></p><p>{t("아래 실행 기록과 포지션 검토는 이 계획을 기준으로 표시합니다.", "The execution records and position review below refer to this plan.")}</p></div>}
    {datedAllocation && <div className="surface review-summary"><h3>{t("원 날짜별 배분안 · 읽기 전용", "Original dated allocation · Read only")}</h3>
      <p>{datedAllocation.chain.toUpperCase()}{t(" · 총 운용 ", " · Total invested ")}{datedAllocation.totalInvested} {datedAllocation.asset.symbol}{t(" · 보유 ", " · Held ")}{datedAllocation.totalHeld} {datedAllocation.asset.symbol}{t(" · 예상 순익 ", " · Estimated net yield ")}{datedAllocation.expectedNetYield ?? t("미확인", "Unverified")} {datedAllocation.asset.symbol}</p>
      <p>{t("운용 구간 ", "Investment period ")}{datedAllocation.startDate} ~ {datedAllocation.endDate}{t(" · 계획 ID ", " · Plan ID ")}<code>{datedAllocation.id}</code></p>
      <div className="table-scroll"><table><thead><tr><th>{t("용도·필요일", "Purpose / Required date")}</th><th>{t("금액", "Amount")}</th><th>{t("경로", "Route")}</th><th>{t("출금 요청일", "Withdrawal request date")}</th></tr></thead><tbody>
        {datedAllocation.legs.map((leg, index) => <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
          <td>{leg.purpose === 'expense' ? t("예정 지출", "Scheduled expense") : t("운용 종료", "Investment end")} · {leg.dueDate}</td>
          <td>{leg.amount} {datedAllocation.asset.symbol}</td>
          <td>{allocationPath(leg.product)}{t(" · 순익 ", " · Net yield ")}{leg.expectedNetYield ?? t("미확인", "Unverified")}</td>
          <td>{leg.withdrawalRequestDate ?? t("해당 없음", "Not applicable")}</td>
        </tr>)}
      </tbody></table></div>
      {datedAllocation.selectedBundleQuote && <div className="agent-bundle-evidence">
        <p>{t("원 금액별 묶음 견적 ", "Original amount-specific bundle quote ")}{datedAllocation.selectedBundleQuote.quoteVersion.slice(0, 12)} · {datedAllocation.selectedBundleQuote.status}{t(" · 만료 ", " · Expires ")}{new Date(datedAllocation.selectedBundleQuote.validUntil).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST</p>
        <p>{t("공동 승인 ", "Shared approvals ")}{datedAllocation.selectedBundleQuote.approvalActions}{t(" · 예정 행동 ", " · Planned actions ")}{datedAllocation.selectedBundleQuote.actions.length}{t("건 · 예상 비용 ", " actions · Estimated cost ")}{datedAllocation.selectedBundleQuote.expectedCostUsdt ?? t("미확인", "Unverified")}{t(" USDT · 스트레스 비용 ", " USDT · Stress cost ")}{datedAllocation.selectedBundleQuote.stressCostUsdt ?? t("미확인", "Unverified")} USDT</p>
        <p>{t("수수료용 TRX 정책 예비액 ", "TRX fee policy reserve ")}{datedAllocation.selectedBundleQuote.requiredFeeTrxSun === null ? t("미확인", "Unverified") : `${new Decimal(datedAllocation.selectedBundleQuote.requiredFeeTrxSun).div(1_000_000).toString()} TRX`}{t(" · 원 관측 TRX ", " · Original observed TRX ")}{datedAllocation.selectedBundleQuote.availableFeeTrxSun === null ? t("미확인", "Unverified") : `${new Decimal(datedAllocation.selectedBundleQuote.availableFeeTrxSun).div(1_000_000).toString()} TRX`}</p>
        <p>{t("원 예상 순익 ", "Original estimated net yield ")}{datedAllocation.selectedBundleQuote.scenarioNetYieldUsdt ?? t("미확인", "Unverified")}{t(" USDT · 스트레스 순익 ", " USDT · Stress net yield ")}{datedAllocation.selectedBundleQuote.stressNetYieldUsdt ?? t("미확인", "Unverified")}{t(" USDT. 실제 거래·회수 결과가 아닙니다.", " USDT. These are not actual transaction or redemption results.")}</p>
      </div>}
      <p>{datedAllocation.selectedBundleQuote ? t("선택 구간의 공동 비용 시나리오와 나머지 보유액을 구분합니다.", "Shared-cost scenarios for selected periods are shown separately from remaining holdings.") : t("각 구간은 독립적인 가상 예상 비교입니다.", "Each period is an independent hypothetical projection.")}{t(" 이 배분안은 거래·서명·실행 권한을 만들지 않습니다.", " This allocation does not grant transaction, signing, or execution permission.")}</p>
      {agentRequest === null && <p role="note">{t("가상 시연 조건으로 저장한 비교안입니다. 지갑 실잔액을 연결해도 실거래 권고로 전환되지 않으며, 이 기준선의 신규 예치는 보류합니다.", "This comparison was saved with hypothetical demo inputs. Connecting a live wallet balance does not turn it into a real transaction recommendation. New deposits under this baseline remain on hold.")}</p>}
    </div>}
    {(baselinePlan || datedAllocation) && <div className="surface review-summary" aria-label={t("목표 감시", "Goal monitoring")}>
      <div className="goal-monitor-head"><h3>{t("목표 감시", "Goal monitoring")}</h3><button className="refresh-button" type="button"
        disabled={monitor.status === 'loading' || (effectiveRequest !== null && effectiveRequest.confirmedVersion !== effectiveRequest.version)}
        onClick={() => refreshRef.current()}>{t("지금 다시 평가", "Reassess now")}</button></div>
      <p>{t("이 화면에 들어올 때와 화면을 열어 둔 동안 5분마다 시세·조건을 다시 확인합니다. 자동 거래·백그라운드 알림은 하지 않습니다.", "Prices and conditions are checked when this screen opens and every five minutes while it remains open. No automatic trading or background notifications are performed.")}</p>
      {monitor.status === 'idle' && <p role="status">{monitorDecision?.action === 'review'
        ? `${t('계획 재검토', 'Review plan')} · ${monitorDecision.reasons.map(displayMessage).join(' · ')}` : t("최신 자료 조회를 준비하고 있습니다.", "Preparing to retrieve current data.")}</p>}
      {monitor.status === 'loading' && <p role="status">{t("최신 상품·지갑 자료를 조회하고 있습니다…", "Retrieving current product and wallet data…")}</p>}
      {monitor.status === 'loading' && monitorDecision?.action === 'review'
        && <p><strong>{t("계획 재검토", "Review plan")}</strong> · {monitorDecision.reasons.map(displayMessage).join(' · ')}</p>}
      {monitor.status === 'error' && <p role="alert">{t("재평가 실패: ", "Reassessment failed: ")}{displayMessage(monitor.error)}{t(" · 최신 자료를 확인할 때까지 신규 예치를 보류합니다.", " · New deposits remain on hold until current data is verified.")}</p>}
      {(monitor.status === 'ready' || monitor.status === 'error') && <p><strong>{monitor.status === 'error' && monitorDecision?.action !== 'review' ? t("신규 예치 보류", "New deposits on hold")
        : monitorDecision?.action === 'maintain' ? t("유지", "Maintain")
          : monitorDecision?.action === 'review' ? t("계획 재검토", "Review plan") : t("신규 예치 보류", "New deposits on hold")}</strong>
        {' · '}{monitor.status === 'error' && monitorDecision?.action !== 'review' ? t("최신 데이터를 확인할 수 없습니다.", "Current data could not be verified.") : monitorDecision?.reasons.map(displayMessage).join(' · ')}</p>}
      <p>{t("원 예상 순익 ", "Original estimated net yield ")}{datedAllocation?.expectedNetYield ?? baselinePlan?.netYield ?? t("미확인", "Unverified")} {datedAllocation?.asset.symbol ?? baselinePlan?.inputToken.symbol}{t(" · 새 예상 순익 ", " · New estimated net yield ")}{datedAllocation ? monitor.read?.datedAllocation?.expectedNetYield ?? t("미확인", "Unverified") : monitor.read?.latestPlan?.netYield ?? t("미확인", "Unverified")} {datedAllocation?.asset.symbol ?? baselinePlan?.inputToken.symbol}</p>
      {datedAllocation?.selectedBundleQuote && <p>{t("현재 포지션: ", "Current position: ")}{monitor.read?.positionState === 'confirmed_jusdt' ? t("지갑에서 jUSDT 보유 관측 · 예치 거래 자체는 미검증", "jUSDT observed in wallet · Deposit transaction itself unverified")
        : monitor.read?.positionState === 'uninvested' ? t("jUSDT 잔액 0 관측 · 신규 진입 전 조건", "Zero jUSDT balance observed · Before a new entry")
          : t("예치 여부 미확인 · 신규 예치 보류", "Deposit status unverified · New deposits on hold")}
        {' · '}{t("현재 유동 USDT ", "Current liquid USDT ")}{monitor.read?.wallet?.balance ?? t("미확인", "Unverified")}
        {' · '}{t("수수료용 TRX ", "TRX for fees ")}{monitor.read?.feeTrxAmount ?? t("미확인", "Unverified")}</p>}
      {datedAllocation?.selectedBundleQuote && monitor.read?.positionState === 'confirmed_jusdt'
        && <p>{t("예치 후에는 원래 운용액이 유동 USDT로 남아 있다고 가정하지 않습니다. 현재 jUSDT 환매 성공과 비용을 확인할 때까지 추가 예치를 보류합니다.", "After a deposit, the original investment is not assumed to remain as liquid USDT. Additional deposits remain on hold until current jUSDT redemption success and costs are verified.")}</p>}
      <p>{t("재평가 시각 ", "Reassessed at ")}{monitor.read ? new Date(monitor.read.checkedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' }) + ' KST' : t("미조회", "Not retrieved")}
        {' · '}{t("자료 ", "Data ")}{monitor.read?.dataMode === 'live' ? t("실데이터", "Live data") : monitor.read?.dataMode === 'mixed_or_unavailable' ? t("혼합 또는 미확인", "Mixed or unverified") : t("상품별 근거 확인 필요", "Product evidence needs verification")}</p>
      {monitor.read?.latestPlan && <p>{t("새 계획의 남은 운용 기간: ", "Remaining investment period of the new plan: ")}{monitor.read.latestPlan.startDate} ~ {monitor.read.latestPlan.endDate} ({monitor.read.latestPlan.days}{t("일). 위 새 예상 순익은 이 남은 기간 기준입니다.", " days). The new estimated net yield above uses this remaining period.")}</p>}
      {datedAllocation && monitor.read?.datedAllocation && <p>{t("새 날짜별 배분의 남은 운용 기간: ", "Remaining investment period of the new dated allocation: ")}{monitor.read.datedAllocation.startDate} ~ {monitor.read.datedAllocation.endDate}{t(". 위 새 예상 순익은 이 남은 기간 기준입니다.", ". The new estimated net yield above uses this remaining period.")}</p>}
      {datedAllocation?.selectedBundleQuote && monitor.read?.datedAllocation?.selectedBundleQuote && <p>{t("새 묶음 견적 ", "New bundle quote ")}{monitor.read.datedAllocation.selectedBundleQuote.quoteVersion.slice(0, 12)} · {monitor.read.datedAllocation.selectedBundleQuote.status}{t(" · 만료 ", " · Expires ")}{new Date(monitor.read.datedAllocation.selectedBundleQuote.validUntil).toLocaleString(locale, { timeZone: 'Asia/Seoul' })}{t(" KST · 스트레스 순익 ", " KST · Stress net yield ")}{monitor.read.datedAllocation.selectedBundleQuote.stressNetYieldUsdt ?? t("미확인", "Unverified")} USDT</p>}
      {datedAllocation && monitor.read?.datedAllocation && <div className="table-scroll"><table><thead><tr><th>{t("필요일", "Required date")}</th><th>{t("원 경로", "Original route")}</th><th>{t("새 경로", "New route")}</th><th>{t("새 자료", "New evidence")}</th></tr></thead><tbody>
        {datedAllocation.legs.map((leg, index) => {
          const fresh = monitor.read?.datedAllocation?.legs.find(item => item.purpose === leg.purpose && item.dueDate === leg.dueDate);
          return <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
            <td>{leg.purpose === 'expense' ? t("지출", "Expense") : t("종료", "End")} · {leg.dueDate}</td>
            <td>{allocationPath(leg.product)} · {leg.invested} {datedAllocation.asset.symbol}</td>
            <td>{fresh ? `${allocationPath(fresh.product)} · ${fresh.invested} ${datedAllocation.asset.symbol}` : t("조회되지 않음", "Not retrieved")}</td>
            <td>{fresh?.source ? <><a href={fresh.source.sourceUrl} target="_blank" rel="noreferrer">{t("출처", "Source")}</a> · {fresh.source.mode} · {new Date(fresh.source.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST</>
              : fresh?.eligibility === 'held' ? t("보유", "Hold") : fresh?.eligibility === 'unverified' ? t("근거 미확인", "Evidence unverified") : t("미확인", "Unverified")}</td>
          </tr>;
        })}
      </tbody></table></div>}
      {monitor.read?.latestPlan?.source && <p>{t("상품 출처 ", "Product source ")}<a href={monitor.read.latestPlan.source.sourceUrl} target="_blank" rel="noreferrer">{monitor.read.latestPlan.source.sourceUrl}</a>
        {' · '}{t("조회 ", "Retrieved ")}{new Date(monitor.read.latestPlan.source.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST
        {' · '}{t("원천 갱신 ", "Source updated ")}{monitor.read.latestPlan.source.sourceUpdatedAt ?? t("미제공", "Not provided")}
        {' · '}{monitor.read.latestPlan.source.mode}</p>}
      <p>{t("지갑 실잔액 ", "Live wallet balance ")}{monitor.read?.wallet?.balance ?? t("미확인", "Unverified")} {datedAllocation?.asset.symbol ?? baselinePlan?.inputToken.symbol}
        {monitor.read?.wallet?.balanceSource && <>{t(" · RPC 조회 ", " · RPC retrieved ")}{new Date(monitor.read.wallet.balanceSource.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST</>}
        {monitor.read?.walletIssue ? t(" · 조회 문제 있음", " · Retrieval issue") : ''}</p>
      {monitor.status === 'ready' && monitorDecision?.action !== 'maintain' && blockers.length > 0
        && <div className="source-diagnostics" aria-label={t("보류 근거 및 다음 단계", "Reasons for hold and next steps")}><h3>{t("보류 근거와 확인 방법", "Reasons for hold and next checks")}</h3>
          {blockers.map(item => <p key={item.key}>{displayMessage(item.message)}</p>)}
        </div>}
      <p>{t("이 판단은 읽기 전용 비교입니다. 포지션 가치와 실제 수익은 아래의 확정 거래·관측 증거로 따로 검증합니다.", "This decision is a read-only comparison. Position value and actual returns are verified separately using the confirmed transaction and observation evidence below.")}</p>
    </div>}
    {selectedPlan && !record && <div className="surface review-summary"><h3>{t("실행 기록", "Execution records")}</h3><p>{t("이 계획의 확정된 원 거래 ID가 없습니다. 예상 수익을 실제 성과로 표시하지 않습니다.", "This plan has no confirmed original transaction ID. Estimated yield is not reported as actual performance.")}</p></div>}
    {selectedPlan && !monitorPlan && !datedAllocation && <div className="surface review-summary"><h3>{t("손익분기 최소 운용액", "Minimum investment for break-even")}</h3>
      <p>{minimum?.status === 'found' ? t(`${minimum.minimumAmount} ${selectedPlan.inputToken.symbol} · 검증 범위 최대 ${minimum.maximumEligibleAmount} ${selectedPlan.inputToken.symbol}`, `${minimum.minimumAmount} ${selectedPlan.inputToken.symbol} · Verified maximum ${minimum.maximumEligibleAmount} ${selectedPlan.inputToken.symbol}`)
        : minimum?.status === 'no_break_even' ? t("검증된 금액 범위에서 손익분기에 도달하지 않습니다.", "Break-even is not reached within the verified amount range.")
          : t("현재 자료로 산출 보류", "Calculation withheld with current evidence")}</p>
      <p>{agentRequest ? t("에이전트 계획은 관측 잔액으로 운용액이 제한될 수 있어 최소액을 별도로 확정하지 않았습니다.", "Agent plans may be capped by the observed balance, so no separate minimum amount has been confirmed.")
        : minimum?.reason === 'fixed_cost_range_unverified' ? t("금액별 고정 왕복 비용의 적용 범위가 확인되지 않았습니다.", "The applicable amount range for fixed round-trip costs is unverified.")
        : minimum?.reason === 'rate_unavailable' ? t("기본 금리가 확인되지 않았습니다.", "The base rate is unverified.")
          : minimum?.reason === 'cost_or_conversion_unverified' ? t("왕복 비용 또는 자산 전환 근거가 부족합니다.", "Round-trip cost or asset-conversion evidence is insufficient.")
            : t("새 입력·견적과 비용 근거가 검증되어야 최소액을 제시할 수 있습니다.", "New inputs, quotes, and cost evidence must be verified before a minimum can be presented.")}</p></div>}
    {record && <div className="surface review-summary"><h3>{t("실행 기록", "Execution records")}</h3><p>{t("상태 ", "Status ")}{record.status}{t(" · 원 거래 ID ", " · Original transaction ID ")}{record.txId ?? t("없음", "None")}</p><p>{t("실제 수수료: ", "Actual fee: ")}{reviewed.value?.actualFee ?? t("미확인", "Unverified")} {selectedPlan?.inputToken.symbol ?? ''}</p></div>}
    {withdrawal && <div className="surface review-summary"><h3>{t("Nile 환매 기록", "Nile redemption records")}</h3><p>{t("상태 ", "Status ")}{withdrawal.status}{t(" · 원 환매 거래 ID ", " · Original redemption transaction ID ")}{withdrawal.txId ?? t("없음", "None")}</p><p>{t("확정 영수증과 실제 수령 TRX는 원 거래 및 같은 포지션 관측을 기준으로 별도 확인합니다.", "The confirmed receipt and actual TRX received are verified separately against the original transaction and observations of the same position.")}</p></div>}
    {record?.status === 'confirmed' && <div className="surface review-summary"><h3>{t("성과 증거 수집 상태", "Performance evidence status")}</h3>
      <p>{t("예치 전 관측 ", "Pre-deposit observation ")}{opening ? t("보존됨", "Saved") : t("없음", "None")}{t(" · 검증된 포지션 현금흐름 ", " · Verified position cash flows ")}{matchingFlows.length}{t("건 · 전체 조회 범위 ", " entries · Full coverage ")}{coverage ? t("확인됨", "Verified") : t("미확인", "Unverified")}</p>
      {evidenceGaps.map(reason => <p key={reason}>{reason}</p>)}
    </div>}
    {reviewed.value && <div className="surface review-summary"><h3>{statusText[reviewed.value.status]}</h3>
      <p>{t("동일 포지션 현재 가치: ", "Current value of the same position: ")}{reviewed.value.observedValue ?? t("미확인", "Unverified")} {reviewed.value.observedAsset.symbol}</p>
      <p>{t("실제 투자 손익: ", "Actual investment profit/loss: ")}{reviewed.value.actualNetChange === null ? t("필수 포지션 증거가 완전하지 않아 산출 보류", "Calculation withheld because required position evidence is incomplete") : `${reviewed.value.actualNetChange} ${reviewed.value.expectedAsset.symbol}`}</p>
      <p>{t("원 계획 대비 차이: ", "Variance from the original plan: ")}{reviewed.value.varianceFromExpected === null ? t("비교 보류", "Comparison withheld") : `${reviewed.value.varianceFromExpected} ${reviewed.value.expectedAsset.symbol}`}</p>
      {reviewed.value.observedSource && <p>{t("관측 출처 ", "Observation source ")}<a href={reviewed.value.observedSource.sourceUrl} target="_blank" rel="noreferrer">{reviewed.value.observedSource.sourceUrl}</a> · {reviewed.value.observedAt} · {reviewed.value.observedMode}</p>}
      {reviewed.value.reasons.length > 0 && <p>{t("보류 근거: ", "Reasons for hold: ")}{reviewed.value.reasons.join(' · ')}</p>}
    </div>}
    {reviewed.error && <div className="market-state error" role="alert">{displayMessage(reviewed.error)}</div>}
    {adjustment.value && <div className="surface review-summary"><h3>{t("조건 변경에 따른 조정 초안", "Draft adjustment for changed inputs")}</h3><p>{adjustment.value.direction === 'none' ? t("배분액 유지", "Maintain allocation") : adjustment.value.direction === 'deposit' ? t("추가 예치 검토", "Consider additional deposit") : t("인출 검토", "Consider withdrawal")}{t(" · 차이 ", " · Difference ")}{adjustment.value.amountFromOriginalAllocation} {selectedPlan?.inputToken.symbol}</p><p>{t("추가 비용 ", "Additional cost ")}{adjustment.value.estimatedAdditionalCost ?? t("미확인", "Unverified")}{t(" · 새 입력 확인과 포지션 재조회 후 다시 판단해야 합니다. 이 초안은 거래를 실행하지 않습니다.", " · Reassess after confirming new inputs and refreshing the position. This draft does not execute transactions.")}</p></div>}
    {adjustment.error && <div className="market-state error" role="alert">{t("조정안 계산 보류: ", "Adjustment calculation withheld: ")}{displayMessage(adjustment.error)}</div>}
  </section>;
}
