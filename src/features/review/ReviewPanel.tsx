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

const statusText = {
  not_executed: '거래 전', unconfirmed: '원 거래 확인 중', awaiting_observation: '포지션 조회 대기',
  non_live_observation: '현재 실관측 아님', observed: '포지션 관측됨', comparable: '계획 대비 비교 가능',
};
const allocationProductText: Record<NonNullable<DatedAllocation['legs'][number]['product']>, string> = {
  justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
};
function allocationPath(product: DatedAllocation['legs'][number]['product']): string {
  return product ? allocationProductText[product] : '보유';
}

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
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : '기록 검증 실패' }; }
  }, [selectedPlan, record, observation, opening, positionFlows, flowCoverages]);
  const evidenceGaps = record?.status === 'confirmed' ? [
    !opening && '예치 전 같은 포지션의 실관측이 없습니다.',
    !matchingFlows.some(item => item.kind === 'deposit' && item.txId === record.txId)
      && '확정된 예치 투입액·수수료 현금흐름이 없습니다.',
    withdrawal?.status === 'confirmed' && !matchingFlows.some(item => item.kind === 'withdraw' && item.txId === withdrawal.txId)
      && '환매 영수증에서 실제 수령 TRX가 검증되지 않아 환매 현금흐름을 만들 수 없습니다.',
    !coverage && '포지션 기간 전체의 현금흐름 조회 범위가 검증되지 않았습니다.',
  ].filter((reason): reason is string => typeof reason === 'string') : [];
  const adjustment = useMemo(() => {
    if (monitorPlan || datedAllocation || !selectedPlan || !currentNeeds || selectedPlan.chain !== currentNeeds.chain
      || currentNeeds.inputVersion <= selectedPlan.needsVersion) return { value: null, error: '' };
    if (agentRequest) return { value: null, error: '에이전트 입력을 다시 확인한 뒤 새 평가 결과를 비교해 주세요.' };
    if (!monitor.read) return { value: null, error: '최신 상품 견적을 조회한 뒤 조정액을 계산합니다.' };
    const remaining = remainingMonitorNeeds(currentNeeds, new Date());
    if (!remaining) return { value: null, error: '도래한 지출 또는 종료일을 확인한 뒤 새 계획을 계산해 주세요.' };
    try { return { value: proposeAdjustment({ originalPlan: selectedPlan,
      changedNeeds: remaining, newQuote: monitor.read.latestPlan?.quote ?? null }), error: '' }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : '조정 계산 불가' }; }
  }, [selectedPlan, monitorPlan, datedAllocation, currentNeeds, agentRequest, monitor.read]);
  const minimum = useMemo(() => {
    if (monitorPlan || datedAllocation || !selectedPlan || agentRequest || !currentNeeds || currentNeeds.inputVersion !== selectedPlan.needsVersion ||
        currentNeeds.chain !== selectedPlan.chain || !monitor.read?.latestPlan?.quote) return null;
    const remaining = remainingMonitorNeeds(currentNeeds, new Date());
    const latest = monitor.read.latestPlan;
    if (!remaining || !latest.source || !isCurrentLiveSource(latest.source, latest.chain, new Date(), 15 * 60 * 1000)) return null;
    try { return findMinimumBreakEvenAllocation({ needs: remaining, quote: latest.quote }); }
    catch { return null; }
  }, [selectedPlan, monitorPlan, datedAllocation, currentNeeds, agentRequest, monitor.read]);
  return <section className="review-panel">
    <div className="section-intro"><div><p className="overline">REVIEW / READ ONLY</p><h2>계획·거래·포지션 검토</h2><p>원 계획과 실제 관측의 체인·자산·계정을 확인한 뒤에만 성과를 비교합니다.</p></div><button className="refresh-button" type="button" onClick={onExport}>기록 JSON 내보내기</button></div>
    {!baselinePlan && !datedAllocation && <div className="plan-gate"><strong>선택한 계획이 없습니다.</strong><p>조건을 확인하고 계획을 선택하면 버전이 있는 원 계획을 여기에 보존합니다.</p></div>}
    {baselinePlan && <div className="surface review-summary"><h3>원 감시 계획</h3><p><strong>{baselinePlan.chain.toUpperCase()}</strong> · {baselinePlan.kind} · {baselinePlan.scenario} · {baselinePlan.eligibility.status === 'eligible' ? '조건 충족' : '실행 조건 미충족'}</p><p>운용액 {baselinePlan.allocation.invested} {baselinePlan.inputToken.symbol} · 종료일 {baselinePlan.endDate} · 입력 버전 {baselinePlan.needsVersion}</p><p>계획 ID <code>{baselinePlan.id}</code></p><p>원 계획 예상 순익: {baselinePlan.netYield === null ? '미확인' : `${baselinePlan.netYield} ${baselinePlan.inputToken.symbol}`}</p></div>}
    {selectedPlan && selectedPlan !== baselinePlan && <div className="surface review-summary"><h3>기존 거래 기록의 계획</h3><p>{selectedPlan.chain.toUpperCase()} · {selectedPlan.kind} · 계획 ID <code>{selectedPlan.id}</code></p><p>아래 실행 기록과 포지션 검토는 이 계획을 기준으로 표시합니다.</p></div>}
    {datedAllocation && <div className="surface review-summary"><h3>원 날짜별 배분안 · 읽기 전용</h3>
      <p>{datedAllocation.chain.toUpperCase()} · 총 운용 {datedAllocation.totalInvested} {datedAllocation.asset.symbol} · 보유 {datedAllocation.totalHeld} {datedAllocation.asset.symbol} · 예상 순익 {datedAllocation.expectedNetYield ?? '미확인'} {datedAllocation.asset.symbol}</p>
      <p>운용 구간 {datedAllocation.startDate} ~ {datedAllocation.endDate} · 계획 ID <code>{datedAllocation.id}</code></p>
      <div className="table-scroll"><table><thead><tr><th>용도·필요일</th><th>금액</th><th>경로</th><th>출금 요청일</th></tr></thead><tbody>
        {datedAllocation.legs.map((leg, index) => <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
          <td>{leg.purpose === 'expense' ? '예정 지출' : '운용 종료'} · {leg.dueDate}</td>
          <td>{leg.amount} {datedAllocation.asset.symbol}</td>
          <td>{allocationPath(leg.product)} · 순익 {leg.expectedNetYield ?? '미확인'}</td>
          <td>{leg.withdrawalRequestDate ?? '해당 없음'}</td>
        </tr>)}
      </tbody></table></div>
      {datedAllocation.selectedBundleQuote && <div className="agent-bundle-evidence">
        <p>원 금액별 묶음 견적 {datedAllocation.selectedBundleQuote.quoteVersion.slice(0, 12)} · {datedAllocation.selectedBundleQuote.status} · 만료 {new Date(datedAllocation.selectedBundleQuote.validUntil).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST</p>
        <p>공동 승인 {datedAllocation.selectedBundleQuote.approvalActions} · 예정 행동 {datedAllocation.selectedBundleQuote.actions.length}건 · 예상 비용 {datedAllocation.selectedBundleQuote.expectedCostUsdt ?? '미확인'} USDT · 스트레스 비용 {datedAllocation.selectedBundleQuote.stressCostUsdt ?? '미확인'} USDT</p>
        <p>수수료용 TRX 정책 예비액 {datedAllocation.selectedBundleQuote.requiredFeeTrxSun === null ? '미확인' : `${new Decimal(datedAllocation.selectedBundleQuote.requiredFeeTrxSun).div(1_000_000).toString()} TRX`} · 원 관측 TRX {datedAllocation.selectedBundleQuote.availableFeeTrxSun === null ? '미확인' : `${new Decimal(datedAllocation.selectedBundleQuote.availableFeeTrxSun).div(1_000_000).toString()} TRX`}</p>
        <p>원 예상 순익 {datedAllocation.selectedBundleQuote.scenarioNetYieldUsdt ?? '미확인'} USDT · 스트레스 순익 {datedAllocation.selectedBundleQuote.stressNetYieldUsdt ?? '미확인'} USDT. 실제 거래·회수 결과가 아닙니다.</p>
      </div>}
      <p>{datedAllocation.selectedBundleQuote ? '선택 구간의 공동 비용 시나리오와 나머지 보유액을 구분합니다.' : '각 구간은 독립적인 가상 예상 비교입니다.'} 이 배분안은 거래·서명·실행 권한을 만들지 않습니다.</p>
      {agentRequest === null && <p role="note">가상 시연 조건으로 저장한 비교안입니다. 지갑 실잔액을 연결해도 실거래 권고로 전환되지 않으며, 이 기준선의 신규 예치는 보류합니다.</p>}
    </div>}
    {(baselinePlan || datedAllocation) && <div className="surface review-summary" aria-label="목표 감시">
      <div className="goal-monitor-head"><h3>목표 감시</h3><button className="refresh-button" type="button"
        disabled={monitor.status === 'loading' || (effectiveRequest !== null && effectiveRequest.confirmedVersion !== effectiveRequest.version)}
        onClick={() => refreshRef.current()}>지금 다시 평가</button></div>
      <p>이 화면에 들어올 때와 화면을 열어 둔 동안 5분마다 시세·조건을 다시 확인합니다. 자동 거래·백그라운드 알림은 하지 않습니다.</p>
      {monitor.status === 'idle' && <p role="status">{monitorDecision?.action === 'review'
        ? `계획 재검토 · ${monitorDecision.reasons.join(' · ')}` : '최신 자료 조회를 준비하고 있습니다.'}</p>}
      {monitor.status === 'loading' && <p role="status">최신 상품·지갑 자료를 조회하고 있습니다…</p>}
      {monitor.status === 'loading' && monitorDecision?.action === 'review'
        && <p><strong>계획 재검토</strong> · {monitorDecision.reasons.join(' · ')}</p>}
      {monitor.status === 'error' && <p role="alert">재평가 실패: {monitor.error} · 최신 자료를 확인할 때까지 신규 예치를 보류합니다.</p>}
      {(monitor.status === 'ready' || monitor.status === 'error') && <p><strong>{monitor.status === 'error' && monitorDecision?.action !== 'review' ? '신규 예치 보류'
        : monitorDecision?.action === 'maintain' ? '유지'
          : monitorDecision?.action === 'review' ? '계획 재검토' : '신규 예치 보류'}</strong>
        {' · '}{monitor.status === 'error' && monitorDecision?.action !== 'review' ? '최신 데이터를 확인할 수 없습니다.' : monitorDecision?.reasons.join(' · ')}</p>}
      <p>원 예상 순익 {datedAllocation?.expectedNetYield ?? baselinePlan?.netYield ?? '미확인'} {datedAllocation?.asset.symbol ?? baselinePlan?.inputToken.symbol} · 새 예상 순익 {datedAllocation ? monitor.read?.datedAllocation?.expectedNetYield ?? '미확인' : monitor.read?.latestPlan?.netYield ?? '미확인'} {datedAllocation?.asset.symbol ?? baselinePlan?.inputToken.symbol}</p>
      {datedAllocation?.selectedBundleQuote && <p>현재 포지션: {monitor.read?.positionState === 'confirmed_jusdt' ? '지갑에서 jUSDT 보유 관측 · 예치 거래 자체는 미검증'
        : monitor.read?.positionState === 'uninvested' ? 'jUSDT 잔액 0 관측 · 신규 진입 전 조건'
          : '예치 여부 미확인 · 신규 예치 보류'}
        {' · '}현재 유동 USDT {monitor.read?.wallet?.balance ?? '미확인'}
        {' · '}수수료용 TRX {monitor.read?.feeTrxAmount ?? '미확인'}</p>}
      {datedAllocation?.selectedBundleQuote && monitor.read?.positionState === 'confirmed_jusdt'
        && <p>예치 후에는 원래 운용액이 유동 USDT로 남아 있다고 가정하지 않습니다. 현재 jUSDT 환매 성공과 비용을 확인할 때까지 추가 예치를 보류합니다.</p>}
      <p>재평가 시각 {monitor.read ? new Date(monitor.read.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' KST' : '미조회'}
        {' · '}자료 {monitor.read?.dataMode === 'live' ? '실데이터' : monitor.read?.dataMode === 'mixed_or_unavailable' ? '혼합 또는 미확인' : '상품별 근거 확인 필요'}</p>
      {monitor.read?.latestPlan && <p>새 계획의 남은 운용 기간: {monitor.read.latestPlan.startDate} ~ {monitor.read.latestPlan.endDate} ({monitor.read.latestPlan.days}일). 위 새 예상 순익은 이 남은 기간 기준입니다.</p>}
      {datedAllocation && monitor.read?.datedAllocation && <p>새 날짜별 배분의 남은 운용 기간: {monitor.read.datedAllocation.startDate} ~ {monitor.read.datedAllocation.endDate}. 위 새 예상 순익은 이 남은 기간 기준입니다.</p>}
      {datedAllocation?.selectedBundleQuote && monitor.read?.datedAllocation?.selectedBundleQuote && <p>새 묶음 견적 {monitor.read.datedAllocation.selectedBundleQuote.quoteVersion.slice(0, 12)} · {monitor.read.datedAllocation.selectedBundleQuote.status} · 만료 {new Date(monitor.read.datedAllocation.selectedBundleQuote.validUntil).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST · 스트레스 순익 {monitor.read.datedAllocation.selectedBundleQuote.stressNetYieldUsdt ?? '미확인'} USDT</p>}
      {datedAllocation && monitor.read?.datedAllocation && <div className="table-scroll"><table><thead><tr><th>필요일</th><th>원 경로</th><th>새 경로</th><th>새 자료</th></tr></thead><tbody>
        {datedAllocation.legs.map((leg, index) => {
          const fresh = monitor.read?.datedAllocation?.legs.find(item => item.purpose === leg.purpose && item.dueDate === leg.dueDate);
          return <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
            <td>{leg.purpose === 'expense' ? '지출' : '종료'} · {leg.dueDate}</td>
            <td>{allocationPath(leg.product)} · {leg.invested} {datedAllocation.asset.symbol}</td>
            <td>{fresh ? `${allocationPath(fresh.product)} · ${fresh.invested} ${datedAllocation.asset.symbol}` : '조회되지 않음'}</td>
            <td>{fresh?.source ? <><a href={fresh.source.sourceUrl} target="_blank" rel="noreferrer">출처</a> · {fresh.source.mode} · {new Date(fresh.source.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST</>
              : fresh?.eligibility === 'held' ? '보유' : fresh?.eligibility === 'unverified' ? '근거 미확인' : '미확인'}</td>
          </tr>;
        })}
      </tbody></table></div>}
      {monitor.read?.latestPlan?.source && <p>상품 출처 <a href={monitor.read.latestPlan.source.sourceUrl} target="_blank" rel="noreferrer">{monitor.read.latestPlan.source.sourceUrl}</a>
        {' · '}조회 {new Date(monitor.read.latestPlan.source.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST
        {' · '}원천 갱신 {monitor.read.latestPlan.source.sourceUpdatedAt ?? '미제공'}
        {' · '}{monitor.read.latestPlan.source.mode}</p>}
      <p>지갑 실잔액 {monitor.read?.wallet?.balance ?? '미확인'} {datedAllocation?.asset.symbol ?? baselinePlan?.inputToken.symbol}
        {monitor.read?.wallet?.balanceSource && <> · RPC 조회 {new Date(monitor.read.wallet.balanceSource.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST</>}
        {monitor.read?.walletIssue ? ' · 조회 문제 있음' : ''}</p>
      {monitor.status === 'ready' && monitorDecision?.action !== 'maintain' && blockers.length > 0
        && <div className="source-diagnostics" aria-label="보류 근거 및 다음 단계"><h3>보류 근거와 확인 방법</h3>
          {blockers.map(item => <p key={item.key}>{item.message}</p>)}
        </div>}
      <p>이 판단은 읽기 전용 비교입니다. 포지션 가치와 실제 수익은 아래의 확정 거래·관측 증거로 따로 검증합니다.</p>
    </div>}
    {selectedPlan && !record && <div className="surface review-summary"><h3>실행 기록</h3><p>이 계획의 확정된 원 거래 ID가 없습니다. 예상 수익을 실제 성과로 표시하지 않습니다.</p></div>}
    {selectedPlan && !monitorPlan && !datedAllocation && <div className="surface review-summary"><h3>손익분기 최소 운용액</h3>
      <p>{minimum?.status === 'found' ? `${minimum.minimumAmount} ${selectedPlan.inputToken.symbol} · 검증 범위 최대 ${minimum.maximumEligibleAmount} ${selectedPlan.inputToken.symbol}`
        : minimum?.status === 'no_break_even' ? '검증된 금액 범위에서 손익분기에 도달하지 않습니다.'
          : '현재 자료로 산출 보류'}</p>
      <p>{agentRequest ? '에이전트 계획은 관측 잔액으로 운용액이 제한될 수 있어 최소액을 별도로 확정하지 않았습니다.'
        : minimum?.reason === 'fixed_cost_range_unverified' ? '금액별 고정 왕복 비용의 적용 범위가 확인되지 않았습니다.'
        : minimum?.reason === 'rate_unavailable' ? '기본 금리가 확인되지 않았습니다.'
          : minimum?.reason === 'cost_or_conversion_unverified' ? '왕복 비용 또는 자산 전환 근거가 부족합니다.'
            : '새 입력·견적과 비용 근거가 검증되어야 최소액을 제시할 수 있습니다.'}</p></div>}
    {record && <div className="surface review-summary"><h3>실행 기록</h3><p>상태 {record.status} · 원 거래 ID {record.txId ?? '없음'}</p><p>실제 수수료: {reviewed.value?.actualFee ?? '미확인'} {selectedPlan?.inputToken.symbol ?? ''}</p></div>}
    {withdrawal && <div className="surface review-summary"><h3>Nile 환매 기록</h3><p>상태 {withdrawal.status} · 원 환매 거래 ID {withdrawal.txId ?? '없음'}</p><p>확정 영수증과 실제 수령 TRX는 원 거래 및 같은 포지션 관측을 기준으로 별도 확인합니다.</p></div>}
    {record?.status === 'confirmed' && <div className="surface review-summary"><h3>성과 증거 수집 상태</h3>
      <p>예치 전 관측 {opening ? '보존됨' : '없음'} · 검증된 포지션 현금흐름 {matchingFlows.length}건 · 전체 조회 범위 {coverage ? '확인됨' : '미확인'}</p>
      {evidenceGaps.map(reason => <p key={reason}>{reason}</p>)}
    </div>}
    {reviewed.value && <div className="surface review-summary"><h3>{statusText[reviewed.value.status]}</h3>
      <p>동일 포지션 현재 가치: {reviewed.value.observedValue ?? '미확인'} {reviewed.value.observedAsset.symbol}</p>
      <p>실제 투자 손익: {reviewed.value.actualNetChange === null ? '필수 포지션 증거가 완전하지 않아 산출 보류' : `${reviewed.value.actualNetChange} ${reviewed.value.expectedAsset.symbol}`}</p>
      <p>원 계획 대비 차이: {reviewed.value.varianceFromExpected === null ? '비교 보류' : `${reviewed.value.varianceFromExpected} ${reviewed.value.expectedAsset.symbol}`}</p>
      {reviewed.value.observedSource && <p>관측 출처 <a href={reviewed.value.observedSource.sourceUrl} target="_blank" rel="noreferrer">{reviewed.value.observedSource.sourceUrl}</a> · {reviewed.value.observedAt} · {reviewed.value.observedMode}</p>}
      {reviewed.value.reasons.length > 0 && <p>보류 근거: {reviewed.value.reasons.join(' · ')}</p>}
    </div>}
    {reviewed.error && <div className="market-state error" role="alert">{reviewed.error}</div>}
    {adjustment.value && <div className="surface review-summary"><h3>조건 변경에 따른 조정 초안</h3><p>{adjustment.value.direction === 'none' ? '배분액 유지' : adjustment.value.direction === 'deposit' ? '추가 예치 검토' : '인출 검토'} · 차이 {adjustment.value.amountFromOriginalAllocation} {selectedPlan?.inputToken.symbol}</p><p>추가 비용 {adjustment.value.estimatedAdditionalCost ?? '미확인'} · 새 입력 확인과 포지션 재조회 후 다시 판단해야 합니다. 이 초안은 거래를 실행하지 않습니다.</p></div>}
    {adjustment.error && <div className="market-state error" role="alert">조정안 계산 보류: {adjustment.error}</div>}
  </section>;
}
