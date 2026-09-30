import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/lib/i18n';
import { seoulDate } from '../src/lib/needs';
import { NileWorkflow, parseNileInputs } from '../src/features/execution/NileWorkflow';
import { NilePsmPanel } from '../src/features/psm/NilePsmPanel';
import { NileWithdrawalFeePreview } from '../src/features/execution/NileWithdrawalPanel';
import type { NileWithdrawalPreview } from '../server/transactions';

const workflowProps: React.ComponentProps<typeof NileWorkflow> = {
  wallet: { address: '', network: '연결 전', networkKey: 'unknown', chainId: null },
  onConnect: async () => {}, selectedPlan: null, historicalRecords: [], verifiedDepositFlow: null,
  onSelect: () => {}, onRestorePlan: () => {}, onRecord: () => {},
  onOpeningObservation: () => {}, onObservation: () => {}, onWithdrawalFlow: () => {},
};
const english = (child: React.ReactNode) => renderToStaticMarkup(
  <I18nProvider initialLanguage="en">{child}</I18nProvider>);

afterEach(() => vi.unstubAllGlobals());

describe('English Nile execution screens', () => {
  it('shows expense protection, accessible labels, and the wallet gate in English', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const html = english(<NileWorkflow {...workflowProps} />);
    expect(html).toContain('Nile TRX·jTRX deposit and redemption demo');
    expect(html).toContain('Protected expenses and reserve 20 TRX');
    expect(html).toContain('Investment limit for the full period 80 TRX');
    expect(html).toContain('aria-label="Remove scheduled expense 1"');
    expect(html).toContain('Waiting for a Nile wallet connection.');
    expect(html).not.toMatch(/[가-힣]/);
    const connected = english(<NileWorkflow {...workflowProps} wallet={{
      address: 'TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu', network: 'Nile 테스트넷',
      networkKey: 'nile', chainId: '0xcd8690dc',
    }} />);
    expect(connected).toContain('Nile testnet · TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu');
  });

  it('translates storage failures without enabling execution', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError'); } });
    const html = english(<NileWorkflow {...workflowProps} />);
    expect(html).toContain('Unable to read Nile conditions from storage.');
    expect(html).toContain('Retry saving');
    expect(html).toContain('disabled=""');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('translates precise input validation while retaining the expense number', () => {
    const inputs = parseNileInputs(null, null, seoulDate());
    inputs.expenses[0].amount = '20.0000001';
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'gwdc-nile-needs-v3' ? JSON.stringify(inputs) : null });
    const html = english(<NileWorkflow {...workflowProps} />);
    expect(html).toContain('Scheduled expense 1 must be a TRX amount with no more than 6 decimal places.');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('keeps PSM contract/token warnings and separate-step actions explicit in English', () => {
    const html = english(<NilePsmPanel address="TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu" networkKey="nile" />);
    expect(html).toContain('Standalone Nile USDD↔USDT swap');
    expect(html).toContain('This USDD differs from the underlying asset of Nile jUSDD');
    expect(html).toContain('Each approval and swap is a separate transaction.');
    expect(html).toContain('Select: Approve USDD spending');
    expect(html).toContain('Preview: Approve USDD spending');
    expect(html).toContain('Other Nile tokens also named USDD are excluded');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('shows fee estimates and budgets without changing their exact amounts', () => {
    const preview = { estimatedFeeBaseUnits: '150001', maxFeeBaseUnits: '450001', feeLimitSun: '400000',
      state: { fullBurnFeeSun: '350001', bandwidthFeeUpperBoundSun: '50001', estimatedBandwidthBytes: '384' },
    } as NileWithdrawalPreview;
    const html = english(<NileWithdrawalFeePreview preview={preview} />);
    expect(html).toContain('Estimated burn after available wallet resources: <strong>0.150001 TRX</strong>');
    expect(html).toContain('Total fee budget before signing: <strong>0.450001 TRX</strong>');
    expect(html).toContain('does not guarantee the actual fee or transaction success');
    expect(html).not.toMatch(/[가-힣]/);
  });
});
