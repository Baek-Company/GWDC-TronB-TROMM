import { useState } from 'react';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { replayScenario, type ReplayScenarioResult } from '../../../shared/replay';
import { productQuoteSchema, sourceSchema, userNeedsSchema } from '../../../shared/schemas';

const baseFrame = z.object({
  id: z.string().min(1), at: z.string().datetime({ offset: true }),
  needs: userNeedsSchema, needsMode: z.enum(['snapshot', 'synthetic']), source: sourceSchema,
});
const frameSchema = z.discriminatedUnion('path', [
  baseFrame.extend({ path: z.literal('mainnet'), quotes: z.object({
    jUsdt: productQuoteSchema.nullable(), jUsdd: productQuoteSchema.nullable(),
  }) }),
  baseFrame.extend({ path: z.literal('nile'), quote: productQuoteSchema.nullable(),
    walletBalance: z.string().nullable().optional(), feeReserve: z.string().nullable().optional() }),
]);
const scenarioSchema = z.object({ id: z.string().min(1), frames: z.array(frameSchema).min(1).max(100) });

export function ReplayPanel() {
  const [result, setResult] = useState<ReplayScenarioResult | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (file: File | undefined) => {
    if (!file) return;
    setResult(null); setError(''); setFilename(file.name); setBusy(true);
    try {
      if (file.size > 1_000_000) throw new Error('재생 JSON은 1 MB 이하로 준비해 주세요.');
      const parsed: unknown = JSON.parse(await file.text());
      const scenario = scenarioSchema.parse(parsed);
      setResult(replayScenario(scenario));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '재생 자료를 확인할 수 없습니다.');
    } finally { setBusy(false); }
  };

  return <section className="surface replay-panel" aria-label="과거 또는 가상 계획 재생">
    <div className="market-header"><div><p className="overline">SCENARIO REPLAY</p><h2>과거·가상 자료로 계획 재평가</h2>
      <p>시각별 입력과 상품 근거를 담은 JSON을 불러옵니다. 결과는 해당 시점의 고정 금리 가정이며 실제 수익이나 거래 기록이 아닙니다.</p></div>
      <label className="refresh-button replay-upload">JSON 불러오기<input type="file" accept=".json,application/json" onChange={event => void load(event.target.files?.[0])} /></label>
    </div>
    {filename && <p className="micro-note">파일: {filename}</p>}
    {busy && <p role="status">자료를 검증하고 계획을 다시 계산하고 있습니다…</p>}
    {error && <p className="market-state error" role="alert">{error}</p>}
    {result && <><p className="micro-note">시나리오 {result.id} · {result.frames.length}개 시점 · 거래 실행 불가 · 실제 수익 미산출</p>
      <div className="replay-frames">{result.frames.map(frame => {
        const leader = frame.plans.find(plan => plan.id === frame.projectedLeaderId);
        return <article className="source-card" key={frame.id}><div><h3>{frame.id}</h3><span className="source-status unknown">{frame.displayMode === 'snapshot' ? '과거 자료' : frame.displayMode === 'synthetic' ? '가상 자료' : '혼합 자료'}</span></div>
          <p>{new Date(frame.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST · {frame.path.toUpperCase()}</p>
          <p>{leader ? `가정상 선두: ${leader.kind} · 예상 순익 ${new Decimal(leader.netYield!).toDecimalPlaces(6).toString()} ${leader.inputToken.symbol}` : '검증된 순익과 적격성을 충족한 후보가 없습니다.'}</p>
          <small>출처 {frame.source.sourceUrl.startsWith('https://')
            ? <a href={frame.source.sourceUrl} target="_blank" rel="noreferrer">확인 ↗</a>
            : <span>{frame.source.sourceUrl}</span>} · 실제 수익은 기록하지 않음</small>
        </article>;
      })}</div></>}
  </section>;
}
