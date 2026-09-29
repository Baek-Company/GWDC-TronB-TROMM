import { useCallback, useRef, useState } from "react";
import type { Update } from "../../App";
import type { PersistedState } from "../../lib/storage";
import { api } from "../../lib/api";
import { assessGoal } from "../../../shared/monitor";
import { Money, timeKo } from "../common";

export default function GoalMonitor({ state, update, notify, goNeeds, goPlans }: { state: PersistedState; update: Update; notify: (text: string) => void; goNeeds: () => void; goPlans: () => void }) {
  const goal = state.monitoredGoal;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const baseline = state.analyses.find((item) => item.id === goal?.baselineResultId);
  const confirmed = state.confirmedVersion === state.needs.version && (state.convState === "confirmed" || state.convState === "comparing");
  const needsChanged = Boolean(baseline && baseline.needs.version !== state.needs.version);

  const recheck = useCallback(async () => {
    if (!goal || !baseline || running.current) return;
    if (!confirmed) { setError("요구사항이 바뀌었습니다. 요구 분석에서 새 조건을 확인한 뒤 다시 평가하세요."); return; }
    running.current = true; setBusy(true); setError(undefined);
    try {
      const current = await api.recheckGoal(state.needs);
      const assessment = assessGoal(baseline, current, goal.planKey);
      update((s) => {
        if (s.monitoredGoal?.baselineResultId !== goal.baselineResultId) return s;
        const history = [...(s.monitoredGoal.history ?? []), assessment].slice(-10);
        return { ...s, monitoredGoal: { ...s.monitoredGoal, latest: assessment, history } };
      });
      if (assessment.action !== "keep") notify(`목표 재평가: ${assessment.headline}`);
    } catch (e) { setError(`최신 자료를 확인하지 못했습니다: ${(e as Error).message}. 이전 결과를 현재 상태로 사용하지 않습니다.`); }
    finally { running.current = false; setBusy(false); }
  }, [goal?.baselineResultId, goal?.planKey, baseline?.id, confirmed, state.needs.version, update, notify]);

  if (!goal) return <div className="card" style={{ padding: 45, textAlign: "center" }}><h2>감시 중인 목표가 없습니다</h2><p className="muted">계획 비교에서 계획을 선택한 뒤 ‘이 목표 감시하기’를 누르세요.</p><button className="btn primary" onClick={goPlans}>계획 비교로 이동</button></div>;
  if (!baseline) return <div className="callout red">저장된 원계획을 찾지 못했습니다. 목표를 다시 등록하세요.</div>;
  const latest = goal.latest;
  const original = baseline.plans.find((plan) => plan.key === goal.planKey);

  return <div className="stack">
    <div className="row"><div><div className="eyebrow">Step 3 · Goal Monitor</div><h1 className="hero-title" style={{ fontSize: 34 }}>지출 목표를 <em>계속 확인합니다</em></h1><p className="sub">저장된 원계획과 최신 조건·시장 상태를 비교해 다음 행동을 제안합니다.</p></div><div className="spacer"/><button className="btn" onClick={recheck} disabled={busy || !confirmed}>{busy ? "재평가 중…" : "지금 재평가"}</button></div>
    <div className="card"><h3>맡긴 목표</h3><div className="kv"><div>선택한 경로</div><div>{original?.title ?? goal.planKey}</div><div>기간 안 USDT 지출·여유액</div><div><Money v={baseline.reserved.total} asset={original?.asset ?? baseline.needs.asset}/></div>{baseline.funding && <><div>별도 확보 TRX</div><div>{baseline.funding.reservedTrx} TRX</div></>}<div>운용 종료일</div><div>{baseline.needs.endDate}</div><div>원계획 계산 시각</div><div>{timeKo(baseline.createdAt)}</div></div>{original?.ladder && <div style={{ overflowX: "auto", marginTop: 14 }}><table className="table-simple"><thead><tr><th>필요 날짜</th><th>자금 묶음</th><th>배분</th><th>준비 일정</th></tr></thead><tbody>{original.ladder.map((b) => <tr key={b.id}><td>{b.needDate}</td><td>{b.label} {b.amount} {original.asset}</td><td>{b.productLabel}</td><td>{b.product === "HOLD" ? "필요 없음" : <>{b.unstakeDate && <div>해제 요청 {b.unstakeDate}</div>}<div>현금화 준비 {b.exitStartDate}</div></>}</td></tr>)}</tbody></table></div>}<p className="tiny muted">이 목표는 이 브라우저에 저장됩니다. 브라우저가 열려 있는 동안 5분마다 재조회하며, 거래를 자동 실행하지 않습니다.</p></div>
    {needsChanged && <div className="callout amber"><strong>사용자 조건이 바뀌었습니다.</strong> 기존 목표와 새 조건의 차이를 확인해야 합니다. {!confirmed && <><span> 먼저 요구사항 요약을 다시 확인하세요. </span><button className="btn small" onClick={goNeeds}>요구 분석으로</button></>}</div>}
    {error && <div className="callout red">{error}</div>}
    {latest && <div className={`callout ${latest.action === "keep" ? "teal" : "coral"}`}><div className="row"><strong>{latest.headline}</strong><div className="spacer"/><span className={`badge ${latest.sourceMode === "live" ? "teal" : "amber"}`}>{latest.sourceMode === "live" ? "실데이터" : "가상·미검증 데이터"}</span></div><div className="small" style={{ marginTop: 12 }}>선택 경로 예상 순수익: <Money v={latest.previousNet} dp={4} signed /> → <Money v={latest.currentNet} dp={4} signed /> {original?.asset ?? baseline.needs.asset}{latest.netChange && <> (변화 <Money v={latest.netChange} dp={4} signed />)</>}</div><ul>{latest.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><div className="tiny">재평가 {timeKo(latest.checkedAt)} · 이는 거래 제안이며 인출 가능성이나 수익을 보장하지 않습니다.</div></div>}
    {latest && <div className="card"><h3>이번 판단에 사용한 시장 근거</h3>{latest.sources.length ? latest.sources.map((source) => <div className="small" key={`${source.market}-${source.url}`} style={{ marginBottom: 12 }}><strong>{source.market}</strong> · {source.mode} · {timeKo(source.fetchedAt)}<br/>{source.mode === "synthetic" ? "시연용 로컬 fixture" : <a href={source.url} target="_blank" rel="noreferrer">출처 보기 ↗</a>}</div>) : <p className="small muted">보유 경로에는 별도 상품 조회값이 필요하지 않습니다.</p>}<p className="tiny muted">실데이터가 아니거나 비용·출구가 미확인된 경우 실제 거래 판단을 진행하지 않습니다.</p></div>}
    {goal.history.length > 0 && <details className="card"><summary>재평가 기록 ({goal.history.length})</summary><div style={{ overflowX: "auto", marginTop: 14 }}><table className="table-simple"><thead><tr><th>조회 시각</th><th>제안</th><th>예상 순수익</th></tr></thead><tbody>{[...goal.history].reverse().map((item, index) => <tr key={`${item.checkedAt}-${index}`}><td>{timeKo(item.checkedAt)}</td><td>{item.headline}</td><td><Money v={item.currentNet} asset={original?.asset ?? baseline.needs.asset} dp={4} signed /></td></tr>)}</tbody></table></div></details>}
    <div className="row"><button className="btn" onClick={goPlans}>원계획 비교 보기</button><button className="btn" onClick={goNeeds}>지출 조건 바꾸기</button></div>
  </div>;
}
