import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { ConversationFields } from '../../../server/llm/conversation';
import type { Profile } from '../../lib/session';
import { useI18n, type Translate } from '../../lib/i18n';
import { RequestGate } from './requestGate';

const amount = z.string().regex(/^\d+(?:\.\d+)?$/).nullable();
const fieldsSchema = z.object({
  asset: z.enum(['USDT', 'USDD', 'TRX']).nullable(),
  holdings: amount,
  horizonDays: z.number().int().min(1).max(3650).nullable(),
  expense: amount,
  expenseDay: z.number().int().min(1).max(3650).nullable(),
  reserve: amount,
  risk: z.enum(['conservative', 'balanced', 'growth']).nullable(),
  acceptsUsddRisk: z.boolean().nullable(),
});
const responseSchema = z.object({
  provider: z.enum(['nim', 'template']),
  model: z.string().nullable(),
  reason: z.enum(['not_configured', 'provider_error']).nullable(),
  fields: fieldsSchema,
  updates: fieldsSchema,
  nextQuestion: z.string().nullable(),
  complete: z.boolean(),
});

const empty: ConversationFields = {
  asset: null, holdings: null, horizonDays: null, expense: null,
  expenseDay: null, reserve: null, risk: null, acceptsUsddRisk: null,
};

type ChatResponse = z.infer<typeof responseSchema>;
type ProfileField = Exclude<keyof ConversationFields, 'asset'>;
const profileFields: ProfileField[] = [
  'holdings', 'horizonDays', 'expense', 'expenseDay', 'reserve', 'risk', 'acceptsUsddRisk',
];
const getFieldLabels = (t: Translate): Record<ProfileField, string> => ({
  holdings: t("보유 금액", "Holdings"), horizonDays: t("운용 기간", "Investment period"), expense: t("예정 지출액", "Scheduled expense amount"),
  expenseDay: t("지출까지 남은 기간", "Days until expense"), reserve: t("비상 예비액", "Emergency reserve"), risk: t("위험 성향", "Risk preference"),
  acceptsUsddRisk: t("USDD 위험 동의", "USDD risk consent"),
});
function profileValue(profile: Profile, key: ProfileField): string | boolean {
  return profile[key];
}
function displayValue(value: string | number | boolean, t: Translate): string {
  if (typeof value === 'boolean') return value ? t("동의", "Accepted") : t("동의하지 않음", "Not accepted");
  if (value === 'conservative') return t("보수형", "Conservative");
  if (value === 'balanced') return t("균형형", "Balanced");
  if (value === 'growth') return t("성장형", "Growth");
  return String(value);
}
export function profileChangeCandidates(profile: Profile, updates: ConversationFields, t: Translate = ko => ko) {
  const fieldLabels = getFieldLabels(t);
  return profileFields.flatMap(key => {
    const after = updates[key];
    if (after === null || String(profileValue(profile, key)) === String(after)) return [];
    return [{ key, label: fieldLabels[key], before: displayValue(profileValue(profile, key), t),
      after: displayValue(after, t) }];
  });
}

