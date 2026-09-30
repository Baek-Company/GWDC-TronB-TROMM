import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { sourceSchema } from '../../../shared/schemas';

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
const labels = { psm: 'USDD PSM', stake: 'TRON Stake 2.0·투표', sun: 'SUN.io 안정화폐 풀',
  justlend: 'JustLend MCP', usdd: 'USDD MCP', trongrid: 'TronGrid MCP 도구 목록',
  trongridRead: 'TronGrid MCP 최신 블록 이벤트 조회' };
const statuses = { ready: '조회됨', unknown: '조건 미확인', unavailable: '조회 불가' };

export function SourcesPanel() {
  const initialRead = useRef(false);
  const [data, setData] = useState<Sources | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/sources');
      const raw: unknown = await response.json();
      if (!response.ok) throw new Error('상품 원천 상태를 조회하지 못했습니다.');
      setData(responseSchema.parse(raw));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '상품 원천 조회 실패'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (!initialRead.current) { initialRead.current = true; void refresh(); } }, []);
  const entries = data ? [
    ['psm', data.psm], ['stake', data.stake], ['sun', data.sun],
    ['justlend', data.mcp.justlend], ['usdd', data.mcp.usdd], ['trongrid', data.mcp.trongrid],
    ['trongridRead', data.trongridRead],
  ] as const : [];
  const psmCapacity = psmCapacitySchema.safeParse(data?.psm.value).data;
  return <section className="surface sources-panel" aria-label="추가 상품 원천 상태">
    <div className="market-header"><div><p className="overline">PRODUCT SOURCES</p><h2>상품 원천과 제외 근거</h2><p>조회 성공과 USDT 계획에 실제 적용 가능한 상태는 별도로 표시합니다.</p></div><button className="refresh-button" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '확인 중…' : '원천 다시 확인'}</button></div>
    {error && <div className="market-state error" role="alert">{error}</div>}
    {busy && !data && <div className="market-state" role="status">공식 원천의 읽기 상태를 확인 중입니다…</div>}
    <div className="source-grid">{entries.map(([key, item]) => <article className="source-card" key={key}>
      <div><h3>{labels[key]}</h3><span className={`source-status ${item.status}`}>{statuses[item.status]}</span></div>
      <p>{item.reason || item.reasons?.join(' · ') || (item.status === 'ready' ? '원천 조회가 확인됐습니다. 적용 조건은 별도 검증이 필요합니다.' : '확인 근거가 부족합니다.')}</p>
      {key === 'psm' && psmCapacity && <p>진입 상한 {psmCapacity.entryCapacity ?? '미확인'} USDT · 출구 보수적 상한 {psmCapacity.exitCapacity ?? '미확인'} USDD · 진입 수수료율 {psmCapacity.entryFeeRate} · 출구 수수료율 {psmCapacity.exitFeeRate}. {psmCapacity.planReady ? '계획 근거 확인' : '왕복 거래비용 미확인으로 계획 실행 불가'}</p>}
      <small>{item.source.chain.toUpperCase()} · {new Date(item.source.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST · <a href={item.source.sourceUrl} target="_blank" rel="noreferrer">출처 ↗</a></small>
    </article>)}</div>
  </section>;
}
