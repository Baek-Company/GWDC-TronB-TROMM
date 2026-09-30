import { describe, expect, it } from 'vitest';
import type { ConversationFields } from '../server/llm/conversation';
import { profileChangeCandidates } from '../src/features/conversation/ChatPanel';
import { initialProfile } from '../src/lib/session';

const empty: ConversationFields = {
  asset: null, holdings: null, horizonDays: null, expense: null,
  expenseDay: null, reserve: null, risk: null, acceptsUsddRisk: null,
};

describe('chat profile review', () => {
  it('shows a restored holding change as a candidate and leaves the profile untouched', () => {
    const profile = { ...initialProfile };
    const changes = profileChangeCandidates(profile, { ...empty, holdings: '100' });
    expect(changes).toEqual([{ key: 'holdings', label: '보유 금액', before: '1000', after: '100' }]);
    expect(profile.holdings).toBe('1000');
  });

  it('does not ask for approval when extracted values equal the saved values', () => {
    expect(profileChangeCandidates(initialProfile, { ...empty, holdings: '1000', reserve: '0' })).toEqual([]);
  });
});
