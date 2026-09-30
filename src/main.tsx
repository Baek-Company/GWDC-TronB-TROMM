import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DecimalBase from 'decimal.js';
import { ArrowRight, CalendarBlank, CaretLeft, CaretRight, ChartPieSlice, Coins, UserCircle, Wallet } from '@phosphor-icons/react';
import type { MarketSnapshot } from '../shared/markets';
import { calculateLiquidity } from '../shared/planning';
import { isCurrentInstant } from '../shared/provenance';
import { toUserNeeds, type AgentRequestState } from '../shared/agent-request';
import { positionFlowSchema, type DatedAllocation, type ExecutionRecord, type Observation,
  type Plan, type PositionFlow } from '../shared/schemas';
import type { Assessment } from '../server/agent/assessment';
import { connectWallet, getWalletState, watchWallet } from './wallet';
import { backupInvalidSession, exportInvalidSession, exportSession, initialProfile, initialSession,
  loadSession, parseSession, saveSession, type Profile } from './lib/session';
import { profileToNeeds } from './lib/needs';
import { confirmedNileDepositFlow } from './lib/review-evidence';
import booksPlant from './assets/books-plant.webp';
import mug from './assets/mug.webp';
import './style.css';
import './overview.css';

const Decimal = DecimalBase.clone({ precision: 128 });
const AgentPanel = React.lazy(() => import('./features/agent/AgentPanel').then(module => ({ default: module.AgentPanel })));
const CalculationBasis = React.lazy(() => import('./features/needs/CalculationBasis').then(module => ({ default: module.CalculationBasis })));
const UsdtExpectedResult = React.lazy(() => import('./features/demo/UsdtExpectedResult').then(module => ({ default: module.UsdtExpectedResult })));
const PlanExplorer = React.lazy(() => import('./features/plans/PlanExplorer').then(module => ({ default: module.PlanExplorer })));
const FundingPanel = React.lazy(() => import('./features/plans/FundingPanel').then(module => ({ default: module.FundingPanel })));
const NileWorkflow = React.lazy(() => import('./features/execution/NileWorkflow').then(module => ({ default: module.NileWorkflow })));
const NilePsmPanel = React.lazy(() => import('./features/psm/NilePsmPanel').then(module => ({ default: module.NilePsmPanel })));
const SourcesPanel = React.lazy(() => import('./features/sources/SourcesPanel').then(module => ({ default: module.SourcesPanel })));
const ReviewPanel = React.lazy(() => import('./features/review/ReviewPanel').then(module => ({ default: module.ReviewPanel })));
const ReplayPanel = React.lazy(() => import('./features/review/ReplayPanel').then(module => ({ default: module.ReplayPanel })));

type NileStatus = { block: number; blockTime: string; fetchedAt: string; source: string; network: 'nile' };
type Route = '/' | '/usdt-demo' | '/needs' | '/plans' | '/markets' | '/nile' | '/review' | '/connections';

const routeTitles: Record<Route, string> = {
  '/': 'Nile 시연', '/usdt-demo': 'USDT 예상 개요', '/needs': 'USDT 요구 분석', '/plans': 'USDT 가정 계산',
  '/markets': 'Mainnet 시장 데이터', '/nile': 'Nile 시연', '/review': '목표 감시·기록 검토', '/connections': '연결 상태',
};
const routes = Object.keys(routeTitles) as Route[];

function currentRoute(): Route {
  const path = window.location.pathname;
  if (routes.includes(path as Route)) {
    const legacyHash = `/${window.location.hash.slice(1)}`;
    return path === '/' && routes.includes(legacyHash as Route) ? legacyHash as Route : path as Route;
  }
  return '/';
}

