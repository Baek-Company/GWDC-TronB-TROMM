import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useState } from 'react';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { replayScenario, type ReplayScenarioResult } from '../../../shared/replay';
import { productQuoteSchema, sourceSchema, userNeedsSchema } from '../../../shared/schemas';

const replayMessages: readonly (readonly [string, string])[] = [
  ["재생 JSON은 1 MB 이하로 준비해 주세요.", "Replay JSON must be no larger than 1 MB."],
  ["재생 자료를 확인할 수 없습니다.", "Replay data could not be verified."],
];

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
  const { t, locale } = useI18n();
  const [result, setResult] = useState<ReplayScenarioResult | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (file: File | undefined) => {
    if (!file) return;
    setResult(null); setError(''); setFilename(file.name); setBusy(true);
    try {
      if (file.size > 1_000_000) throw new Error(t("재생 JSON은 1 MB 이하로 준비해 주세요.", "Replay JSON must be no larger than 1 MB."));
      const parsed: unknown = JSON.parse(await file.text());
      const scenario = scenarioSchema.parse(parsed);
      setResult(replayScenario(scenario));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("재생 자료를 확인할 수 없습니다.", "Replay data could not be verified."));
    } finally { setBusy(false); }
  };

  return <section className="surface replay-panel" aria-label={t("과거 또는 가상 계획 재생", "Historical or hypothetical plan replay")}>
    <div className="market-header"><div><p className="overline">SCENARIO REPLAY</p><h2>{t("과거·가상 자료로 계획 재평가", "Reassess plans with historical or synthetic data")}</h2>
      <p>{t("시각별 입력과 상품 근거를 담은 JSON을 불러옵니다. 결과는 해당 시점의 고정 금리 가정이며 실제 수익이나 거래 기록이 아닙니다.", "Load JSON containing inputs and product evidence for each timestamp. Results assume a fixed rate at that point in time and are not actual returns or transaction records.")}</p></div>
      <label className="refresh-button replay-upload">{t("JSON 불러오기", "Load JSON")}<input type="file" accept=".json,application/json" onChange={event => void load(event.target.files?.[0])} /></label>
    </div>
    {filename && <p className="micro-note">{t("파일: ", "File: ")}{filename}</p>}
    {busy && <p role="status">{t("자료를 검증하고 계획을 다시 계산하고 있습니다…", "Validating data and recalculating plans…")}</p>}
    {error && <p className="market-state error" role="alert">{localizeKnownText(error, t, replayMessages)}</p>}
    {result && <><p className="micro-note">{t("시나리오 ", "Scenario ")}{result.id} · {result.frames.length}{t("개 시점 · 거래 실행 불가 · 실제 수익 미산출", " timestamps · No execution · Actual returns not calculated")}</p>
      <div className="replay-frames">{result.frames.map(frame => {
        const leader = frame.plans.find(plan => plan.id === frame.projectedLeaderId);
        return <article className="source-card" key={frame.id}><div><h3>{frame.id}</h3><span className="source-status unknown">{frame.displayMode === 'snapshot' ? t("과거 자료", "Historical data") : frame.displayMode === 'synthetic' ? t("가상 자료", "Synthetic data") : t("혼합 자료", "Mixed data")}</span></div>
          <p>{new Date(frame.at).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST · {frame.path.toUpperCase()}</p>
          <p>{leader ? t(`가정상 선두: ${leader.kind} · 예상 순익 ${new Decimal(leader.netYield!).toDecimalPlaces(6).toString()} ${leader.inputToken.symbol}`, `Hypothetical leader: ${leader.kind} · Estimated net yield ${new Decimal(leader.netYield!).toDecimalPlaces(6).toString()} ${leader.inputToken.symbol}`) : t("검증된 순익과 적격성을 충족한 후보가 없습니다.", "No candidate meets verified net-yield and eligibility requirements.")}</p>
          <small>{t("출처 ", "Source ")}{frame.source.sourceUrl.startsWith('https://')
            ? <a href={frame.source.sourceUrl} target="_blank" rel="noreferrer">{t("확인 ↗", "View ↗")}</a>
            : <span>{frame.source.sourceUrl}</span>}{t(" · 실제 수익은 기록하지 않음", " · Actual returns are not recorded")}</small>
        </article>;
      })}</div></>}
  </section>;
}
