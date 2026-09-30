import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { UserNeeds } from '../../../shared/schemas';

const source = z.object({ sourceUrl: z.string(), fetchedAt: z.string(), sourceUpdatedAt: z.string().nullable(),
  chain: z.literal('mainnet'), mode: z.literal('live') });
const result = z.object({ status: z.enum(['ready', 'unknown', 'unavailable']), source,
  reason: z.string().optional(), reasons: z.array(z.string()).optional(),
  evidence: z.object({ unfreezeDelayDays: z.number().nullable(), rewardApr: z.null() }).nullable().optional(),
  value: z.object({ pairAddress: z.string(), reserveUsdtRaw: z.string(), reserveTrxRaw: z.string(),
    feeAssumptionVerified: z.literal(false) }).optional() });
const responseSchema = z.object({ protectedUsdt: z.string(), candidateUsdt: z.string(),
  pool: result, stake: result, reason: z.string().nullable(), executionReady: z.literal(false),
  preview: z.object({ inputUsdt: z.string(), trxOutAtSnapshot: z.string(),
    usdtBackImmediateAtSnapshot: z.string(), immediateRoundTripLossUsdt: z.string(),
    feeAssumption: z.string(), futureExitUsdt: z.null(), networkCostUsdt: z.null(),
    stakeRewardApr: z.null(), eligibleForPlan: z.literal(false) }).nullable() });

export function FundingPanel({ needs }: { needs: UserNeeds | null }) {
  const [data, setData] = useState<z.infer<typeof responseSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const needsKey = needs ? JSON.stringify(needs) : '';
  useEffect(() => { requestId.current++; setData(null); setError(''); setBusy(false); }, [needsKey]);
  const canRead = needs?.chain === 'mainnet' && needs.asset.symbol === 'USDT'
    && needs.confirmedVersion === needs.inputVersion;
  const read = async () => {
    if (!canRead || !needs) return;
    const currentRequest = ++requestId.current;
    setBusy(true); setData(null); setError('');
    try {
      const response = await fetch('/api/funding', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needs }) });
      const raw: unknown = await response.json();
      if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(raw).data?.error ?? '조회 실패');
      const parsed = responseSchema.parse(raw);
      if (currentRequest === requestId.current) setData(parsed);
    } catch (cause) { if (currentRequest === requestId.current) setError(cause instanceof Error ? cause.message : '조회 실패'); }
    finally { if (currentRequest === requestId.current) setBusy(false); }
  };
  return <section className="surface plans-surface" aria-label="USDT와 TRX 자금 전환 예시">
    <div className="market-header"><div><p className="overline">READ ONLY · FUNDING</p><h2>TRX 스테이킹 진입 경로</h2>
      <p>지출·예비액을 제외한 USDT를 TRX로 바꾸는 경우를 현재 SunSwap 풀 잔고로만 계산합니다.</p></div>
      <button className="refresh-button" type="button" disabled={!canRead || busy} onClick={() => void read()}>
        {busy ? '조회 중…' : '풀·해제 기간 조회'}</button></div>
    {!canRead && <p className="market-state">입력 조건을 확인하면 조회할 수 있습니다.</p>}
    {error && <p className="market-state error" role="alert">{error}</p>}
    {data && <div className="market-state" role="status">
      <p>보호액 {data.protectedUsdt} USDT · 전환 검토 상한 {data.candidateUsdt} USDT</p>
      <p>SunSwap 풀: {data.pool.status === 'ready' ? `조회됨 · ${data.pool.value?.pairAddress}` : data.pool.reason ?? '미확인'}
        {' · '}Stake 2.0 해제 대기: {data.stake.evidence?.unfreezeDelayDays === null
          || data.stake.evidence?.unfreezeDelayDays === undefined ? '미확인' : `${data.stake.evidence.unfreezeDelayDays}일`}</p>
      {data.preview && <p>현재 잔고와 교환당 0.3% 수수료 <b>가정</b>: {data.preview.inputUsdt} USDT → {data.preview.trxOutAtSnapshot} TRX.
        즉시 되돌리는 수학적 예시는 {data.preview.usdtBackImmediateAtSnapshot} USDT (차이 {data.preview.immediateRoundTripLossUsdt} USDT)입니다.</p>}
      {data.reason && <p>{data.reason}</p>}
      <p>실제 풀 수수료·슬리피지 제한·거래 Energy/Bandwidth·미래 TRX 가격·SR 보상 APR이 검증되지 않았습니다. 미래 출구 금액과 순익은 계산하지 않으며 스테이킹 권고나 거래 경로가 아닙니다.</p>
      {data.pool.status === 'ready' && <small>풀 조회 {new Date(data.pool.source.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST · <a href={data.pool.source.sourceUrl} target="_blank" rel="noreferrer">RPC 원천 ↗</a></small>}
    </div>}
  </section>;
}
