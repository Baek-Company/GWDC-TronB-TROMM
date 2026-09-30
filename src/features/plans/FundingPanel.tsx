import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { UserNeeds } from '../../../shared/schemas';

const fundingMessages: readonly (readonly [string, string])[] = [
  ["{0} 계정 상태가 반환되지 않아 잔액을 확인하지 못했습니다.", "{0} did not return account state, so the balance could not be verified."],
  ["{0} 응답 계정 주소가 요청 주소와 다릅니다.", "{0} returned an account address different from the requested address."],
  ["{0} 응답 잔액이 안전한 정수 형식이 아닙니다.", "{0} returned a balance that is not a safe integer."],
  ["{0} 응답 시간이 초과되었습니다.", "{0} response timed out."],
  ["{0} 요청이 중단되었습니다.", "{0} request was cancelled."],
  ["{0} 호스트 DNS 조회에 실패했습니다.", "{0} host DNS lookup failed."],
  ["{0} 연결이 거부되었습니다.", "{0} connection was refused."],
  ["{0} 연결 또는 응답 검증에 실패했습니다.", "{0} connection or response verification failed."],
  ["조회 실패", "Retrieval failed"],
  ["Mainnet USDT 조건이 필요합니다.", "Mainnet USDT inputs are required."],
  ["교환 예시를 계산할 수 없습니다.", "The swap example could not be calculated."],
  ["USDT 금액은 소수점 6자리까지 입력해 주세요.", "Enter USDT amounts with up to six decimal places."],
  ["교환 금액 또는 풀 잔고가 유효하지 않습니다.", "The swap amount or pool balance is invalid."],
  ["풀 잔고 대비 교환 금액이 유효하지 않습니다.", "The swap amount is invalid relative to pool balances."],
  ["교환 결과가 토큰 최소 단위에 미치지 못합니다.", "The swap output is below the token's smallest unit."],
];

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
  const { t, locale } = useI18n();
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
      if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(raw).data?.error ?? t("조회 실패", "Retrieval failed"));
      const parsed = responseSchema.parse(raw);
      if (currentRequest === requestId.current) setData(parsed);
    } catch (cause) { if (currentRequest === requestId.current) setError(cause instanceof Error ? cause.message : t("조회 실패", "Retrieval failed")); }
    finally { if (currentRequest === requestId.current) setBusy(false); }
  };
  return <section className="surface plans-surface" aria-label={t("USDT와 TRX 자금 전환 예시", "USDT to TRX funding example")}>
    <div className="market-header"><div><p className="overline">READ ONLY · FUNDING</p><h2>{t("TRX 스테이킹 진입 경로", "TRX staking entry route")}</h2>
      <p>{t("지출·예비액을 제외한 USDT를 TRX로 바꾸는 경우를 현재 SunSwap 풀 잔고로만 계산합니다.", "Models conversion of USDT remaining after expenses and reserves into TRX using only current SunSwap pool balances.")}</p></div>
      <button className="refresh-button" type="button" disabled={!canRead || busy} onClick={() => void read()}>
        {busy ? t("조회 중…", "Loading…") : t("풀·해제 기간 조회", "Check pool and unstaking delay")}</button></div>
    {!canRead && <p className="market-state">{t("입력 조건을 확인하면 조회할 수 있습니다.", "Confirm your inputs to retrieve data.")}</p>}
    {error && <p className="market-state error" role="alert">{localizeKnownText(error, t, fundingMessages)}</p>}
    {data && <div className="market-state" role="status">
      <p>{t("보호액 ", "Protected amount ")}{data.protectedUsdt}{t(" USDT · 전환 검토 상한 ", " USDT · Conversion cap ")}{data.candidateUsdt} USDT</p>
      <p>{t("SunSwap 풀: ", "SunSwap pool: ")}{data.pool.status === 'ready' ? t(`조회됨 · ${data.pool.value?.pairAddress}`, `Retrieved · ${data.pool.value?.pairAddress}`) : (data.pool.reason ? localizeKnownText(data.pool.reason.replace('SunSwap USDT/TRX 풀', t('SunSwap USDT/TRX 풀', 'SunSwap USDT/TRX pool')), t, fundingMessages) : null) ?? t("미확인", "Unverified")}
        {' · '}{t("Stake 2.0 해제 대기: ", "Stake 2.0 unstaking delay: ")}{data.stake.evidence?.unfreezeDelayDays === null
          || data.stake.evidence?.unfreezeDelayDays === undefined ? t("미확인", "Unverified") : t(`${data.stake.evidence.unfreezeDelayDays}일`, `${data.stake.evidence.unfreezeDelayDays} days`)}</p>
      {data.preview && <p>{t("현재 잔고와 교환당 0.3% 수수료 ", "Current balances and a 0.3% fee per swap ")}<b>{t("가정", "assumption")}</b>: {data.preview.inputUsdt} USDT → {data.preview.trxOutAtSnapshot} TRX.
        즉시 되돌리는 수학적 예시는 {data.preview.usdtBackImmediateAtSnapshot}{t(" USDT (차이 ", " USDT (difference ")}{data.preview.immediateRoundTripLossUsdt}{t(" USDT)입니다.", " USDT).")}</p>}
      {data.reason && <p>{localizeKnownText(data.reason, t, fundingMessages)}</p>}
      <p>{t("실제 풀 수수료·슬리피지 제한·거래 Energy/Bandwidth·미래 TRX 가격·SR 보상 APR이 검증되지 않았습니다. 미래 출구 금액과 순익은 계산하지 않으며 스테이킹 권고나 거래 경로가 아닙니다.", "Actual pool fees, slippage limits, transaction Energy/Bandwidth, future TRX prices, and SR reward APR are unverified. Future exit amounts and net yield are not calculated. This is not a staking recommendation or an executable route.")}</p>
      {data.pool.status === 'ready' && <small>{t("풀 조회 ", "Pool retrieved ")}{new Date(data.pool.source.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST · <a href={data.pool.source.sourceUrl} target="_blank" rel="noreferrer">{t("RPC 원천 ↗", "RPC source ↗")}</a></small>}
    </div>}
  </section>;
}