export function ChatPanel({ profile, onFields }: {
  profile: Profile; onFields: (fields: ConversationFields) => void;
}) {
  const { t, language } = useI18n();
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState<ConversationFields>(empty);
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [mode, setMode] = useState<'nim' | 'template' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ result: ChatResponse; base: Profile;
    changes: ReturnType<typeof profileChangeCandidates> } | null>(null);
  const requestGate = useRef(new RequestGate());
  useEffect(() => () => requestGate.current.cancel(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = message.trim();
    if (!value || busy || pending) return;
    const request = requestGate.current.start();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: value, current: fields, language }),
        signal: request.signal,
      });
      const raw = await response.json() as unknown;
      if (!request.isCurrent()) return;
      if (!response.ok) throw new Error(t("대화 분석 요청을 처리하지 못했습니다.", "Could not process the conversation analysis request."));
      const result = responseSchema.parse(raw);
      if (result.updates.asset && result.updates.asset !== 'USDT') {
        throw new Error(t("이 화면은 USDT 시연 조건만 지원합니다. 다른 자산은 별도 계획에서 입력해 주세요.", "This screen supports USDT demo conditions only. Enter other assets in a separate plan."));
      }
      const riskNeedsReconfirmation = /\bUSDD\b/i.test(value)
        && result.fields.acceptsUsddRisk === null && profile.acceptsUsddRisk;
      if (riskNeedsReconfirmation) onFields({ ...empty, acceptsUsddRisk: false });
      const changes = profileChangeCandidates(profile, result.updates, t);
      setMode(result.provider);
      setTurns(current => [...current, { role: 'user', text: value },
        { role: 'assistant', text: riskNeedsReconfirmation
          ? t("USDD 위험 동의가 불명확하여 기존 동의를 해제했습니다. 다시 명확히 답해 주세요.", "Your existing USDD consent was cleared because the new answer was unclear. Please answer explicitly again.")
          : changes.length > 0 ? t("저장된 조건과 다른 값을 찾았습니다. 아래 변경을 확인해 주세요.", "Some values differ from the saved conditions. Review the changes below.")
          : result.nextQuestion ?? t("필요한 조건을 모았습니다. 아래 입력값을 검토한 뒤 확인해 주세요.", "The required conditions are collected. Review and confirm the inputs below.") }]);
      if (changes.length > 0) setPending({ result, base: profile, changes });
      else setFields(result.fields);
      setMessage('');
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : t("대화 분석에 실패했습니다.", "Conversation analysis failed."));
    } finally { if (request.isCurrent()) setBusy(false); }
  };

  const acceptPending = () => {
    if (!pending) return;
    if (pending.changes.some(change => profileValue(profile, change.key) !== profileValue(pending.base, change.key))) {
      setPending(null);
      setError(t("조건이 다른 입력에서 바뀌었습니다. 현재 값을 확인하고 문장을 다시 분석해 주세요.", "The conditions changed in another input. Check the current values and analyze your message again."));
      return;
    }
    onFields(pending.result.updates);
    setFields(pending.result.fields);
    setTurns(current => [...current, { role: 'assistant',
      text: pending.result.nextQuestion ?? t("변경한 조건을 적용했습니다. 아래 입력값을 검토한 뒤 확인해 주세요.", "The updated conditions were applied. Review and confirm the inputs below.") }]);
    setPending(null);
  };
  const rejectPending = () => {
    setPending(null);
    setTurns(current => [...current, { role: 'assistant', text: t("저장된 조건을 유지했습니다. 수정하려는 항목과 금액을 다시 말씀해 주세요.", "The saved conditions were kept. Please state the field and amount you want to change.") }]);
  };
  const reset = () => {
    requestGate.current.cancel();
    setBusy(false); setPending(null); setFields(empty); setTurns([]);
    setMode(null); setMessage(''); setError('');
  };

  return <section className="surface conversation-panel" aria-label={t("대화로 조건 입력", "Enter conditions through conversation")}>
    <div className="panel-head"><div><span className="panel-step">AI</span><h3>{t("대화로 조건 정리", "Set conditions through conversation")}</h3></div><button className="text-button" type="button" onClick={reset}>{t("새 대화 ↺", "New conversation ↺")}</button></div>
    <p className="conversation-disclosure">{t("NIM 서버 키가 설정된 경우에만 입력 문장이 NVIDIA로 전송됩니다. 키가 없거나 연결에 실패하면 템플릿 분석으로 전환되며, 수익 계산과 거래 여부는 AI가 결정하지 않습니다.", "Your message is sent to NVIDIA only when the NIM server key is configured. If no key is available or the connection fails, template analysis is used. AI does not decide yield calculations or whether to trade.")}</p>
    <p className="conversation-disclosure">{t("새 대화는 대화 문맥만 초기화합니다. 아래 저장된 조건과 다른 값은 사용자님이 변경을 확인한 뒤 적용됩니다.", "A new conversation resets only the conversation context. Values that differ from your saved conditions are applied only after you confirm the change.")}</p>
    {mode && <p className={`conversation-mode ${mode}`}>{mode === 'nim' ? 'NIM · openai/gpt-oss-20b' : t("템플릿 분석 · AI 연결 없음", "Template analysis · No AI connection")}</p>}
    <div className="conversation-turns" aria-live="polite">
      {turns.length === 0 ? <p className="conversation-empty">{t("“1,000 USDT를 30일 운용하고 7일 뒤 200 USDT가 필요해요”처럼 말씀해 주세요.", "Describe your holdings, period and scheduled expenses. Free-text analysis currently supports Korean primarily; you can also use the form below.")}</p>
        : turns.map((turn, index) => <p key={index} className={`conversation-turn ${turn.role}`}><small>{turn.role === 'user' ? t("사용자님", "You") : t("조건 확인", "Confirm conditions")}</small>{turn.text}</p>)}
    </div>
    {pending && <div className="conversation-review" role="group" aria-label={t("대화 변경 후보", "Proposed conversation changes")}>
      <strong>{t("조건 변경 확인", "Confirm condition changes")}</strong>
      <ul>{profileChangeCandidates(pending.base, pending.result.updates, t).map(change => <li key={change.key}>{change.label}: {change.before} → {change.after}</li>)}</ul>
      <div><button type="button" onClick={acceptPending}>{t("변경 적용", "Apply changes")}</button><button type="button" onClick={rejectPending}>{t("기존 조건 유지", "Keep existing conditions")}</button></div>
    </div>}
    <form className="conversation-form" onSubmit={event => void submit(event)}>
      <label htmlFor="needs-chat-input">{t("계획 조건을 문장으로 입력", "Enter plan conditions in a sentence")}</label>
      <div><input id="needs-chat-input" value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} placeholder={t("보유액, 기간, 예정 지출을 알려주세요", "Tell us your holdings, period and scheduled expenses")} disabled={Boolean(pending)} /><button type="submit" disabled={busy || Boolean(pending) || !message.trim()}>{busy ? t("분석 중…", "Analyzing…") : t("문장 분석", "Analyze message")}</button></div>
    </form>
    {error && <p className="input-error" role="alert">{error}</p>}
  </section>;
}
