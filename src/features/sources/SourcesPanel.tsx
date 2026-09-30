import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { sourceSchema } from '../../../shared/schemas';

const sourceMessages: readonly (readonly [string, string])[] = [
  ["{0} 계정 상태가 반환되지 않아 잔액을 확인하지 못했습니다.", "{0} did not return account state, so the balance could not be verified."],
  ["{0} 응답 계정 주소가 요청 주소와 다릅니다.", "{0} returned an account address different from the requested address."],
  ["{0} 응답 잔액이 안전한 정수 형식이 아닙니다.", "{0} returned a balance that is not a safe integer."],
  ["{0} 응답 시간이 초과되었습니다.", "{0} response timed out."],
  ["{0} 요청이 중단되었습니다.", "{0} request was cancelled."],
  ["{0} 호스트 DNS 조회에 실패했습니다.", "{0} host DNS lookup failed."],
  ["{0} 연결이 거부되었습니다.", "{0} connection was refused."],
  ["{0} 연결 또는 응답 검증에 실패했습니다.", "{0} connection or response verification failed."],
  ["상품 원천 상태를 조회하지 못했습니다.", "Failed to retrieve product source status."],
  ["상품 원천 조회 실패", "Product source retrieval failed"],
  ["공식 MCP 읽기 호출은 성공했지만 결과 필드·단위는 아직 검증하지 않았습니다.", "The official MCP read call succeeded, but output fields and units remain unverified."],
  ["공식 조회 도구를 tools/list에서 확인하지 못했습니다.", "Official read tools could not be verified in tools/list."],
  ["TronGrid MCP 읽기 허용 목록 밖 도구입니다.", "This tool is outside the TronGrid MCP read allowlist."],
  ["TronGrid MCP 조회 인자 형식을 확인해 주세요.", "Check the TronGrid MCP read argument format."],
  ["공식 MCP 응답에서 요청한 조회 도구를 확인하지 못했습니다.", "The requested read tool could not be verified in the official MCP response."],
  ["공개 지갑 주소 형식이 올바르지 않습니다.", "The public wallet address format is invalid."],
  ["Stake 2.0은 TRX를 예치하므로 Mainnet USDT 입력에는 별도 USDT→TRX 전환이 필요합니다.", "Stake 2.0 deposits TRX, so Mainnet USDT inputs require a separate USDT-to-TRX conversion."],
  ["투표 보상 APR은 SR·투표량·브로커리지에 따라 달라져 현재 조회값만으로 확정할 수 없습니다.", "Voting reward APR depends on the SR, vote count, and brokerage, so current retrieved values alone cannot confirm it."],
  ["USDT로 돌아오는 출구 견적과 거래 비용이 확인되지 않았습니다.", "The exit quote back to USDT and transaction costs are unverified."],
  ["온체인 해제 대기 기간 미확인", "On-chain unstaking delay unverified"],
  ["온체인 해제 대기 기간 {0}일", "On-chain unstaking delay: {0} days"],
  ["SUN.io 조회 결과에서 Mainnet USDT/USDD 주소로 검증된 풀을 찾지 못했습니다.", "No pool with verified Mainnet USDT/USDD addresses was found in the SUN.io response."],
  ["풀 통계는 조회됐지만 단일 USDT 진입·LP 토큰·회수 경로와 왕복 비용이 확인되지 않았습니다.", "Pool statistics were retrieved, but single-USDT entry, LP tokens, redemption routes, and round-trip costs are unverified."],
  ["풀의 토큰 잔고나 표시 APR만으로 사용자 출금 가능량과 확정 수익을 보장할 수 없습니다.", "Pool token balances or displayed APR cannot guarantee your withdrawal capacity or returns."],
  ["Mainnet PSM, USDT, USDD 또는 jUSDD 계약 코드가 확인되지 않았습니다.", "Mainnet PSM, USDT, USDD, or jUSDD contract code is unverified."],
  ["JustLend REST의 현재 jUSDD 주소가 공식 배포 후보와 일치하지 않습니다.", "The current jUSDD address in JustLend REST does not match the official deployment candidate."],
  ["PSM 실제 출력 USDD 토큰 주소 미확인", "Actual PSM output USDD token address unverified"],
  ["PSM GemJoin 주소가 배포 후보와 불일치", "PSM GemJoin address does not match the deployment candidate"],
  ["PSM 실제 입력 USDT 토큰 주소 미확인", "Actual PSM input USDT token address unverified"],
  ["USDT→USDD 전환 비활성", "USDT-to-USDD conversion inactive"],
  ["USDD→USDT 전환 비활성", "USDD-to-USDT conversion inactive"],
  ["PSM 출력 USDD와 jUSDD 기초자산 불일치", "PSM output USDD does not match the jUSDD underlying asset"],
  ["PSM 입력 USDT 주소 불일치", "PSM input USDT address mismatch"],
  ["PSM 출력 USDD 주소가 공식 배포 후보와 불일치", "PSM output USDD address does not match the official deployment candidate"],
  ["JustLend REST 기초자산과 온체인 기초자산 불일치", "JustLend REST underlying asset does not match the on-chain underlying asset"],
  ["PSM·GemJoin의 Vat/ilk 연결 또는 토큰 소수점 불일치", "PSM/GemJoin Vat/ilk connection or token decimal mismatch"],
  ["Vat 부채 한도에서 PSM 진입 용량 확인 실패", "Failed to verify PSM entry capacity from the Vat debt ceiling"],
  ["GemJoin USDT 잔고에서 PSM 출구 유동성 확인 실패", "Failed to verify PSM exit liquidity from the GemJoin USDT balance"],
  ["PSM 양방향 용량의 계약 연결 확인 실패", "Failed to verify contract connections for two-way PSM capacity"],
  ["PSM 양방향 수량 한도와 실제 사용 가능 유동성 미확인", "Two-way PSM amount limits and available liquidity unverified"],
  ["PSM 수수료 범위 검증 실패", "PSM fee range verification failed"],
  ["승인·전환·예치·인출 거래의 Energy/Bandwidth 비용 미확인", "Energy/Bandwidth costs for approval, conversion, deposit, and withdrawal unverified"],
  ["jUSDD 시장 비활성", "jUSDD market inactive"],
  ["jUSDD 시장 활성 상태 미확인", "jUSDD market activity unverified"],
];

