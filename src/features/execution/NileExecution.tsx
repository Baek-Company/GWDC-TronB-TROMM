import { useEffect, useRef, useState } from "react";
import type { Update } from "../../App";
import { api, type Health, type ObserveResponse } from "../../lib/api";
import type { PersistedState } from "../../lib/storage";
import { BroadcastRejected, BroadcastUnknown, connect, currentWallet, hasTronLink, signAndSend, SignRejected, type WalletInfo } from "../../lib/tronlink";
import { addDays, todaySeoul } from "../../../shared/needs";
import { TYPICAL_RESOURCES } from "../../../shared/planning";
import { Decimal, sunToTrx, trxToSun } from "../../../shared/units";
import type { ActionPreview, ExecutionRecord, Plan, TxStatus, UserNeeds } from "../../../shared/schemas";
import { EligibilityBadge, ModeBadge, Money, pct, SourceLine, timeKo, TxBadge } from "../common";

const FEE_LIMIT_SUN = 50_000_000n; // 50 TRX 상한
const PREVIEW_TTL_MS = 3 * 60 * 1000;
const IN_FLIGHT: TxStatus[] = ["awaiting_signature", "submitted", "pending", "unknown"];
const EXPLORER = "https://nile.tronscan.org/#/transaction/";

export default function NileExecution({ state, update, health, notify }: { state: PersistedState; update: Update; health?: Health; notify: (m: string) => void }) {
  const [wallet, setWallet] = useState<WalletInfo | undefined>(() => currentWallet());
  const [obs, setObs] = useState<ObserveResponse>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [devAck, setDevAck] = useState(false);
  const [form, setForm] = useState({ total: "100", days: "30", reserve: "20" });

  const nile = state.nile;
  const result = nile.result;
  const preview = nile.preview;
  const inFlight = nile.records.find((r) => IN_FLIGHT.includes(r.status));
  const execEnabled = health?.config.enableNileExecution ?? false;

  // TronLink 계정·네트워크 변경 감지
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const action = e.data?.message?.action;
      if (action === "accountsChanged" || action === "setAccount" || action === "setNode" || action === "connect" || action === "disconnect") {
        setTimeout(() => setWallet(currentWallet()), 300);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 지갑이 바뀌면 미리보기를 무효화한다
  useEffect(() => {
    if (preview && wallet && preview.wallet !== wallet.address) {
      update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }));
      setError("지갑 계정이 바뀌어 거래 미리보기를 무효화했습니다.");
    }
  }, [wallet?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshObs = async (w = wallet) => {
    if (!w || w.network !== "nile") return undefined;
    const r = await api.observe(w.address, nile.selectedPlanId);
    setObs(r);
    setForm((f) => ({ ...f, total: new Decimal(sunToTrx(r.snapshot.balanceSun)).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed() }));
    return r;
  };

  useEffect(() => {
    if (wallet?.network === "nile") refreshObs().catch((e) => setError(e.message));
  }, [wallet?.address, wallet?.network]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------ 미확정 txID 재조회 (새로고침 후 포함). 자동 재서명하지 않는다.
  const polling = useRef(false);
  useEffect(() => {
    const pending = nile.records.filter((r) => r.txId && ["submitted", "pending", "unknown"].includes(r.status));
    if (!pending.length) return;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        for (const rec of pending) {
          const t = await api.tx(rec.txId!).catch(() => undefined);
          if (!t) continue;
          if (t.status === "confirmed" || t.status === "failed") {
            update((s) => ({
              ...s,
              nile: {
                ...s.nile,
                records: s.nile.records.map((r) =>
                  r.id === rec.id
                    ? { ...r, status: t.status as TxStatus, confirmedAt: new Date().toISOString(), blockNumber: t.blockNumber, feeTrx: t.feeTrx, energyUsed: t.energyUsed, error: t.status === "failed" ? `계약 실행 결과: ${t.result}` : undefined }
                    : r,
                ),
              },
            }));
            if (t.status === "confirmed") {
              // 확정 후 같은 포지션을 다시 읽어 관측으로 남긴다
              try {
                const o = await api.observe(rec.wallet, rec.planId);
                setObs(o);
                update((s) => ({ ...s, nile: { ...s.nile, observations: [...s.nile.observations, { ...o.observation, planId: rec.planId }] } }));
                notify(`거래 확정: ${rec.kind === "deposit" ? "예치" : "인출"} ${rec.amountDisplay}. 포지션을 다시 조회했습니다.`);
              } catch {
                notify("거래는 확정됐지만 포지션 재조회에 실패했습니다. 검토 탭에서 다시 조회하세요.");
              }
            }
          } else if (t.status === "pending" && rec.status !== "pending") {
            update((s) => ({ ...s, nile: { ...s.nile, records: s.nile.records.map((r) => (r.id === rec.id ? { ...r, status: "pending", blockNumber: t.blockNumber } : r)) } }));
          }
        }
      } finally {
        polling.current = false;
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [nile.records, update, notify]);

  async function onConnect() {
    setError(undefined);
    try {
      const w = await connect();
      setWallet(w);
      if (w.network !== "nile") setError("TronLink 네트워크가 Nile 테스트넷이 아닙니다. TronLink에서 Nile로 전환해 주세요.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function makePlans() {
    setError(undefined);
    setBusy("plans");
    const today = todaySeoul();
    const needs: UserNeeds = {
      chain: "nile",
      asset: "TRX",
      amount: new Decimal(form.total || 0).toFixed(),
      startDate: today,
      endDate: addDays(today, Number(form.days) || 30),
      expenses: [],
      expensesStated: true,
      bufferAmount: new Decimal(form.reserve || 0).toFixed(),
      riskProfile: "balanced",
      timezone: "Asia/Seoul",
      version: (nile.needs?.version ?? 0) + 1,
    };
    try {
      const r = await api.plans(needs, wallet?.network === "nile" ? wallet.address : undefined);
      update((s) => ({ ...s, nile: { ...s.nile, needs, result: r, selectedPlanId: undefined, preview: undefined } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function buildPreview(plan: Plan, kind: "deposit" | "withdraw") {
    setError(undefined);
    setDevAck(false);
    if (!wallet || wallet.network !== "nile") return setError("Nile 네트워크의 TronLink 지갑을 먼저 연결하세요.");
    setBusy("preview");
    try {
      const o = await refreshObs();
      if (!o) throw new Error("지갑 상태를 읽지 못했습니다.");
      const s = o.snapshot;
      const res = kind === "deposit" ? TYPICAL_RESOURCES.supply_trx : TYPICAL_RESOURCES.withdraw;
      const feeSun = BigInt(res.energy * s.energyFeeSun + res.bandwidth * s.bandwidthFeeSun);
      let amountSun: bigint;
      let amountDisplay: string;
      if (kind === "deposit") {
        amountSun = trxToSun(new Decimal(plan.allocation.invested).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed());
        amountDisplay = `${sunToTrx(amountSun)} TRX`;
        if (amountSun <= 0n) throw new Error("예치 금액이 0입니다.");
        if (BigInt(s.balanceSun) < amountSun + feeSun) throw new Error(`잔고 부족: ${sunToTrx(s.balanceSun)} TRX < 예치 ${sunToTrx(amountSun)} + 예상 수수료 ${sunToTrx(feeSun)} TRX`);
      } else {
        amountSun = BigInt(s.jTokenBalance); // redeem은 jToken 수량(1e8 단위)
        amountDisplay = `jTRX ${o.observation.balances.find((b) => b.asset === "jTRX")?.amount} (≈ ${o.observation.underlyingValue} TRX)`;
        if (amountSun <= 0n) throw new Error("인출할 jTRX 포지션이 없습니다.");
        if (BigInt(s.balanceSun) < feeSun) throw new Error(`수수료 잔고 부족: ${sunToTrx(s.balanceSun)} TRX < ${sunToTrx(feeSun)} TRX`);
      }
      const now = Date.now();
      const p: ActionPreview = {
        id: `pv-${now}`,
        planId: plan.id,
        kind,
        wallet: wallet.address,
        chain: "nile",
        asset: "TRX",
        amountSun: amountSun.toString(),
        amountDisplay,
        contract: s.contract,
        method: kind === "deposit" ? "mint()" : "redeem(uint256)",
        approval: "없음 (네이티브 TRX는 토큰 승인이 필요 없습니다)",
        estimatedEnergy: res.energy,
        estimatedFeeTrx: sunToTrx(feeSun),
        feeLimitSun: FEE_LIMIT_SUN.toString(),
        risks: [
          "Nile 테스트넷 거래이며 테스트 TRX는 실제 가치가 없습니다.",
          "스마트 계약 위험: 계약 오류나 일시 중지 시 인출이 지연될 수 있습니다.",
          "실제 Energy 사용량은 예상과 다를 수 있으며 수수료 상한까지 소각될 수 있습니다.",
          ...(plan.label === "개발자 테스트 실행" ? ["예상 순수익이 0 이하입니다. 경제적 추천이 아닌 개발자 테스트 실행입니다."] : []),
        ],
        createdAt: new Date(now).toISOString(),
        validUntil: new Date(now + PREVIEW_TTL_MS).toISOString(),
        snapshot: { balanceSun: s.balanceSun, jTokenBalance: s.jTokenBalance, energyFeeSun: s.energyFeeSun, contractVerified: s.contractVerified },
      };
      if (!s.contractVerified) throw new Error(`jTRX 계약 확인 실패 (${s.contractName ?? "코드 없음"}). 거래를 만들지 않습니다.`);
      update((st) => ({ ...st, nile: { ...st.nile, preview: p, selectedPlanId: plan.id } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function execute() {
    if (!preview) return;
    setError(undefined);
    const plan = result?.plans.find((p) => p.id === preview.planId);
    const invalidate = (why: string) => {
      update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }));
      setError(`미리보기를 무효화했습니다: ${why} 다시 확인해 주세요.`);
    };
    if (!execEnabled) return setError("ENABLE_NILE_EXECUTION=false 입니다. .env.local에서 true로 바꾸고 API를 재시작하세요.");
    if (inFlight) return setError("확정되지 않은 거래가 있습니다. 먼저 결과를 확인하세요 (중복 거래 방지).");
    if (Date.now() > Date.parse(preview.validUntil)) return invalidate("유효 시간이 지났습니다.");
    if (preview.kind === "deposit" && plan?.label === "개발자 테스트 실행" && !devAck) return setError("개발자 테스트 실행임을 확인해 주세요.");

    setBusy("sign");
    // 서명 직전 체인·계정·금액·계약·비용을 다시 읽는다
    const w = currentWallet();
    if (!w || w.address !== preview.wallet) return setBusy(undefined), invalidate("지갑 계정이 바뀌었습니다.");
    if (w.network !== "nile") return setBusy(undefined), invalidate("TronLink 네트워크가 Nile이 아닙니다.");
    let fresh: ObserveResponse;
    try {
      fresh = await api.observe(w.address, preview.planId);
    } catch (e) {
      setBusy(undefined);
      return setError(`재확인 조회 실패: ${(e as Error).message}`);
    }
    const s = fresh.snapshot;
    const feeSun = trxToSun(preview.estimatedFeeTrx);
    if (!s.contractVerified || s.contract !== preview.contract) return setBusy(undefined), invalidate("대상 계약 확인이 달라졌습니다.");
    if (s.energyFeeSun !== preview.snapshot.energyFeeSun) return setBusy(undefined), invalidate(`Energy 단가가 바뀌었습니다 (${preview.snapshot.energyFeeSun} → ${s.energyFeeSun}).`);
    if (preview.kind === "deposit" && BigInt(s.balanceSun) < BigInt(preview.amountSun) + feeSun) return setBusy(undefined), invalidate("잔고가 부족해졌습니다.");
    if (preview.kind === "withdraw" && BigInt(s.jTokenBalance) !== BigInt(preview.amountSun)) return setBusy(undefined), invalidate("jTRX 잔고가 바뀌었습니다.");

    const rec: ExecutionRecord = {
      id: `ex-${Date.now()}`,
      planId: preview.planId,
      previewId: preview.id,
      kind: preview.kind,
      chain: "nile",
      wallet: preview.wallet,
      status: "awaiting_signature",
      amountDisplay: preview.amountDisplay,
    };
    const patchRec = (p: Partial<ExecutionRecord>) =>
      update((st) => ({ ...st, nile: { ...st.nile, records: st.nile.records.map((r) => (r.id === rec.id ? { ...r, ...p } : r)) } }));
    update((st) => ({ ...st, nile: { ...st.nile, records: [...st.nile.records, rec], preview: undefined } }));

    try {
      await signAndSend({
        contract: preview.contract,
        method: preview.method,
        params: preview.kind === "withdraw" ? [{ type: "uint256", value: preview.amountSun }] : [],
        callValueSun: preview.kind === "deposit" ? BigInt(preview.amountSun) : 0n,
        feeLimitSun: BigInt(preview.feeLimitSun),
        from: preview.wallet,
        // txID를 받는 즉시 저장한다 (방송 결과를 모르더라도 같은 txID를 조회하기 위해)
        onSigned: (txId) => patchRec({ txId, status: "unknown", submittedAt: new Date().toISOString() }),
      });
      patchRec({ status: "submitted" });
      notify("거래를 제출했습니다. 확정 영수증을 확인하는 중입니다.");
    } catch (e) {
      if (e instanceof SignRejected) patchRec({ status: "rejected", error: e.message });
      else if (e instanceof BroadcastRejected) patchRec({ status: "failed", error: e.message });
      else if (e instanceof BroadcastUnknown) patchRec({ status: "unknown", error: e.message });
      else patchRec({ status: "failed", error: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  }

  const latestObs = nile.observations[nile.observations.length - 1];
  const hasPosition = obs ? BigInt(obs.snapshot.jTokenBalance) > 0n : false;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <div className="eyebrow">Step 3 · Nile testnet</div>
          <h1 className="hero-title" style={{ fontSize: 34 }}>
            Nile에서 <em>직접 실행</em>해 보기
          </h1>
          <p className="sub">Mainnet 분석과 별개인 테스트넷 흐름입니다. Nile jTRX 계약 값으로 계획을 만들고, 확인 → TronLink 서명 → 확정 → 같은 포지션 재조회까지 진행합니다.</p>
        </div>
      </div>
      <div className="callout amber small">
        ⚠ 테스트넷 거래 시연입니다. 테스트 TRX 수익은 실제 USDT 수익으로 환산하지 않으며, Mainnet USDT·USDD 계획의 실행 증거가 아닙니다.
      </div>
      {!execEnabled && health && (
        <div className="callout gray small">
          현재 <code>ENABLE_NILE_EXECUTION=false</code>: 계획·미리보기까지만 동작합니다. 지갑과 Nile TRX를 준비한 뒤 <code>.env.local</code>에서 true로 바꾸고 API를 재시작하세요.
        </div>
      )}
      {error && <div className="callout red small">{error}</div>}

      <div className="grid-2">
        <div className="stack">
          <div className="card">
            <h3>1. 지갑 연결</h3>
            {!hasTronLink() && (
              <p className="small muted">
                TronLink 확장이 감지되지 않았습니다. <a href="https://www.tronlink.org/" target="_blank" rel="noreferrer">TronLink</a> 설치 후 개발 전용 지갑을 만들고 Nile로 전환하세요.
              </p>
            )}
            {wallet ? (
              <div className="kv">
                <div>주소</div>
                <div>
                  <code>{wallet.address}</code>
                </div>
                <div>네트워크</div>
                <div>{wallet.network === "nile" ? <span className="badge teal">Nile</span> : <span className="badge red">Nile 아님 ({wallet.host})</span>}</div>
                {obs && (
                  <>
                    <div>TRX 잔고</div>
                    <div className="bold">{sunToTrx(obs.snapshot.balanceSun)} TRX</div>
                    <div>jTRX 포지션</div>
                    <div>
                      {obs.observation.balances.find((b) => b.asset === "jTRX")?.amount} jTRX ≈ {obs.observation.underlyingValue} TRX
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button className="btn primary" onClick={onConnect} disabled={!hasTronLink()}>
                TronLink 연결
              </button>
            )}
            {wallet && (
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn small" onClick={() => refreshObs().catch((e) => setError(e.message))}>
                  잔고·포지션 재조회
                </button>
                <a className="small" href="https://nileex.io/join/getJoinPage" target="_blank" rel="noreferrer">
                  Nile Faucet
                </a>
              </div>
            )}
          </div>

          <div className="card">
            <h3>2. Nile 요구사항 확인</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              Mainnet 입력과 별도로 받습니다. 지갑이 연결되면 실제 잔고로 다시 계산합니다.
            </p>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="field">
                보유 TRX
                <input value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} disabled={Boolean(wallet && obs)} />
              </label>
              <label className="field">
                운용 일수
                <input value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
              </label>
              <label className="field">
                유동성 확보 (TRX)
                <input value={form.reserve} onChange={(e) => setForm({ ...form, reserve: e.target.value })} />
              </label>
              <button className="btn teal" onClick={makePlans} disabled={busy === "plans" || !/^\d+(\.\d+)?$/.test(form.total) || !/^\d+$/.test(form.days) || !/^\d+(\.\d+)?$/.test(form.reserve)}>
                {busy === "plans" ? "계산 중…" : "이대로 확인하고 Nile 계획 계산"}
              </button>
            </div>
          </div>
        </div>

        <div className="stack">
          {preview ? (
            <div className="card" style={{ border: "2px solid var(--coral)" }}>
              <div className="row">
                <h3 style={{ margin: 0 }}>4. 거래 전 확인 ({preview.kind === "deposit" ? "예치" : "인출"})</h3>
                <div className="spacer" />
                <span className="badge gray">유효 ~ {new Date(preview.validUntil).toLocaleTimeString("ko-KR")}</span>
              </div>
              <div className="kv" style={{ marginTop: 10 }}>
                <div>체인</div>
                <div>
                  <span className="badge amber">Nile 테스트넷</span>
                </div>
                <div>지갑</div>
                <div>
                  <code>{preview.wallet}</code>
                </div>
                <div>금액</div>
                <div className="bold">{preview.amountDisplay}</div>
                <div>최소 단위</div>
                <div>
                  <code>{preview.amountSun}</code> {preview.kind === "deposit" ? "sun" : "jTRX 단위(1e-8)"}
                </div>
                <div>대상 계약</div>
                <div>
                  <code>{preview.contract}</code> (JustLend-TRX 확인됨)
                </div>
                <div>메서드</div>
                <div>
                  <code>{preview.method}</code>
                </div>
                <div>승인 범위</div>
                <div>{preview.approval}</div>
                <div>예상 비용</div>
                <div>
                  ≈ {preview.estimatedFeeTrx} TRX ({preview.estimatedEnergy.toLocaleString()} Energy) · 상한 {sunToTrx(preview.feeLimitSun)} TRX
                </div>
              </div>
              <ul className="clean small" style={{ marginTop: 10 }}>
                {preview.risks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {preview.kind === "deposit" && result?.plans.find((p) => p.id === preview.planId)?.label === "개발자 테스트 실행" && (
                <label className="small row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={devAck} onChange={(e) => setDevAck(e.target.checked)} />
                  순익이 0 이하임을 이해했고, 개발자 테스트 실행으로 진행합니다.
                </label>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn primary" disabled={Boolean(busy) || Boolean(inFlight) || !execEnabled} onClick={execute}>
                  {busy === "sign" ? "재확인·서명 대기 중…" : "확인했습니다 — TronLink로 서명"}
                </button>
                <button className="btn ghost" onClick={() => update((s) => ({ ...s, nile: { ...s.nile, preview: undefined } }))}>
                  취소
                </button>
              </div>
              <p className="tiny muted">서명 직전에 체인·계정·잔고·계약·Energy 단가를 다시 읽고, 달라지면 미리보기를 무효화합니다.</p>
            </div>
          ) : (
            result && (
              <div className="card">
                <div className="row">
                  <h3 style={{ margin: 0 }}>3. Nile 계획 비교</h3>
                  <div className="spacer" />
                  {[...new Set(result.quotes.map((q) => q.source.mode))].map((m) => (
                    <ModeBadge key={m} mode={m} />
                  ))}
                </div>
                {result.warnings.map((w) => (
                  <div key={w} className="callout amber tiny" style={{ marginTop: 8 }}>
                    ⚠ {w}
                  </div>
                ))}
                <table className="table-simple" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>계획</th>
                      <th>예치 / 보유</th>
                      <th>기본 수익</th>
                      <th>왕복 비용</th>
                      <th>순수익</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {result.plans.map((p) => (
                      <tr key={p.id} style={p.recommended ? { background: "#f2faf6" } : undefined}>
                        <td>
                          <div className="bold">{p.title}</div>
                          <EligibilityBadge e={p.eligibility} /> {p.key !== "HOLD" && <span className={`badge ${p.label === "개발자 테스트 실행" ? "coral" : "teal"}`}>{p.label}</span>}
                          {p.recommended && <span className="badge teal">추천</span>}
                          {p.reasons.map((r) => (
                            <div key={r} className="tiny muted">
                              • {r}
                            </div>
                          ))}
                        </td>
                        <td>
                          {p.allocation.invested} / {p.allocation.held}
                        </td>
                        <td>
                          <Money v={p.baseYield} dp={6} />
                        </td>
                        <td>{Number(p.costs.trx).toFixed(2)}</td>
                        <td>
                          <Money v={p.netReturn} dp={4} signed />
                        </td>
                        <td>
                          {p.key !== "HOLD" && (
                            <button className="btn small" disabled={p.eligibility === "ineligible" || Boolean(busy) || Boolean(inFlight)} onClick={() => buildPreview(p, "deposit")}>
                              선택·미리보기
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="tiny muted">
                  단위 TRX · jTRX 기본 금리 {pct(result.quotes[0]?.baseRate, 6)} {result.quotes[0] ? "APR" : ""} · 30일 동안 금리 유지 가정 · 비용 = 예치 + 인출 수수료
                </p>
                {result.quotes[0] && <SourceLine s={result.quotes[0].source} />}
                {result.costBasis && <SourceLine s={result.costBasis.source} />}
              </div>
            )
          )}

          {hasPosition && !preview && (
            <div className="card">
              <h3>인출 (P1)</h3>
              <p className="small muted">현재 jTRX 포지션 전체를 redeem합니다. 예치와 같은 확인 과정을 거칩니다.</p>
              <button
                className="btn"
                disabled={Boolean(busy) || Boolean(inFlight)}
                onClick={() => {
                  const plan = result?.plans.find((p) => p.id === nile.selectedPlanId) ?? result?.plans.find((p) => p.key !== "HOLD");
                  if (plan) buildPreview(plan, "withdraw");
                  else setError("먼저 Nile 계획을 계산하세요.");
                }}
              >
                인출 미리보기
              </button>
            </div>
          )}

          <div className="card">
            <h3>5. 실행 기록</h3>
            {nile.records.length === 0 && <p className="small muted">아직 거래가 없습니다. 가짜 txID나 가짜 성공 상태는 표시하지 않습니다.</p>}
            {[...nile.records].reverse().map((r) => (
              <div key={r.id} className="callout gray small" style={{ marginBottom: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <TxBadge s={r.status} />
                  <strong>{r.kind === "deposit" ? "예치" : "인출"}</strong> {r.amountDisplay}
                  <div className="spacer" />
                  <span className="tiny muted">{timeKo(r.submittedAt)}</span>
                </div>
                {r.txId && (
                  <div className="tiny">
                    txID{" "}
                    <a href={EXPLORER + r.txId} target="_blank" rel="noreferrer">
                      <code>{r.txId}</code>
                    </a>
                  </div>
                )}
                {r.status === "confirmed" && (
                  <div className="tiny muted">
                    블록 {r.blockNumber} · 실제 수수료 {r.feeTrx} TRX · Energy {r.energyUsed?.toLocaleString() ?? "-"} · 확정 {timeKo(r.confirmedAt)}
                  </div>
                )}
                {(r.status === "pending" || r.status === "unknown" || r.status === "submitted") && <div className="tiny muted">원 txID를 계속 조회합니다. 자동으로 다시 서명하지 않습니다.</div>}
                {r.error && <div className="tiny neg">{r.error}</div>}
              </div>
            ))}
            {latestObs && (
              <div className="small">
                최근 관측: {timeKo(latestObs.observedAt)} · jTRX {latestObs.balances.find((b) => b.asset === "jTRX")?.amount} ≈ <strong>{latestObs.underlyingValue} TRX</strong>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
