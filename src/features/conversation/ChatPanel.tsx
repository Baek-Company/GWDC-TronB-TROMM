import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { ConversationFields } from '../../../server/llm/conversation';
import type { Profile } from '../../lib/session';
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
const fieldLabels: Record<ProfileField, string> = {
  holdings: '보유 금액', horizonDays: '운용 기간', expense: '예정 지출액',
  expenseDay: '지출까지 남은 기간', reserve: '비상 예비액', risk: '위험 성향',
  acceptsUsddRisk: 'USDD 위험 동의',
};
function profileValue(profile: Profile, key: ProfileField): string | boolean {
  return profile[key];
}
function displayValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '동의' : '동의하지 않음';
  if (value === 'conservative') return '보수형';
  if (value === 'balanced') return '균형형';
  if (value === 'growth') return '성장형';
  return String(value);
}
export function profileChangeCandidates(profile: Profile, updates: ConversationFields) {
  return profileFields.flatMap(key => {
    const after = updates[key];
    if (after === null || String(profileValue(profile, key)) === String(after)) return [];
    return [{ key, label: fieldLabels[key], before: displayValue(profileValue(profile, key)),
      after: displayValue(after) }];
  });
}

export function ChatPanel({ profile, onFields }: {
  profile: Profile; onFields: (fields: ConversationFields) => void;
}) {
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
        body: JSON.stringify({ message: value, current: fields }),
        signal: request.signal,
      });
      const raw = await response.json() as unknown;
      if (!request.isCurrent()) return;
      if (!response.ok) throw new Error('대화 분석 요청을 처리하지 못했습니다.');
      const result = responseSchema.parse(raw);
      if (result.updates.asset && result.updates.asset !== 'USDT') {
        throw new Error('이 화면은 USDT 시연 조건만 지원합니다. 다른 자산은 별도 계획에서 입력해 주세요.');
      }
      const riskNeedsReconfirmation = /\bUSDD\b/i.test(value)
        && result.fields.acceptsUsddRisk === null && profile.acceptsUsddRisk;
      if (riskNeedsReconfirmation) onFields({ ...empty, acceptsUsddRisk: false });
      const changes = profileChangeCandidates(profile, result.updates);
      setMode(result.provider);
      setTurns(current => [...current, { role: 'user', text: value },
        { role: 'assistant', text: riskNeedsReconfirmation
          ? 'USDD 위험 동의가 불명확하여 기존 동의를 해제했습니다. 다시 명확히 답해 주세요.'
          : changes.length > 0 ? '저장된 조건과 다른 값을 찾았습니다. 아래 변경을 확인해 주세요.'
          : result.nextQuestion ?? '필요한 조건을 모았습니다. 아래 입력값을 검토한 뒤 확인해 주세요.' }]);
      if (changes.length > 0) setPending({ result, base: profile, changes });
      else setFields(result.fields);
      setMessage('');
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : '대화 분석에 실패했습니다.');
    } finally { if (request.isCurrent()) setBusy(false); }
  };

  const acceptPending = () => {
    if (!pending) return;
    if (pending.changes.some(change => profileValue(profile, change.key) !== profileValue(pending.base, change.key))) {
      setPending(null);
      setError('조건이 다른 입력에서 바뀌었습니다. 현재 값을 확인하고 문장을 다시 분석해 주세요.');
      return;
    }
    onFields(pending.result.updates);
    setFields(pending.result.fields);
    setTurns(current => [...current, { role: 'assistant',
      text: pending.result.nextQuestion ?? '변경한 조건을 적용했습니다. 아래 입력값을 검토한 뒤 확인해 주세요.' }]);
    setPending(null);
  };
  const rejectPending = () => {
    setPending(null);
    setTurns(current => [...current, { role: 'assistant', text: '저장된 조건을 유지했습니다. 수정하려는 항목과 금액을 다시 말씀해 주세요.' }]);
  };
  const reset = () => {
    requestGate.current.cancel();
    setBusy(false); setPending(null); setFields(empty); setTurns([]);
    setMode(null); setMessage(''); setError('');
  };

  return <section className="surface conversation-panel" aria-label="대화로 조건 입력">
    <div className="panel-head"><div><span className="panel-step">AI</span><h3>대화로 조건 정리</h3></div><button className="text-button" type="button" onClick={reset}>새 대화 ↺</button></div>
    <p className="conversation-disclosure">NIM 서버 키가 설정된 경우에만 입력 문장이 NVIDIA로 전송됩니다. 키가 없거나 연결에 실패하면 템플릿 분석으로 전환되며, 수익 계산과 거래 여부는 AI가 결정하지 않습니다.</p>
    <p className="conversation-disclosure">새 대화는 대화 문맥만 초기화합니다. 아래 저장된 조건과 다른 값은 사용자님이 변경을 확인한 뒤 적용됩니다.</p>
    {mode && <p className={`conversation-mode ${mode}`}>{mode === 'nim' ? 'NIM · openai/gpt-oss-20b' : '템플릿 분석 · AI 연결 없음'}</p>}
    <div className="conversation-turns" aria-live="polite">
      {turns.length === 0 ? <p className="conversation-empty">“1,000 USDT를 30일 운용하고 7일 뒤 200 USDT가 필요해요”처럼 말씀해 주세요.</p>
        : turns.map((turn, index) => <p key={index} className={`conversation-turn ${turn.role}`}><small>{turn.role === 'user' ? '사용자님' : '조건 확인'}</small>{turn.text}</p>)}
    </div>
    {pending && <div className="conversation-review" role="group" aria-label="대화 변경 후보">
      <strong>조건 변경 확인</strong>
      <ul>{pending.changes.map(change => <li key={change.key}>{change.label}: {change.before} → {change.after}</li>)}</ul>
      <div><button type="button" onClick={acceptPending}>변경 적용</button><button type="button" onClick={rejectPending}>기존 조건 유지</button></div>
    </div>}
    <form className="conversation-form" onSubmit={event => void submit(event)}>
      <label htmlFor="needs-chat-input">계획 조건을 문장으로 입력</label>
      <div><input id="needs-chat-input" value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} placeholder="보유액, 기간, 예정 지출을 알려주세요" disabled={Boolean(pending)} /><button type="submit" disabled={busy || Boolean(pending) || !message.trim()}>{busy ? '분석 중…' : '문장 분석'}</button></div>
    </form>
    {error && <p className="input-error" role="alert">{error}</p>}
  </section>;
}