const resultSchema = z.object({
  status: z.enum(['ready', 'unknown', 'unavailable']),
  source: sourceSchema,
  reason: z.string().optional(), reasons: z.array(z.string()).optional(),
  evidence: z.unknown().optional(), value: z.unknown().optional(),
});
const responseSchema = z.object({
  psm: resultSchema, stake: resultSchema, sun: resultSchema, trongridRead: resultSchema,
  mcp: z.object({ justlend: resultSchema, usdd: resultSchema, trongrid: resultSchema }),
});
type Sources = z.infer<typeof responseSchema>;
const psmCapacitySchema = z.object({ entryCapacity: z.string().nullable(), exitCapacity: z.string().nullable(),
  entryFeeRate: z.string(), exitFeeRate: z.string(), planReady: z.boolean(), missing: z.array(z.string()) });
export function SourcesPanel() {
  const { t, locale } = useI18n();
  const labels = { psm: 'USDD PSM', stake: t("TRON Stake 2.0·투표", "TRON Stake 2.0 / Voting"), sun: t("SUN.io 안정화폐 풀", "SUN.io stablecoin pool"),
    justlend: 'JustLend MCP', usdd: 'USDD MCP', trongrid: t("TronGrid MCP 도구 목록", "TronGrid MCP tool list"),
    trongridRead: t("TronGrid MCP 최신 블록 이벤트 조회", "TronGrid MCP latest block events") };
  const statuses = { ready: t("조회됨", "Retrieved"), unknown: t("조건 미확인", "Conditions unverified"), unavailable: t("조회 불가", "Unavailable") };

  const initialRead = useRef(false);
  const [data, setData] = useState<Sources | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/sources');
      const raw: unknown = await response.json();
      if (!response.ok) throw new Error(t("상품 원천 상태를 조회하지 못했습니다.", "Failed to retrieve product source status."));
      setData(responseSchema.parse(raw));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("상품 원천 조회 실패", "Product source retrieval failed")); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (!initialRead.current) { initialRead.current = true; void refresh(); } }, []);
  const entries = data ? [
    ['psm', data.psm], ['stake', data.stake], ['sun', data.sun],
    ['justlend', data.mcp.justlend], ['usdd', data.mcp.usdd], ['trongrid', data.mcp.trongrid],
    ['trongridRead', data.trongridRead],
  ] as const : [];
  const displayMessage = (message: string) => message.split(' · ').map(part =>
    localizeKnownText(part.replace('SUN.io 풀 API', t('SUN.io 풀 API', 'SUN.io pool API')), t, sourceMessages)).join(' · ');
  const psmCapacity = psmCapacitySchema.safeParse(data?.psm.value).data;
  return <section className="surface sources-panel" aria-label={t("추가 상품 원천 상태", "Additional product source status")}>
    <div className="market-header"><div><p className="overline">PRODUCT SOURCES</p><h2>{t("상품 원천과 제외 근거", "Product sources and exclusion reasons")}</h2><p>{t("조회 성공과 USDT 계획에 실제 적용 가능한 상태는 별도로 표시합니다.", "Successful retrieval and actual applicability to USDT plans are shown separately.")}</p></div><button className="refresh-button" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? t("확인 중…", "Checking…") : t("원천 다시 확인", "Refresh sources")}</button></div>
    {error && <div className="market-state error" role="alert">{localizeKnownText(error, t, sourceMessages)}</div>}
    {busy && !data && <div className="market-state" role="status">{t("공식 원천의 읽기 상태를 확인 중입니다…", "Checking read access to official sources…")}</div>}
    <div className="source-grid">{entries.map(([key, item]) => <article className="source-card" key={key}>
      <div><h3>{labels[key]}</h3><span className={`source-status ${item.status}`}>{statuses[item.status]}</span></div>
      <p>{(item.reason ? displayMessage(item.reason) : item.reasons?.map(displayMessage).join(' · ')) || (item.status === 'ready' ? t("원천 조회가 확인됐습니다. 적용 조건은 별도 검증이 필요합니다.", "Source retrieval is verified. Applicability conditions require separate verification.") : t("확인 근거가 부족합니다.", "Insufficient verification evidence."))}</p>
      {key === 'psm' && psmCapacity && <p>{t("진입 상한 ", "Entry cap ")}{psmCapacity.entryCapacity ?? t("미확인", "Unverified")}{t(" USDT · 출구 보수적 상한 ", " USDT · Conservative exit cap ")}{psmCapacity.exitCapacity ?? t("미확인", "Unverified")}{t(" USDD · 진입 수수료율 ", " USDD · Entry fee rate ")}{psmCapacity.entryFeeRate}{t(" · 출구 수수료율 ", " · Exit fee rate ")}{psmCapacity.exitFeeRate}. {psmCapacity.planReady ? t("계획 근거 확인", "Plan evidence verified") : t("왕복 거래비용 미확인으로 계획 실행 불가", "Plan execution unavailable: round-trip costs are unverified")}</p>}
      <small>{item.source.chain.toUpperCase()} · {new Date(item.source.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST · <a href={item.source.sourceUrl} target="_blank" rel="noreferrer">{t("출처 ↗", "Source ↗")}</a></small>
    </article>)}</div>
  </section>;
}
