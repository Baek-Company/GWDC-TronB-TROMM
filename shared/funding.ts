import { Decimal } from "./units";
import { daysBetween } from "./needs";
import type { PlanStep, SwapQuote, UserNeeds, CostBasis } from "./schemas";

const ZERO = new Decimal(0);

export interface FundingPreparation {
  needs: UserNeeds;
  inputAsset: "TRX" | "USDT";
  inputAmount: string;
  valuedInputUsdt: string;
  reservedTrx: string;
  gasReserveTrx: string;
  entrySwapUsdt: string;
  conversionLossUsdt: string;
  networkFeeTrx: string;
  networkFeeUsdt: string;
  trxPerUsdt: string;
  steps: PlanStep[];
  note: string;
}

export class FundingError extends Error {}

function swapOut(amount: Decimal, reserveIn: Decimal, reserveOut: Decimal, feeNumerator: number) {
  return amount.mul(feeNumerator).mul(reserveOut).div(reserveIn.mul(1000).plus(amount.mul(feeNumerator)));
}

function swapInForOut(output: Decimal, reserveIn: Decimal, reserveOut: Decimal, feeNumerator: number) {
  if (output.gte(reserveOut)) throw new FundingError("TRX 지출액이 SunSwap 풀의 TRX 유동성 이상입니다.");
  return reserveIn.mul(output).mul(1000).div(reserveOut.minus(output).mul(feeNumerator));
}

/** Cost of keeping original TRX while converting only the USDT required for dated expenses. */
export function trxHoldCost(needs: UserNeeds, swap: SwapQuote, basis: CostBasis) {
  const expenses = needs.expenses.filter((expense) => expense.asset === "USDT" && daysBetween(needs.startDate, expense.date) >= 0 && (!needs.endDate || daysBetween(expense.date, needs.endDate) >= 0));
  const usdtNeeded = expenses.reduce((sum, expense) => sum.plus(expense.amount), ZERO);
  const trxSpent = usdtNeeded.gt(0) ? swapInForOut(usdtNeeded, new Decimal(swap.reserveTrx), new Decimal(swap.reserveUsdt), swap.feeNumerator) : ZERO;
  const feeTrx = usdtNeeded.gt(0) ? new Decimal(swap.costs.toUsdt.energy * basis.energyFeeSun + swap.costs.toUsdt.bandwidth * basis.bandwidthFeeSun).div(1_000_000) : ZERO;
  if (trxSpent.plus(feeTrx).gt(needs.amount ?? 0)) throw new FundingError("보유 TRX로 예정된 USDT 지출을 확보할 수 없습니다.");
  const price = new Decimal(basis.trxPerUsdt!);
  const loss = trxSpent.div(price).minus(usdtNeeded);
  const steps: PlanStep[] = usdtNeeded.gt(0) ? [{ action: "swap", label: "USDT 지출액만큼 TRX를 전환", asset: "TRX", amount: trxSpent.toFixed(), contract: swap.router, energy: swap.costs.toUsdt.energy, bandwidth: swap.costs.toUsdt.bandwidth, energySource: "Estimated SunSwap resources", day: 0 }] : [];
  return { usdtNeeded, trxSpent, feeTrx, feeUsdt: feeTrx.div(price), loss, steps };
}

