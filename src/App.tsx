import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Health } from "./lib/api";
import { clear, load, save, SCHEMA_VERSION, type PersistedState } from "./lib/storage";
import { emptyNeeds } from "../shared/needs";
import Overview from "./features/overview/Overview";
import Conversation from "./features/conversation/Conversation";
import PlanComparison from "./features/plans/PlanComparison";
import GoalMonitor from "./features/monitor/GoalMonitor";
import { ModeBadge } from "./features/common";
import { assessGoal } from "../shared/monitor";

export type Tab = "overview" | "needs" | "plans" | "monitor";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "개요" },
  { id: "needs", label: "요구 분석" },
  { id: "plans", label: "계획 비교" },
  { id: "monitor", label: "목표 감시" },
];

const WELCOME =
  "안녕하세요! 지출 일정부터 함께 정해 볼게요.\n보유한 자산, 운용 기간, 예정된 지출을 편하게 말씀해 주세요.\n예: \"1,000 USDT를 30일 운용하고, 7일 뒤에 200 USDT를 써야 해요.\"";

export function initialState(): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    needs: emptyNeeds("mainnet"),
    convState: "collecting",
    messages: [{ role: "assistant", content: WELCOME }],
    analyses: [],
    nile: { records: [], observations: [] },
  };
}

export type Update = (fn: (s: PersistedState) => PersistedState) => void;

export default function App() {
  const [state, setState] = useState<PersistedState>(() => load() ?? initialState());
  const [tab, setTab] = useState<Tab>("overview");
  const [health, setHealth] = useState<Health>();
  const [healthErr, setHealthErr] = useState<string>();
  const [toast, setToast] = useState<string>();
  const toastTimer = useRef<number | undefined>(undefined);

  const update: Update = useCallback((fn) => setState((s) => fn(s)), []);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(undefined), 3500);
  }, []);

  useEffect(() => {
    const err = save(state);
    if (err) notify(err);
  }, [state, notify]);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((e) => setHealthErr(`로컬 API에 연결하지 못했습니다: ${e.message}. 'npm run dev'로 API를 함께 실행하세요.`));
  }, []);

  const reset = () => {
    if (!confirm("저장된 대화·계획·거래 기록을 모두 지웁니다. 체인의 실제 거래는 영향받지 않습니다. 계속할까요?")) return;
    clear();
    setState(initialState());
    setTab("overview");
  };

  const latest = state.analyses[state.analyses.length - 1];
  const activeGoal = state.monitoredGoal;
  const goalConfirmed = state.confirmedVersion === state.needs.version && (state.convState === "confirmed" || state.convState === "comparing");

  useEffect(() => {
    if (!activeGoal || !goalConfirmed) return;
    const baseline = state.analyses.find((a) => a.id === activeGoal.baselineResultId);
    if (!baseline) return;
    let cancelled = false;
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const current = await api.recheckGoal(state.needs);
        if (cancelled) return;
        const assessment = assessGoal(baseline, current, activeGoal.planKey);
        update((s) => s.monitoredGoal?.baselineResultId === activeGoal.baselineResultId
          ? { ...s, monitoredGoal: { ...s.monitoredGoal, latest: assessment, history: [...(s.monitoredGoal.history ?? []), assessment].slice(-10) } }
          : s);
        if (assessment.action !== "keep") notify(`목표 재평가: ${assessment.headline}`);
      } catch (e) {
        if (!cancelled) notify(`목표 재평가 실패: ${(e as Error).message}`);
      } finally { running = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeGoal?.baselineResultId, activeGoal?.planKey, goalConfirmed, state.needs.version, update, notify]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <div className="brand" onClick={() => setTab("overview")}>
            <div className="brand-logo">
              G<span>W</span>DC
            </div>
            <div className="brand-sub">TRON과 함께, 더 나은 내일의 자산 계획</div>
          </div>
          <nav className="nav">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="header-badges">
            {health ? <ModeBadge mode={health.config.dataMode} /> : <span className="badge gray">연결 확인 중</span>}
            <span className="badge teal" title="Mainnet 분석은 조회만 하고 거래하지 않습니다">조회 전용</span>
            <button className="avatar" title="설정·초기화" onClick={reset}>
              ⟲
            </button>
          </div>
        </div>
      </header>

      <main className="page">
        {healthErr && <div className="callout red" style={{ marginBottom: 16 }}>{healthErr}</div>}
        {tab === "overview" && <Overview state={state} dataMode={health?.config.dataMode} onStart={() => setTab("needs")} />}
        {tab === "needs" && <Conversation state={state} update={update} health={health} goPlans={() => setTab("plans")} notify={notify} />}
        {tab === "plans" && <PlanComparison state={state} update={update} result={latest} goNeeds={() => setTab("needs")} goMonitor={() => setTab("monitor")} />}
        {tab === "monitor" && <GoalMonitor state={state} update={update} notify={notify} goNeeds={() => setTab("needs")} goPlans={() => setTab("plans")} />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