function money(value: string, places = 2) {
  const [whole, fraction] = new Decimal(value).toFixed(places).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
function exactMoney(value: string) {
  const [whole, fraction] = new Decimal(value).toFixed().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
function formatRate(value: string) {
  return new Decimal(value).times(100).toFixed(4);
}
function kst(value: string) {
  return new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function calendarDate(daysFromToday: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const number = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return new Date(Date.UTC(number('year'), number('month') - 1, number('day') + daysFromToday));
}
function calendarLabel(daysFromToday: number, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', ...options }).format(calendarDate(daysFromToday));
}
async function read<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

function App() {
  const initialRead = useRef(false);
  const initialMarketRead = useRef(false);
  const [loadedSession] = useState(loadSession);
  const [route, setRoute] = useState<Route>(currentRoute);
  const [session, setSession] = useState(loadedSession.session);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [sessionRecovery, setSessionRecovery] = useState(loadedSession.status === 'invalid' ? loadedSession : null);
  const [sessionError, setSessionError] = useState('');
  const profile = session.profile;
  const [snapshot, setSnapshot] = useState<MarketSnapshot>();
  const [marketError, setMarketError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nile, setNile] = useState<NileStatus>();
  const [nileError, setNileError] = useState('');
  const [wallet, setWallet] = useState(getWalletState);
  const [walletMessage, setWalletMessage] = useState('연결은 주소 조회입니다. Nile 시험 거래는 별도 미리보기와 확인 후에만 서명합니다.');
  const [marketQuery, setMarketQuery] = useState('');
  const [calendarPage, setCalendarPage] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (sessionRecovery) return;
    try { saveSession(session); setSessionError(''); }
    catch { setSessionError('현재 변경 내용을 브라우저에 저장하지 못했습니다. 아래에서 JSON을 내보내 보관해 주세요.'); }
  }, [session, sessionRecovery]);

  const startFreshSession = () => {
    try {
      backupInvalidSession(sessionRecovery?.raw ?? null);
      const fresh = initialSession();
      saveSession(fresh);
      setSession(fresh);
      setSessionRecovery(null);
      setSessionError('');
    } catch {
      setSessionError('원본 백업 또는 새 세션 저장에 실패했습니다. 먼저 원본 JSON을 내려받고 브라우저 저장 공간을 확인해 주세요.');
    }
  };
  const importSession = async (file: File | undefined) => {
    if (!file) return;
    try {
      const restored = parseSession(await file.text());
      backupInvalidSession(sessionRecovery?.raw ?? null);
      saveSession(restored);
      setSession(restored);
      setSessionRecovery(null);
      setSessionError('');
    } catch {
      setSessionError('복구 파일이 현재 세션 형식에 맞지 않거나 저장에 실패했습니다. 원본 세션은 유지했습니다.');
    }
  };

  useEffect(() => {
    if (window.location.pathname !== route || window.location.hash) {
      window.history.replaceState(null, '', route);
    }
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    document.title = `${routeTitles[route]} · GWDC TRON 자산 계획`;
  }, [route]);
  useEffect(() => {
    if (route !== '/' && route !== '/nile' && route !== '/connections' && route !== '/markets') return;
    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 30_000);
    window.addEventListener('focus', updateNow);
    document.addEventListener('visibilitychange', updateNow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', updateNow);
      document.removeEventListener('visibilitychange', updateNow);
    };
  }, [route]);
  useEffect(() => {
    if (/^\d+$/.test(profile.expenseDay)) {
      const day = Number(profile.expenseDay);
      if (day >= 1 && day <= 3650) setCalendarPage(Math.floor((day - 1) / 7));
    }
  }, [profile.expenseDay]);

  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, next: Route) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (next !== route) {
      window.history.pushState(null, '', next);
      setRoute(next);
    }
    window.scrollTo(0, 0);
  };

  const updateProfile = (field: keyof Profile, value: string) => {
    setSession(current => ({ ...current, profile: { ...current.profile, [field]: value },
      inputVersion: current.inputVersion + 1, confirmedVersion: null }));
  };
  const updateExtraExpense = (id: string, field: 'amount' | 'day', value: string) => {
    setSession(current => ({ ...current,
      profile: { ...current.profile, extraExpenses: current.profile.extraExpenses.map(expense => expense.id === id ? { ...expense, [field]: value } : expense) },
      inputVersion: current.inputVersion + 1, confirmedVersion: null,
    }));
  };
  const confirmNeeds = () => {
    if (!planning.result) return;
    setSession(current => ({ ...current, confirmedVersion: current.inputVersion }));
  };
  const refreshMarkets = async () => {
    setLoading(true);
    setMarketError('');
    setSnapshot(undefined);
    try { setSnapshot(await read<MarketSnapshot>('/api/markets')); }
    catch (error) { setMarketError(error instanceof Error ? error.message : '시장 조회에 실패했습니다.'); }
    finally { setLoading(false); }
  };
  const refreshNile = async () => {
    setNile(undefined);
    setNileError('');
    try { setNile(await read<NileStatus>('/api/nile')); }
    catch (error) { setNileError(error instanceof Error ? error.message : 'Nile RPC 연결 실패'); }
  };
  useEffect(() => {
    if ((route === '/' || route === '/nile' || route === '/connections') && !initialRead.current) {
      initialRead.current = true;
      void refreshNile();
    }
    if (route === '/markets' && !initialMarketRead.current) {
      initialMarketRead.current = true;
      void refreshMarkets();
    }
  }, [route]);
  useEffect(() => watchWallet(() => setWallet(getWalletState())), []);
  const connect = async () => {
    try {
      setWallet(await connectWallet());
      setWalletMessage('주소 연결을 확인했습니다. Nile 거래는 별도 미리보기와 사용자님 확인이 필요합니다.');
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : '지갑 연결이 취소되었습니다.');
    }
  };

  const planning = (() => {
    try {
      const needs = profileToNeeds(profile, session.inputVersion, session.confirmedVersion, snapshot);
      const liquidity = calculateLiquidity(needs);
      return { needs, result: { ...liquidity,
        dueWithinHorizon: liquidity.dueExpenses.length > 0 }, error: '' };
    } catch (error) {
      return { needs: null, result: undefined, error: error instanceof Error ? error.message : '입력값을 확인해 주세요.' };
    }
  })();
  const monitorPlan = session.monitoredAgent?.plan ?? null;
  const monitoredRequest = session.monitoredAllocation?.request ?? session.monitoredAgent?.request ?? null;
  const latestAgentRequest = session.latestAgentRequest ?? monitoredRequest;
  const reviewNeeds = monitoredRequest ? (() => {
    try {
      const token = session.monitoredAllocation?.allocation.asset ?? session.monitoredAgent?.plan.inputToken;
      return latestAgentRequest && token ? toUserNeeds(latestAgentRequest, token) : null;
    }
    catch { return null; }
  })() : planning.needs;
  const investable = planning.result?.investableAmount;
  const visibleMarkets = snapshot?.markets.filter(market =>
    `${market.underlyingSymbol} ${market.symbol}`.toLowerCase().includes(marketQuery.trim().toLowerCase())) || [];
  const now = new Date(nowMs);
  const marketRecentlyFetched = snapshot ? isCurrentInstant(snapshot.fetchedAt, now, 5 * 60_000) : false;
  const nileRecentlyFetched = nile ? isCurrentInstant(nile.fetchedAt, now, 60_000) : false;
  const nileBlockRecent = nile ? isCurrentInstant(nile.blockTime, now, 5 * 60_000) : false;
  const nileCurrent = nileRecentlyFetched && nileBlockRecent;
  const holdings = planning.result ? new Decimal(profile.holdings) : undefined;
  const investedPercent = holdings && holdings.gt(0)
    ? new Decimal(investable || '0').div(holdings).times(100).toFixed(2)
    : '0';
  const firstCalendarDay = calendarPage * 7 + 1;
  const calendarDays = Array.from({ length: 7 }, (_, index) => firstCalendarDay + index);
  const protectedAmount = planning.result?.protectedAmount;
  const hasReserve = /^\d+(\.\d+)?$/.test(profile.reserve) && new Decimal(profile.reserve).gt(0);
  const protectionTitle = hasReserve ? '지출·여유 확보' : '지출 확보';
  const protectionDescription = planning.result?.dueWithinHorizon === false
    ? '운용 기간 이후의 지출도 지금부터 확보해 둡니다.'
    : hasReserve ? '예정 지출과 추가 여유액을 합친 금액입니다.' : '예정 지출을 위해 확보한 금액입니다.';
  const confirmed = session.confirmedVersion === session.inputVersion;
  const nileHome = route === '/' || route === '/nile';
  const latestNileRecord = session.records.filter(record => record.chain === 'nile')
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  const nileConfirmedFlows = session.positionFlows.filter(flow => flow.chain === 'nile').length;
  const verifiedNileDepositFlow = (() => {
    const plan = session.selectedPlan;
    if (plan?.chain !== 'nile') return null;
    for (const record of session.records) {
      if (record.action !== 'deposit' || record.planId !== plan.id) continue;
      const opening = session.openingObservations.find(item => item.recordId === record.id)?.observation ?? null;
      for (const observation of session.observations) {
        const flow = confirmedNileDepositFlow(plan, record, opening, observation);
        if (flow) return flow;
      }
    }
    return null;
  })();
  const routeMode = nileHome ? ['Nile 기술 시연', 'Nile 테스트넷']
    : route === '/markets' ? ['시장 조회', 'Mainnet 시장']
      : route === '/connections' ? ['연결 확인', '지갑·Nile 상태']
        : route === '/review' ? ['기록 검토', '체인별 근거']
          : route === '/needs' ? ['요구 분석', '체인별 입력']
          : ['가정 시연', 'USDT 예상'];
  const onAgentRequestChange = useCallback((request: AgentRequestState) => {
    setSession(current => current.latestAgentRequest
      && JSON.stringify(current.latestAgentRequest) === JSON.stringify(request)
      ? current : { ...current, latestAgentRequest: request });
  }, []);
  const onAgentSelectPlan = (plan: Plan, request: AgentRequestState, assessment: Assessment) => {
    if (request.confirmedVersion !== request.version || assessment.inputVersion !== request.version
      || assessment.confirmedVersion !== request.version || plan.needsVersion !== request.version
      || assessment.chain !== plan.chain || assessment.plans.every(item => item.id !== plan.id)
      || assessment.walletAddress !== (wallet.networkKey === plan.chain ? wallet.address : null)) return;
    try { toUserNeeds(request, plan.inputToken); }
    catch { return; }
    setSession(current => ({ ...current, latestAgentRequest: request,
      monitoredAllocation: null,
      monitoredAgent: { plan, request, assessmentId: assessment.assessmentId,
        selectedAt: new Date().toISOString(), walletAddress: assessment.walletAddress } }));
  };
  const onAgentSelectDatedAllocation = (allocation: DatedAllocation, request: AgentRequestState,
    assessment: Assessment) => {
    if (request.confirmedVersion !== request.version || assessment.inputVersion !== request.version
      || assessment.confirmedVersion !== request.version || allocation.inputVersion !== request.version
      || allocation.chain !== assessment.chain || assessment.datedAllocation?.id !== allocation.id
      || assessment.walletAddress !== (wallet.networkKey === allocation.chain ? wallet.address : null)) return;
    try { toUserNeeds(request, allocation.asset); }
    catch { return; }
    setSession(current => ({ ...current, latestAgentRequest: request, monitoredAgent: null,
      monitoredAllocation: { allocation, request, assessmentId: assessment.assessmentId,
        selectedAt: new Date().toISOString(), walletAddress: assessment.walletAddress } }));
  };
  const persistNileEvidence = (update: (current: typeof session) => typeof session) => {
    if (sessionRecovery) throw new Error('저장된 세션을 복구한 뒤 Nile 거래를 진행해 주세요.');
    const next = update(sessionRef.current);
    saveSession(next);
    sessionRef.current = next;
    setSession(next);
  };
  const verifiedDepositFlow = (current: typeof session, record: ExecutionRecord, closing: Observation) => {
    if (current.selectedPlan?.id !== record.planId) return null;
    const opening = current.openingObservations.find(item => item.recordId === record.id)?.observation ?? null;
    return confirmedNileDepositFlow(current.selectedPlan, record, opening, closing);
  };
  const recordNileTransaction = (record: ExecutionRecord) => {
    persistNileEvidence(current => {
      const flow = current.observations.map(observation => verifiedDepositFlow(current, record, observation))
        .find(item => item !== null) ?? null;
      return { ...current,
        records: [...current.records.filter(item => item.id !== record.id), record],
        positionFlows: flow
          ? [...current.positionFlows.filter(item => item.id !== flow.id), flow] : current.positionFlows,
      };
    });
  };
  const recordOpeningObservation = (observation: Observation, record: ExecutionRecord) => {
    if (record.action !== 'deposit' || record.planId !== observation.planId ||
      record.walletAddress !== observation.walletAddress || record.chain !== observation.chain ||
      observation.source.mode !== 'live') throw new Error('예치 전 같은 포지션의 실관측이 아닙니다.');
    persistNileEvidence(current => ({ ...current,
      openingObservations: [...current.openingObservations.filter(item => item.recordId !== record.id),
        { recordId: record.id, observation }],
    }));
  };
  const recordNileObservation = (observation: Observation) => {
    persistNileEvidence(current => {
      const flow = current.records.map(record => verifiedDepositFlow(current, record, observation))
        .find(item => item !== null) ?? null;
      return { ...current,
        observations: [...current.observations.filter(item => item.id !== observation.id), observation],
        positionFlows: flow
          ? [...current.positionFlows.filter(item => item.id !== flow.id), flow] : current.positionFlows,
      };
    });
  };
  const recordNileWithdrawalFlow = (rawFlow: PositionFlow) => {
    const flow = positionFlowSchema.parse(rawFlow);
    persistNileEvidence(current => {
      const withdrawal = current.records.find(record => record.action === 'withdraw' &&
        record.status === 'confirmed' && record.txId === flow.txId && record.planId === flow.planId &&
        record.walletAddress === flow.walletAddress && record.chain === flow.chain);
      if (!withdrawal || flow.kind !== 'withdraw' ||
          flow.positionId !== `nile:${withdrawal.walletAddress}:${withdrawal.contractAddress}`) {
        throw new Error('확정된 원 환매 거래와 TRX 실수령 근거가 일치하지 않습니다.');
      }
      return { ...current, positionFlows: [...current.positionFlows.filter(item => item.id !== flow.id), flow] };
    });
  };

  return <div className={`app-shell${route === '/usdt-demo' ? ' dayplan-shell' : ''}`}>
    <main className="main-content">
      <header className="dayplan-topbar">
        <a className="dayplan-brand" href="/" onClick={event => navigate(event, '/')} aria-label="GWDC 홈"><strong>G<span>W</span>DC</strong><small>TRON과 함께, 더 나은 내일의 자산 계획</small></a>
        <nav className="dayplan-topnav" aria-label="주요 메뉴">
          <a className={nileHome ? 'active' : ''} aria-current={nileHome ? 'page' : undefined} href="/" onClick={event => navigate(event, '/')}>Nile 시연</a>
          <a className={route === '/usdt-demo' ? 'active' : ''} aria-current={route === '/usdt-demo' ? 'page' : undefined} href="/usdt-demo" onClick={event => navigate(event, '/usdt-demo')}>USDT 예상</a>
          <a className={route === '/needs' ? 'active' : ''} aria-current={route === '/needs' ? 'page' : undefined} href="/needs" onClick={event => navigate(event, '/needs')}>요구 분석</a>
          <a className={route === '/plans' ? 'active' : ''} aria-current={route === '/plans' ? 'page' : undefined} href="/plans" onClick={event => navigate(event, '/plans')}>USDT 계산</a>
          <a className={route === '/markets' ? 'active' : ''} aria-current={route === '/markets' ? 'page' : undefined} href="/markets" onClick={event => navigate(event, '/markets')}>시장 데이터</a>
          <a className={route === '/review' ? 'active' : ''} aria-current={route === '/review' ? 'page' : undefined} href="/review" onClick={event => navigate(event, '/review')}>기록 검토</a>
        </nav>
        <div className="dayplan-topbar-right"><span className="dayplan-demo-chip">{routeMode[0]}</span><span className="dayplan-read-chip">{routeMode[1]}</span><a className={route === '/connections' ? 'active' : ''} aria-current={route === '/connections' ? 'page' : undefined} href="/connections" onClick={event => navigate(event, '/connections')} aria-label="연결 상태"><UserCircle size={25} weight="light" /></a></div>
      </header>

      <div className="page-content">
        {sessionRecovery && <section className="surface session-alert" role="alert" aria-label="저장된 세션 복구">
          <strong>저장된 계획을 읽지 못했습니다.</strong>
          <p>손상되었거나 지원하지 않는 세션 형식일 수 있습니다. 원본은 그대로 보존되어 있습니다. 원본을 내보내거나 정상 백업 JSON을 가져온 뒤 복구해 주세요. 새 세션을 시작하면 원본은 별도 브라우저 백업 키에 저장합니다.</p>
          <div>{sessionRecovery.raw !== null && <button type="button" onClick={() => exportInvalidSession(sessionRecovery.raw!)}>원본 JSON 내보내기</button>}
            <label>정상 세션 JSON 가져오기 <input type="file" accept=".json,application/json" onChange={event => void importSession(event.target.files?.[0])} /></label>
            <button type="button" onClick={startFreshSession}>새 세션 시작</button>
          </div>
        </section>}
        {sessionError && <section className="surface session-alert" role="alert"><strong>세션 저장 오류</strong><p>{sessionError}</p><button type="button" onClick={() => exportSession(session)}>현재 세션 JSON 내보내기</button></section>}
        <React.Suspense fallback={<div className="market-state" role="status">화면을 여는 중입니다…</div>}>
        {nileHome && <>
        <section className="nile-home-hero" aria-labelledby="nile-home-title">
          <div className="nile-home-copy">
            <p className="nile-home-kicker">NILE TESTNET · TRX / jTRX · PSM USDD / USDT</p>
            <h1 id="nile-home-title">테스트 자산으로<br /><span>계획부터 거래 기록까지</span></h1>
            <p>Nile 테스트넷에서 TRX·jTRX 예치·회수와 별도의 PSM USDD·USDT 교환 절차를 검증합니다. 각 거래에는 최신 미리보기, 사용자님 확인, TronLink 서명이 필요합니다.</p>
            <div className="nile-home-actions"><a className="nile-home-primary" href="#nile-workflow">시연 조건 입력 <ArrowRight size={19} /></a>
              <a className="nile-home-secondary" href="#nile-psm">PSM 시험거래 ↓</a>
              <a className="nile-home-secondary" href="/usdt-demo" onClick={event => navigate(event, '/usdt-demo')}>USDT 예상 비교 ↗</a></div>
          </div>
          <div className="nile-home-status" aria-label="Nile 시연 준비 상태">
            <div><span>지갑 네트워크</span><strong>{wallet.address && wallet.networkKey === 'nile' ? 'Nile 주소 연결됨'
              : wallet.address ? `${wallet.network} · Nile 전환 필요` : 'TronLink 연결 전'}</strong></div>
            <div><span>Nile 블록</span><strong>{nile && nileCurrent ? `#${nile.block.toLocaleString('ko-KR')} 최근 조회`
              : nile ? '이전 블록 조회 · 다시 확인 필요'
              : nileError ? '조회 실패 · 재확인 필요' : '조회 중'}</strong></div>
            <div><span>저장된 거래 근거</span><strong>{latestNileRecord
              ? `최근 기록 ${latestNileRecord.status} · 확정 흐름 ${nileConfirmedFlows}건`
              : '거래 기록 없음'}</strong></div>
            <small>기록은 이 브라우저의 저장값입니다. 확정 영수증과 실제 포지션은 아래 거래 기록에서 별도로 확인합니다.</small>
          </div>
        </section>
        <div className="nile-home-separation"><strong>USDT 예상 비교는 별도입니다.</strong>
          <p>Mainnet USDT 금액은 지갑 실잔액 검증 없이 가정 조건으로만 계산합니다. Nile TRX 시험 거래를 USDT 투자 성과나 회수 증거로 사용하지 않습니다.</p>
          <a href="/usdt-demo" onClick={event => navigate(event, '/usdt-demo')}>USDT 가정 시연 보기 ↗</a>
        </div>
        <div id="nile-workflow"><React.Suspense fallback={<div className="market-state" role="status">Nile 거래 화면을 여는 중입니다…</div>}>
          <NileWorkflow wallet={wallet} onConnect={connect} selectedPlan={session.selectedPlan}
            historicalRecords={session.records}
            positionFlows={session.positionFlows}
            verifiedDepositFlow={verifiedNileDepositFlow}
            onSelect={plan => setSession(current => ({ ...current, selectedPlan: plan, monitoredAgent: null, monitoredAllocation: null }))}
            onRestorePlan={plan => persistNileEvidence(current => ({ ...current, selectedPlan: plan }))}
            onRecord={recordNileTransaction} onOpeningObservation={recordOpeningObservation}
            onObservation={recordNileObservation} onWithdrawalFlow={recordNileWithdrawalFlow} />
        </React.Suspense></div>
        <div id="nile-psm"><React.Suspense fallback={<div className="market-state" role="status">Nile PSM 화면을 여는 중입니다…</div>}>
          <NilePsmPanel address={wallet.address ?? ''} networkKey={wallet.networkKey ?? ''} />
        </React.Suspense></div>
        </>}

        {route === '/usdt-demo' && <>
        <p className="dayplan-scenario-note" role="note">Mainnet USDT 가정 예시 · 지갑 실잔액과 거래 결과가 아닙니다.</p>
        <section className="dayplan-intro" aria-labelledby="hero-title">
          <p className="dayplan-kicker">PLAN TODAY, A BRIGHTER TOMORROW</p>
          <p className="dayplan-aside">오늘도, 계획하는 사람이<br />더 자유로운 내일을 만듭니다.</p>
          <h1 id="hero-title">지출 날짜를 먼저 <span>정해볼까요?</span></h1>
          <p className="dayplan-subtitle">미리 정한 지출이, 더 여유로운 자산 계획의 시작입니다.</p>
        </section>

        <div className="dayplan-calendar-heading"><span>예정 지출 일정</span><div className="dayplan-calendar-controls">
          <button type="button" onClick={() => setCalendarPage(page => Math.max(0, page - 1))} disabled={calendarPage === 0} aria-label="이전 7일"><CaretLeft size={20} /></button>
          <strong>{calendarLabel(firstCalendarDay, { year: 'numeric', month: 'long', day: 'numeric' })} - {calendarLabel(firstCalendarDay + 6, { month: 'long', day: 'numeric' })}</strong>
          <button type="button" onClick={() => setCalendarPage(page => Math.min(521, page + 1))} aria-label="다음 7일"><CaretRight size={20} /></button>
        </div></div>
        <section className="dayplan-calendar" aria-label="7일 지출 달력">
          {calendarDays.map(day => {
            const scheduled = [{ day: profile.expenseDay, amount: profile.expense }, ...profile.extraExpenses]
              .filter(expense => Number(expense.day) === day && /^\d+(?:\.\d+)?$/.test(expense.amount));
            const scheduledAmount = scheduled.reduce((sum, expense) => sum.plus(expense.amount), new Decimal(0));
            const isExpenseDay = scheduledAmount.gt(0) && Boolean(planning.result);
            return <article key={day} className={`dayplan-day${isExpenseDay ? ' expense-day' : ''}`}>
              <span className="dayplan-weekday">{calendarLabel(day, { weekday: 'short' })}</span>
              <span className="dayplan-date">{calendarLabel(day, { month: 'long', day: 'numeric' })}</span>
              <strong className="dayplan-number">{calendarDate(day).getUTCDate()}</strong>
              <span className="dayplan-dot" aria-hidden="true" />
              {isExpenseDay ? <a className="dayplan-expense-link" href="/needs" onClick={event => navigate(event, '/needs')} aria-label={`${exactMoney(scheduledAmount.toString())} USDT 예정 지출 조건 수정`}>
                <Wallet size={27} weight="regular" /><span><small>예정 지출</small><strong>{exactMoney(scheduledAmount.toString())} USDT</strong></span><CaretRight size={18} />
              </a> : <span className="dayplan-no-expense">예정된 지출이 없습니다.</span>}
            </article>;
          })}
        </section>

        <section className="dayplan-equation" aria-label="전 기간 운용 상한 계산">
          <div className="dayplan-equation-copy"><h2>계획된 지출이 만드는<br />더 안정적인 오늘</h2><p>지출 일정을 먼저 정하면,<br />남은 자산을 더욱 현명하게 운용할 수 있습니다.</p></div>
          <div className="dayplan-amount-card balance-card"><span className="dayplan-card-icon"><Coins size={28} weight="regular" /></span><div><h3>가상 잔액</h3><strong>{planning.result ? exactMoney(profile.holdings) : '—'} <small>USDT</small></strong><p>현재 보유한 가상의 자산입니다.</p></div></div>
          <span className="dayplan-equation-symbol" aria-hidden="true">−</span>
          <div className="dayplan-amount-card expense-card"><span className="dayplan-card-icon"><CalendarBlank size={28} weight="regular" /></span><div><h3>{protectionTitle}</h3><strong>{protectedAmount ? exactMoney(protectedAmount) : '—'} <small>USDT</small></strong><p>{protectionDescription}</p></div></div>
          <span className="dayplan-equation-symbol" aria-hidden="true">=</span>
          <div className="dayplan-amount-card invest-card"><span className="dayplan-card-icon"><ChartPieSlice size={28} weight="regular" /></span><div><h3>전 기간 운용 상한</h3><strong>{investable ? exactMoney(investable) : '—'} <small>USDT</small></strong><p>모든 예정 지출액을 따로 보유할 때의<br />가상 운용 상한입니다.</p></div></div>
        </section>

        <UsdtExpectedResult needs={planning.needs} error={planning.error} />
        <div className="dayplan-cta-area"><a className="dayplan-cta" href="/needs" onClick={event => navigate(event, '/needs')}>조건 입력하기 <ArrowRight size={24} weight="regular" /></a><p>조건을 바꿔 비용 전 이자가 어떻게 달라지는지 살펴보세요.</p></div>
        <img className="dayplan-decor dayplan-decor-left" src={booksPlant} alt="" aria-hidden="true" />
        <img className="dayplan-decor dayplan-decor-right" src={mug} alt="" aria-hidden="true" />
        <span className="dayplan-mug-copy" aria-hidden="true">Small<br />Plans<br />Big<br />Tomorrows</span>
        <p className="dayplan-handnote" aria-hidden="true">오늘의 계획이<br />내일의 여유로</p>
        <div className="dayplan-bottom-caption"><span /> GOOD WALLET, BRIGHTER DAYS <span /></div>
        </>}

        {route === '/needs' && <>
        <section className="section-intro">
          <div><p className="overline">01 / NEEDS ANALYSIS</p><h2>지출 계획부터 정리합니다</h2><p>먼저 사용자님이 말한 조건을 JSON으로 확인하고 시장을 조사합니다. 아래 수동 입력은 별도의 가상 시연입니다.</p></div>
          <span className="section-badge">읽기 전용 분석</span>
        </section>

        <AgentPanel wallet={wallet} onSelectPlan={onAgentSelectPlan}
          onSelectDatedAllocation={onAgentSelectDatedAllocation} onRequestChange={onAgentRequestChange} />

        <div className="planning-grid">
          <section className="surface input-panel" aria-label="시연 입력">
            <div className="panel-head"><div><span className="panel-step">01</span><h3>내 조건 입력</h3></div><button className="text-button" onClick={() => setSession(current => ({ ...current, profile: initialProfile, inputVersion: current.inputVersion + 1, confirmedVersion: null }))}>시연 값으로 초기화 ↺</button></div>
            <div className="form-grid">
              <label className="field wide"><span>보유 자산</span><div className="static-input"><span className="asset-symbol">₮</span><strong>USDT</strong><small>가상 잔고</small></div></label>
              <label className="field"><span>보유 금액</span><div className="field-control"><input value={profile.holdings} onChange={event => updateProfile('holdings', event.target.value)} inputMode="decimal" aria-label="보유 금액" /><b>USDT</b></div></label>
              <label className="field"><span>운용 기간</span><div className="field-control"><input value={profile.horizonDays} onChange={event => updateProfile('horizonDays', event.target.value)} inputMode="numeric" aria-label="운용 기간" /><b>일</b></div></label>
              <label className="field"><span>예정 지출액</span><div className="field-control"><input value={profile.expense} onChange={event => updateProfile('expense', event.target.value)} inputMode="decimal" aria-label="예정 지출액" /><b>USDT</b></div></label>
              <label className="field"><span>지출까지 남은 기간</span><div className="field-control"><input value={profile.expenseDay} onChange={event => updateProfile('expenseDay', event.target.value)} inputMode="numeric" aria-label="지출까지 남은 기간" /><b>일</b></div></label>
              <label className="field"><span>추가 비상 예비액</span><div className="field-control"><input value={profile.reserve} onChange={event => updateProfile('reserve', event.target.value)} inputMode="decimal" aria-label="추가 비상 예비액" /><b>USDT</b></div></label>
              <label className="field"><span>위험 성향</span><select value={profile.risk} onChange={event => updateProfile('risk', event.target.value)} aria-label="위험 성향"><option value="conservative">보수형</option><option value="balanced">균형형</option><option value="growth">성장형</option></select></label>
            </div>
            <div className="additional-expenses"><div className="additional-expenses-head"><strong>추가 지출</strong><button type="button" onClick={() => setSession(current => ({ ...current,
              profile: { ...current.profile, extraExpenses: [...current.profile.extraExpenses, { id: crypto.randomUUID(), amount: '0', day: '14' }] },
              inputVersion: current.inputVersion + 1, confirmedVersion: null }))}>+ 지출 추가</button></div>
              {profile.extraExpenses.map((expense, index) => <div className="additional-expense-row" key={expense.id} role="group" aria-label={`${index + 1}번째 추가 지출`}>
                <label>금액 <input value={expense.amount} onChange={event => updateExtraExpense(expense.id, 'amount', event.target.value)} inputMode="decimal" aria-label={`${index + 1}번째 추가 지출 금액`} /> USDT</label>
                <label>시점 <input value={expense.day} onChange={event => updateExtraExpense(expense.id, 'day', event.target.value)} inputMode="numeric" aria-label={`${index + 1}번째 추가 지출까지 남은 일수`} /> 일 뒤</label>
                <button type="button" onClick={() => setSession(current => ({ ...current,
                  profile: { ...current.profile, extraExpenses: current.profile.extraExpenses.filter(item => item.id !== expense.id) },
                  inputVersion: current.inputVersion + 1, confirmedVersion: null }))} aria-label={`${index + 1}번째 추가 지출 삭제`}>삭제</button>
              </div>)}
            </div>
            <label className="usdd-risk"><input type="checkbox" checked={profile.acceptsUsddRisk} onChange={event => setSession(current => ({ ...current,
              profile: { ...current.profile, acceptsUsddRisk: event.target.checked }, inputVersion: current.inputVersion + 1,
              confirmedVersion: null }))} />USDD 경로 검토 의향을 기록합니다. 현재 가정 계산에는 반영되지 않습니다.</label>
            <label className="usdd-risk"><input type="checkbox" checked={profile.acceptsDatedExpenseLiquidityRisk}
              onChange={event => setSession(current => ({ ...current,
                profile: { ...current.profile, acceptsDatedExpenseLiquidityRisk: event.target.checked },
                inputVersion: current.inputVersion + 1, confirmedVersion: null }))} />
              예정 지출액의 기한 전 운용 위험 수용 의향을 기록합니다. 현재 가정 계산은 지출액을 전액 보호하며 이 선택으로 상한이 늘어나지 않습니다.</label>
            <div className="scenario-picker"><span>지출일 빠르게 비교</span><div><button className={profile.expenseDay === '7' ? 'on' : ''} onClick={() => updateProfile('expenseDay', '7')}>7일 뒤</button><button className={profile.expenseDay === '45' ? 'on' : ''} onClick={() => updateProfile('expenseDay', '45')}>45일 뒤</button></div></div>
          </section>

          <section className="surface outcome-panel" aria-label="유동성 계산 결과">
            <div className="panel-head"><div><span className="panel-step dark">02</span><h3>유동성 계산</h3></div><span className="read-only-tag">자동 계산</span></div>
            {planning.error ? <div className="input-error" role="alert"><strong>입력값을 확인해 주세요</strong><p>{planning.error}</p></div> : <>
              <div className="outcome-amount"><small>전 기간 운용 상한</small><div><strong>{exactMoney(investable!)}</strong><span>USDT</span></div><p>예정 지출 {planning.needs!.expenses.length}건과 비상 예비액을 전액 확보한 뒤의 상한입니다. 날짜별 회수 후보나 거래 조건은 이번 가정 계산에 포함하지 않습니다.</p></div>
              <div className="allocation-bar" aria-hidden="true"><span style={{ width: `${investedPercent}%` }} /></div>
              <div className="allocation-key"><span><i className="key-invest" />전 기간 운용 상한 <b>{exactMoney(investable!)} USDT</b></span><span><i className="key-held" />지출·예비액 <b>{exactMoney(planning.result!.protectedAmount)} USDT</b></span></div>
              <CalculationBasis needs={planning.needs!} liquidity={planning.result!} />
            </>}
            <div className="needs-confirm"><p>입력 버전 {session.inputVersion} · {confirmed ? '사용자님 확인 완료' : '확인 전'}</p><button type="button" disabled={!planning.result || confirmed} onClick={confirmNeeds}>{confirmed ? '확인 완료' : '입력 요약 확인'}</button></div>
            <p className="micro-note">출금 시점과 거래비용은 별도 상품 검증이 필요합니다. 위 금액은 예치 권고나 실행 가능 금액이 아닙니다.</p>
          </section>
        </div>
        <div className="page-next"><div><span>다음 단계</span><strong>입력한 조건의 가정 결과를 확인해 보세요.</strong></div><a href="/plans" onClick={event => navigate(event, '/plans')}>가정 계산 ↗</a></div>
        </>}

        {route === '/plans' && <>
        <div className="plan-context"><div><span>Mainnet USDT 읽기 전용 비교</span><strong>먼저 입력 조건의 고정 예시를 보여주고, 아래에서 공식 원천을 별도로 조회합니다.</strong><p>왕복 비용과 순익이 확인되지 않아 상품을 추천하거나 거래하지 않습니다.</p></div><a href="/needs" onClick={event => navigate(event, '/needs')}>조건 수정 ↗</a></div>
        <UsdtExpectedResult needs={planning.needs} error={planning.error} />
        <section className="surface plans-surface" aria-label="Mainnet 날짜별 상품 비교">
          <div className="market-header"><div><p className="overline">READ ONLY · MAINNET</p><h2>날짜별 상품 경로 비교</h2>
            <p>확인한 지출 조건으로 보유·jUSDT·PSM→jUSDD를 비교합니다. 용량과 왕복 비용이 빠지면 운용 후보에서 제외합니다.</p></div></div>
          <PlanExplorer needs={planning.needs} />
        </section>
        <FundingPanel needs={planning.needs} />
        <div className="page-next"><div><span>실제 시연</span><strong>Nile TRX 시험 거래는 별도 체인에서 진행합니다.</strong></div><a href="/" onClick={event => navigate(event, '/')}>Nile 시연으로 ↗</a></div>
        </>}

        {route === '/markets' && <>
        <section className="surface markets-panel">
          <div className="market-header"><div><p className="overline">03 / MARKET DATA</p><h2>공식 시장 데이터</h2><p>JustLend V1 Mainnet 시장 조회값입니다. 원천 갱신 시각은 제공되지 않으며 인센티브 수익률은 포함되지 않습니다.</p></div><div className="market-actions"><label className="search"><span aria-hidden="true">⌕</span><input value={marketQuery} onChange={event => setMarketQuery(event.target.value)} placeholder="자산 검색" aria-label="자산 검색" /></label><button className="refresh-button" onClick={() => void refreshMarkets()} disabled={loading}>{loading ? '조회 중…' : '↻ 다시 조회'}</button></div></div>
          {loading && <div className="market-state" role="status">공식 API에서 시장을 조회하고 있습니다…</div>}
          {marketError && <div className="market-state error" role="alert"><strong>실시간 시장 조회 실패</strong><span>{marketError}</span></div>}
          {snapshot && <><div className="market-meta"><span className={marketRecentlyFetched ? 'live-indicator' : 'section-badge amber'}>{marketRecentlyFetched ? '최근 API 조회 · MAINNET' : '지난 API 조회 · 다시 조회 필요'}</span><span>{visibleMarkets.length} / {snapshot.markets.length}개 시장</span><span>조회 시각 {kst(snapshot.fetchedAt)} KST</span></div><div className="table-scroll"><table><thead><tr><th>시장</th><th>기본 예치 APY</th><th>대출 APY</th><th>시장 현금 · 원자산 단위</th></tr></thead><tbody>{visibleMarkets.map(market => <tr key={market.address}><td><span className="market-symbol">{market.underlyingSymbol.slice(0, 1)}</span><span className="market-name"><strong>{market.underlyingSymbol}</strong><small>{market.symbol}</small></span></td><td className="positive">{formatRate(market.supplyRate)}%</td><td>{formatRate(market.borrowRate)}%</td><td>{money(market.cash)}</td></tr>)}</tbody></table>{visibleMarkets.length === 0 && <p className="empty-market">일치하는 시장이 없습니다.</p>}</div><div className="market-source"><a href={snapshot.source} target="_blank" rel="noreferrer">공식 API 원문 ↗</a><span>원천 갱신 시각: {snapshot.sourceUpdatedAt ?? '제공되지 않음'} · 활성/legacy 여부 미확인 · 화면 표시 기준 5분</span></div></>}
        </section>
        <SourcesPanel />
        <div className="page-next"><div><span>데이터 범위</span><strong>Mainnet 시장과 Nile 개발 지갑은 별도 환경입니다.</strong></div><a href="/connections" onClick={event => navigate(event, '/connections')}>연결 상태 ↗</a></div>
        </>}

        {route === '/review' && <><ReviewPanel selectedPlan={session.selectedPlan} monitorPlan={monitorPlan}
          datedAllocation={session.monitoredAllocation?.allocation ?? null} records={session.records}
          observations={session.observations} openingObservations={session.openingObservations}
          positionFlows={session.positionFlows} flowCoverages={session.flowCoverages}
          currentNeeds={reviewNeeds} agentRequest={monitoredRequest}
          currentAgentRequest={monitoredRequest ? latestAgentRequest : null}
          walletAddress={wallet.networkKey === (session.monitoredAllocation?.allocation.chain
            ?? monitorPlan?.chain ?? session.selectedPlan?.chain) ? wallet.address : null}
          originalWalletAddress={session.monitoredAllocation?.walletAddress ?? session.monitoredAgent?.walletAddress ?? null}
          onExport={() => exportSession(session)} />
          <ReplayPanel />
        </>}

        {route === '/connections' && <>
        <div className="section-intro"><div><p className="overline">04 / CONNECTION STATUS</p><h2>개발 환경 연결 상태</h2><p>연결은 주소만 조회합니다. Nile 거래는 미리보기와 사용자님 확인을 거칩니다.</p></div><span className="section-badge">지갑·Nile 상태</span></div>
        <section className="connections-grid">
          <div className="surface connection-card"><span className="connection-icon">◇</span><div><p className="overline">DEVELOPMENT WALLET</p><h3>TronLink 주소 연결</h3><p>{wallet.address ? `${wallet.network} · ${wallet.address}` : walletMessage}</p>{wallet.address && <small>{walletMessage}</small>}</div><button onClick={() => void connect()}>{wallet.address ? '다시 확인' : '주소 연결'} ↗</button></div>
          <div className="surface connection-card"><span className="connection-icon nile">▦</span><div><p className="overline">NILE RPC / TEST NETWORK</p><h3>{nile ? `블록 #${nile.block.toLocaleString('ko-KR')}` : nileError ? '연결 확인 필요' : '연결 확인 중'}</h3><p>{nile ? `블록 시각 ${kst(nile.blockTime)} KST · 조회 시각 ${kst(nile.fetchedAt)} KST` : nileError || 'Nile 테스트넷 최신 블록을 조회하고 있습니다.'}</p></div><span className={`connection-status ${nileCurrent ? 'connected' : nileError ? 'unavailable' : ''}`}>{nileCurrent ? '최근 조회' : nile ? '다시 조회 필요' : nileError ? '연결 실패' : '확인 중'}</span>{((nile && !nileCurrent) || nileError) && <button type="button" onClick={() => void refreshNile()}>다시 조회 ↗</button>}</div>
        </section>
        <div className="next-steps"><span>Nile 시연</span><p>계약·시장·수수료 검증이 통과하면 Nile 계획에서 미리보기와 사용자님 확인을 진행할 수 있습니다. <a href="/" onClick={event => navigate(event, '/')}>Nile 시작 화면 ↗</a></p></div>
        </>}
        </React.Suspense>
        {route !== '/usdt-demo' && <footer><span>© 2026 GWDC · TRON Challenge B</span><span>Nile TRX는 테스트넷 · USDT 수치는 가정 시나리오 · Mainnet 시장 조회는 별도</span></footer>}
      </div>
    </main>
  </div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
import.meta.hot?.dispose(() => root.unmount());
