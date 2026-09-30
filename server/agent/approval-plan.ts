import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { canPreviewNileDeposit } from '../../shared/execution-policy';
import { toBaseUnits } from '../../shared/markets';
import { calculateLiquidity, createNilePlans } from '../../shared/planning';
import { userNeedsSchema, type UserNeeds } from '../../shared/schemas';
import type { NileQuote } from '../data/quotes';
import { NILE_JTRX_CANDIDATE, type NileDepositPreview } from '../transactions';

/** Recompute the protected-expense allocation from current Nile reads before reserving a mint. */
export async function verifyNileApprovalPlan(rawNeeds: UserNeeds, preview: NileDepositPreview, input: {
  readQuote: (address: string) => Promise<NileQuote>;
  readWalletBalance: (address: string) => Promise<{ balanceSun: string }>;
  now?: () => Date;
}): Promise<{ needsDigest: string; quoteVersion: string; amountBaseUnits: string }> {
  const needs = userNeedsSchema.parse(rawNeeds);
  if (needs.chain !== 'nile' || needs.asset.symbol !== 'TRX' || needs.asset.address !== null ||
      needs.asset.decimals !== 6 || needs.confirmedVersion !== needs.inputVersion ||
      needs.inputVersion !== preview.needsVersion) {
    throw new Error('확인된 Nile TRX 계획 조건과 미리보기 입력 버전이 필요합니다.');
  }
  const liquidity = calculateLiquidity(needs);
  const quote = (await input.readQuote(preview.walletAddress)).jTrx;
  if (!quote) throw new Error('Nile jTRX 실조회 견적이 없어 예치 예약을 보류합니다.');
  if (quote.marketAddress !== NILE_JTRX_CANDIDATE ||
      quote.receiptToken?.address !== NILE_JTRX_CANDIDATE ||
      quote.receiptToken.symbol !== 'jTRX' || quote.receiptToken.decimals !== 8) {
    throw new Error('Nile jTRX 견적의 계약·영수증 자산 조건이 다릅니다.');
  }
  // The planning quote and transaction preflight use separate Nile RPC readers.
  // A preview built from contradictory market-cash observations cannot be reserved.
  if (quote.liquidity.exitAvailable === null ||
      toBaseUnits(quote.liquidity.exitAvailable, 6) !== preview.state?.marketCashSun) {
    throw new Error('Nile 견적과 거래 사전 검증의 시장 현금이 일치하지 않습니다.');
  }
  const balance = await input.readWalletBalance(preview.walletAddress);
  if (!/^\d+$/.test(balance.balanceSun)) throw new Error('Nile 지갑의 실제 TRX 잔고를 확인할 수 없습니다.');
  if (!/^\d+$/.test(preview.amountBaseUnits) || !preview.maxFeeBaseUnits ||
      !/^\d+$/.test(preview.maxFeeBaseUnits) ||
      BigInt(balance.balanceSun) < BigInt(preview.amountBaseUnits) + BigInt(preview.maxFeeBaseUnits) +
        BigInt(toBaseUnits(liquidity.protectedAmount, 6))) {
    throw new Error('Nile 예치액과 최대 수수료를 제외하면 예정 지출·예비액을 보호할 수 없습니다.');
  }
  const walletBalance = new Decimal(balance.balanceSun).div('1000000').toString();
  const plan = createNilePlans(needs, quote, { walletBalance, now: input.now?.() }).plans
    .find(candidate => candidate.id === preview.planId);
  if (!plan || !canPreviewNileDeposit(plan) || plan.quoteVersion !== preview.quoteVersion ||
      toBaseUnits(plan.allocation.invested, 6) !== preview.amountBaseUnits) {
    throw new Error('지출·예비액 보호 후 재계산한 Nile 예치 계획·금액·견적이 미리보기와 다릅니다.');
  }
  return {
    needsDigest: createHash('sha256').update(JSON.stringify(needs)).digest('hex'),
    quoteVersion: plan.quoteVersion!, amountBaseUnits: preview.amountBaseUnits,
  };
}