/** Reserve expenses in their stated currency before planning the USDT investment budget. */
export function prepareMainnetFunding(needs: UserNeeds, swap?: SwapQuote, basis?: CostBasis, now = new Date(), gasReserveTrx = ZERO): FundingPreparation | undefined {
  const inputAsset = needs.asset;
  const mixed = needs.expenses.some((expense) => expense.asset !== inputAsset && daysBetween(needs.startDate, expense.date) >= 0 && (!needs.endDate || daysBetween(expense.date, needs.endDate) >= 0));
  if (inputAsset === "USDT" && !mixed) return undefined;
  if (!swap || !basis?.trxPerUsdt || new Decimal(basis.trxPerUsdt).lte(0)) throw new FundingError("TRX↔USDT 전환 풀과 TRX 가격을 조회해야 이 자산 조합을 계산할 수 있습니다.");
  if (swap.source.mode === "live" && now.getTime() - Date.parse(swap.source.fetchedAt) > 10 * 60 * 1000) throw new FundingError("SunSwap 전환 견적이 오래됐습니다. 다시 조회해 주세요.");
  const amount = new Decimal(needs.amount ?? 0);
  const price = new Decimal(basis.trxPerUsdt);
  const reserveUsdt = new Decimal(swap.reserveUsdt);
  const reserveTrx = new Decimal(swap.reserveTrx);
  const trxExpenses = needs.expenses.filter((expense) => expense.asset === "TRX" && daysBetween(needs.startDate, expense.date) >= 0 && (!needs.endDate || daysBetween(expense.date, needs.endDate) >= 0));
  const trxExpenseTotal = trxExpenses.reduce((sum, expense) => sum.plus(expense.amount), ZERO);
  const feeFor = (energy: number, bandwidth: number) => new Decimal(energy * basis.energyFeeSun + bandwidth * basis.bandwidthFeeSun).div(1_000_000);
  const steps: PlanStep[] = [];
  let budget: Decimal;
  let reservedTrx: Decimal;
  let conversionLoss: Decimal;
  let entrySwapUsdt: Decimal;
  let fee: Decimal;

  if (inputAsset === "TRX") {
    reservedTrx = trxExpenseTotal.plus(needs.bufferAmount ?? 0).plus(gasReserveTrx);
    if (reservedTrx.gt(amount)) throw new FundingError("TRX 지출과 여유액이 보유 TRX보다 큽니다.");
    const tradable = amount.minus(reservedTrx);
    fee = tradable.gt(0) ? feeFor(swap.costs.toUsdt.energy, swap.costs.toUsdt.bandwidth) : ZERO;
    if (tradable.lte(fee)) throw new FundingError("TRX 지출·여유액과 최초 전환 수수료를 제외하면 USDT로 바꿀 TRX가 없습니다.");
    const swapInput = tradable.minus(fee);
    budget = swapOut(swapInput, reserveTrx, reserveUsdt, swap.feeNumerator);
    conversionLoss = swapInput.div(price).minus(budget);
    entrySwapUsdt = budget;
    steps.push({ action: "swap", label: "보유 TRX를 USDT 운용 재원으로 전환", asset: "TRX", amount: swapInput.toFixed(), contract: swap.router, energy: swap.costs.toUsdt.energy, bandwidth: swap.costs.toUsdt.bandwidth, energySource: "Estimated SunSwap resources", day: 0 });
  } else {
    reservedTrx = trxExpenseTotal;
    fee = reservedTrx.gt(0) ? feeFor(swap.costs.toTrx.energy + 23000, swap.costs.toTrx.bandwidth + 265) : ZERO;
    const swapInput = reservedTrx.gt(0) ? swapInForOut(reservedTrx, reserveUsdt, reserveTrx, swap.feeNumerator) : ZERO;
    if (swapInput.gt(amount)) throw new FundingError("TRX 지출 확보에 필요한 USDT가 보유액보다 큽니다.");
    budget = amount.minus(swapInput);
    conversionLoss = swapInput.minus(reservedTrx.div(price));
    entrySwapUsdt = swapInput;
    if (reservedTrx.gt(0)) steps.push({ action: "approve", label: "USDT 사용 승인 (TRX 지출 확보)", asset: "USDT", amount: swapInput.toFixed(), contract: swap.router, energy: 23000, bandwidth: 265, energySource: "Estimated network resources", day: 0 }, { action: "swap", label: "지출용 USDT를 TRX로 전환", asset: "USDT", amount: swapInput.toFixed(), contract: swap.router, energy: swap.costs.toTrx.energy, bandwidth: swap.costs.toTrx.bandwidth, energySource: "Estimated SunSwap resources", day: 0 });
  }
  if (budget.lte(0)) throw new FundingError("지출 확보와 전환 이후 USDT 운용 재원이 없습니다.");
  for (const expense of trxExpenses) steps.push({ action: "hold", label: `${expense.date} TRX 지출 확보`, asset: "TRX", amount: expense.amount, energy: 0, bandwidth: 0, energySource: "-", day: daysBetween(needs.startDate, expense.date) });
  const usdtExpenses = needs.expenses.filter((expense) => expense.asset === "USDT");
  const normalized: UserNeeds = { ...needs, asset: "USDT", amount: budget.toFixed(), bufferAmount: inputAsset === "USDT" ? needs.bufferAmount : "0", expenses: usdtExpenses };
  const reservedUsdt = usdtExpenses.filter((expense) => daysBetween(needs.startDate, expense.date) >= 0 && (!needs.endDate || daysBetween(expense.date, needs.endDate) >= 0)).reduce((sum, expense) => sum.plus(expense.amount), new Decimal(normalized.bufferAmount ?? 0));
  if (reservedUsdt.gt(budget)) throw new FundingError(`USDT 지출 ${reservedUsdt.toFixed()} USDT를 확보하려면 현재 TRX↔USDT 견적으로 마련할 수 있는 ${budget.toFixed()} USDT보다 더 필요합니다.`);
  const feeUsdt = fee.div(price);
  return {
    needs: normalized, inputAsset, inputAmount: amount.toFixed(), valuedInputUsdt: (inputAsset === "TRX" ? amount.div(price) : amount).toFixed(),
    reservedTrx: reservedTrx.toFixed(), gasReserveTrx: gasReserveTrx.toFixed(), entrySwapUsdt: entrySwapUsdt.toFixed(), conversionLossUsdt: conversionLoss.toFixed(),
    networkFeeTrx: fee.toFixed(), networkFeeUsdt: feeUsdt.toFixed(), trxPerUsdt: price.toFixed(), steps,
    note: "TRX 지출과 예정 네트워크 비용은 TRX로 확보하고, 나머지는 조회 시점 SunSwap 풀에서 USDT로 바꾼 뒤 운용한다고 가정합니다. 미래 TRX 가격 변동은 예측하지 않습니다.",
  };
}
