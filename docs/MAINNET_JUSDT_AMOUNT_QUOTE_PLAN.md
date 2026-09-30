# Mainnet jUSDT 금액별 실견적 구현 계획

작성일: 2026-09-29  
대상: `TeamBaek/LeeMir`의 **읽기 전용** Mainnet USDT → JustLend jUSDT 계획·재평가  
우선순위: 지급일의 자금 확보와 비상예비액 보유, 근거가 없는 수익·비용·출구는 보류

## 1. 목표와 현재 위치

사용자님이 확인한 보유액·지출일·지출액·예비액과 연결 지갑의 관측 잔액을 기준으로, **각 운용 금액과 회수 예정일마다** jUSDT 진입·회수 비용을 다시 산정합니다. 최신 시장 금리, 현재 출구 현금, 승인 상태, 거래별 Energy/Bandwidth, 수수료용 TRX, TRX→USDT 환산 근거를 한 계획 버전에 묶습니다. 비상예비액은 보유합니다. 미래 지출 원금은 날짜별 비교 대상으로 삼되, jUSDT에 넣는 순간 지갑의 유동 USDT가 아니므로 이를 `보호된 현금`이라고 표시하지 않습니다. 현재 조건의 비용 시나리오를 뺀 예상 순익이 양수여도 회수 가능성을 별도 판정합니다. 금액·지갑·원천이 부족하면 `hold` 또는 `insufficient_data`를 유지합니다.

현재 확인된 상태는 다음과 같습니다.

| 항목 | 코드와 실증 상태 | 해결해야 할 문제 |
| --- | --- | --- |
| TronGrid | 개발용 키를 로컬 비공개 설정에 넣었고 Mainnet jUSDT 조회에서 기존 HTTP 429가 재현되지 않았습니다. | 키 연결은 거래·완전한 견적의 증거가 아닙니다. |
| 상품 견적 | `server/data/quotes.ts`의 `readMainnetQuotes()`는 인자 없이 REST 금리·현금을 읽습니다. | REST 원천 갱신 시각이 없고 jUSDT 승인·예치·환매·네트워크 비용은 `null`입니다. |
| 날짜별 계산 | `shared/planning.ts`의 `createDatedAllocation()`은 지출일별 구간을 만듭니다. | 하나의 `ProductQuote.costs`를 모든 금액에 재사용해 200/800 USDT 등의 수수료와 승인 횟수가 맞지 않습니다. |
| 지갑 기반 평가 | `server/agent/assessment.ts`는 Mainnet USDT 실잔액 상한을 확인합니다. | `mainnetQuotes()`에 주소·금액을 전달하지 않고 수수료용 TRX를 적격 판정에 연결하지 않습니다. |
| 실행 | `/api/capabilities`의 `mainnetExecution:false`입니다. | 이 계획에서는 계속 읽기 전용입니다. Mainnet 서명·방송·무인 거래를 열지 않습니다. |

`PROJECT_PLAN.md`의 A 경로(USDT 보유분 + jUSDT 예치)와 날짜별 지급 일정 관리를 대상으로 합니다. jUSDD/PSM B 경로는 별도 근거가 필요하며 이 작업이 끝나도 `실행 가능한 두 경로`를 달성했다고 표시하지 않습니다.

## 2. 견적의 정확한 의미

하나의 `ProductQuote`는 시장 공통 상태로 유지합니다. 지갑·금액·회수일별 `JusdtLegQuote`와 **선택된 모든 구간의 공동 승인·TRX 재원을 한 번만 계산하는** `JusdtBundleQuote`를 별도 Zod 계약으로 추가합니다. 이 둘을 기존 `ProductQuote.costs`에 복사하지 않습니다. 다음 필드명과 불변식을 구현 계약으로 고정합니다.

```ts
type CostEvidence = {
  action: 'approve_zero' | 'approve' | 'mint' | 'redeem_underlying';
  basis: 'account_simulation' | 'reference_model' | 'unknown';
  contextVersion: string;
  contractAddress: string;
  selector: string;
  amountRaw: string;
  energyUnits: string | null;
  bandwidthBytes: string | null;
  estimatedFeeSun: string | null;    // 현재 단가의 비용 모델, 실제 청구액 아님
  feeLimitSun: string | null;        // 행동별 Energy 예산, 실제 청구액 아님
  bandwidthBudgetSun: string | null;
  sources: Source[];                 // 모델 영수증과 현재 체인 단가를 구별
  referenceTxIds: string[];         // 기준 모델이면 검증된 확정 거래 ID
};

type JusdtQuoteContext = {
  version: string;
  chain: 'mainnet';
  walletAddress: string;
  usdtAddress: string;
  jusdtAddress: string;
  marketQuoteVersion: string;
  needsVersion: number;
  energyPriceSun: string;
  bandwidthPriceSun: string;
  maxFeeLimitSun: string;
  trxUsd: string | null;
  usdtUsd: string | null;
  availableEnergy: string | null;
  availableBandwidth: string | null;
  availableTrxSun: string | null;
  observedUsdtRaw: string | null;
  allowanceUsdtRaw: string | null;
  sources: Source[];
  observationWindow: { firstBlock: string; lastBlock: string; startedAt: string; endedAt: string };
  validUntil: string;
};

type ActionCostSampleSet = {
  action: CostEvidence['action'];
  contractAddress: string;
  selector: string;
  samples: Array<{
    basis: 'account_simulation' | 'reference_model';
    amountRaw: string;
    energyUnits: string;
    signedBytes: string;
    txId: string | null;            // 현재 계정 모의 결과에는 없음
    source: Source;
  }>;
  codeIdentity: string;             // 프록시 대상/당시·현재 구현 동일성 검증값
  modelVersion: string;
  validUntil: string;
};

type JusdtLegQuote = {
  chain: 'mainnet';
  walletAddress: string;             // 실제 계정 없으면 이 계약을 만들지 않음
  needsVersion: number;
  bucketKey: string;                 // purpose + dueDate; 동액 중복은 입력 순번 추가
  amountUsdtRaw: string;             // USDT 6 decimals, BigInt 문자열
  dueDate: string;
  plannedExitDate: string;
  earningDays: number;
  contextVersion: string;
  marketQuoteVersion: string;
  mintCost: CostEvidence;
  redeemModelVersion: string | null; // 최종 환매액은 묶음 금리 계산 후 결정
  status: 'scenario_only' | 'partial' | 'unavailable';
  validUntil: string;
  quoteVersion: string;
};

type JusdtBundleQuote = {
  chain: 'mainnet';
  walletAddress: string;
  needsVersion: number;
  contextVersion: string;
  inputTokenAddress: string;         // 검증된 Mainnet USDT
  marketAddress: string;             // 검증된 Mainnet jUSDT
  selectedLegVersions: string[];     // bucketKey 순서로 정렬; 각 leg는 이 bundle을 참조
  approvalActions: 'none' | 'approve' | 'reset_then_approve' | 'unknown';
  actions: Array<{ bucketKey: string | null; cost: CostEvidence }>;
  // approval은 bucketKey=null로 한 번만, mint/redeem은 각 bucketKey로 기록
  allowanceUsdtRaw: string | null;
  totalDepositUsdtRaw: string;
  scenarioRateApr: string | null;    // 현 금리와 예치 후 모델 금리의 작은 값
  expectedCostUsdt: string | null;
  stressCostUsdt: string | null;
  requiredFeeTrxSun: string | null;  // 입구 비용 예산 + 미래 출구 예산 보유 정책
  availableFeeTrxSun: string | null;
  scenarioNetYieldUsdt: string | null;
  stressNetYieldUsdt: string | null;
  observationWindow: { firstBlock: string; lastBlock: string; startedAt: string; endedAt: string };
  status: 'scenario_only' | 'partial' | 'unavailable';
  validUntil: string;
  quoteVersion: string;
};

type JusdtSizingInputs = {
  context: JusdtQuoteContext;
  legs: JusdtLegQuote[];
  approvalModels: ActionCostSampleSet[];
  redeemModels: ActionCostSampleSet[];
};
```

`JusdtQuoteContext`는 호출자·계약·시장/가격/자원/allowance·관측 범위를 한 버전으로 묶습니다. `CostEvidence`의 `null`은 미확인이며 0으로 바꾸지 않습니다. `fee_limit`은 호출자가 허용한 **Energy 소모 예산**이며 Bandwidth를 포함한 거래 총비용이나 실제 예상 비용이 아닙니다. 승인 필요 없음이 지갑의 최신 `allowance`로 확인될 때만 승인 비용을 0으로 둡니다. `actions`에 실제 계획된 승인·예치·환매의 Energy/Bandwidth 비용을 한 번씩 기록하고 별도 `network` 비용으로 다시 더하지 않습니다. `basis=reference_model`이 하나라도 있으면 전체 bundle은 `scenario_only`입니다. 미확인 필수 행동이 하나라도 있으면 모든 비용·순익 합계는 `null`입니다.

서버는 `walletAddress + bucketKey + amountUsdtRaw + dueDate + plannedExitDate + 시장/요구 버전`이 다른 leg를 재사용하지 않습니다. bundle ID는 **정렬한 선택 leg 버전**과 context/model 버전·최종 행동 목록/금액을 해시합니다. leg가 bundle ID를 포함해 순환 해시가 생기지 않게, `DatedAllocationLeg`가 최종 bundle ID와 자신의 leg ID를 참조합니다. 데이터의 `fetchedAt`은 조회 시각이며 REST 요청 시각을 `sourceUpdatedAt`으로 꾸미지 않습니다. 블록 범위를 기록하되 모든 값이 같은 블록에서 읽혔다고 주장하지 않습니다.

견적 상태는 화면에서 다음처럼 구분합니다.

| 상태 | 뜻 | 계획 반영 |
| --- | --- | --- |
| 시장 참고 | 온체인 금리·현재 현금만 확인 | 예상 기본수익 참고만 가능; 순익과 신규 예치 권고는 보류 |
| 금액별 부분 견적 | 실제 주소·금액의 일부 거래비용만 확인 | `null` 항목과 보류 이유 표시; 미확인 값을 0으로 간주하지 않음 |
| 현재 계정의 금액별 행동 견적 | 현재 계정 상태에서 **성공한 해당 행동**의 모의 비용만 확인 | 확인된 행동의 참고값만 사용. 승인 뒤 예치처럼 상태가 이어져야 하는 후속 행동은 별도 검증 필요 |
| 금액별 조건부 시나리오 | 각 필수 행동에 현재 계정의 성공 모의 결과 또는 검증된 확정 영수증 모델이 있고, 최신 환산율·현재 출구·잔액 근거가 있음 | **현재 조건에서의 읽기 전용 계획 비교**만 가능. 모델과 비용 예산은 미래 USDT 비용 상한이나 지급일 회수 보증이 아님 |
| 예치 후 회수 견적 | 실제 jUSDT 포지션을 관측하고 해당 계정의 현재 환매를 다시 모의 확인 | 현재 시점 회수 판단에 사용. 원래 사전 견적을 소급해 실거래 확정으로 바꾸지 않음 |

## 3. 구현 순서와 파일별 작업

### 구현 사양: 데이터 신선도·조회 예산·보류 규칙

- **신선도 정책(프로젝트 정책):** 시장 RPC, 지갑 잔액, allowance, 자원, 체인 단가는 각각 조회 후 60초 이내여야 합니다. SUN 가격은 `last_updated` 기준 5분 이내여야 합니다. 같은 평가의 시작~종료는 30초/10블록 이내입니다. 최종 `validUntil`은 각 원천 만료시각과 평가 완료 후 2분 중 가장 빠른 시각이며 응답 직전 만료되면 재조회 1회 후 보류합니다. 역사 영수증 모델의 과거 거래 시각은 이 60초 규칙 대신 아래 30일/코드 동일성 규칙을 적용합니다. REST V1의 원천 시각 부재는 그대로 `null`입니다.
- **호출 예산(프로젝트 정책):** 입력 지출 100건은 모두 결과에 남기되 한 평가에서 조건부 금액별 견적 대상은 최대 **8개 날짜 버킷**입니다. 최대 **40회 Mainnet RPC**, 동시 **2회**, 평가 **25초** 제한을 둡니다. 후보는 지급일이 빠른 순, 동률이면 bucketKey 순이며 종료일 잉여금은 마지막으로 정해 8개를 고릅니다. 나머지는 `quote_budget_exceeded`로 보유합니다. 현재 `tron-rpc.ts`의 queue 80/동시 2/250ms 간격과 `read-gate.ts`의 60 starts/min·동시 4 제한을 넘기지 않습니다. 초과·429·타임아웃은 더 많은 동시 재시도 대신 해당 leg를 `unverified/hold`로 돌립니다.
- **시장과 참조 모델 캐시:** 시장 10초, 동일 지갑·동일 입력의 평가 5초, 확정 영수증 비용 모델 10분까지만 공유합니다. 가격·allowance·자원·시장 금리·계약 코드가 달라지거나 견적 `validUntil`이 지나면 적격 근거를 폐기합니다. 캐시 키는 네트워크, 지갑, 입력 버전, 날짜별 금액, 선택 구간, 근거 버전을 포함합니다. 영수증 모델은 **사용자 평가와 분리한 직렬/저우선순위 갱신**으로 만들고 계약별 최대 2페이지, 전체 최대 20개 확정 영수증과 본문이 목록에 없으면 최대 20개 원거래 본문 조회로 제한합니다. 갱신 중 또는 실패 시 과거 캐시를 적격 근거로 연장하지 않고 `unknown`입니다. 25초·40 RPC는 사용자 평가에만 적용하며 두 작업 모두 기존 전역 RPC queue·429 쿨다운을 공유합니다.
- **보류 코드:** `market_unverified`, `wallet_unverified`, `price_unverified`, `action_cost_unknown`, `future_exit_unknown`, `fee_trx_insufficient`, `liquidity_risk_not_accepted`, `exit_buffer_insufficient`, `aggregate_cash_insufficient`, `non_positive_stress_net`, `quote_budget_exceeded`, `quote_expired`를 명시적으로 반환합니다. 값 미확인·제한 초과는 조용히 0 또는 가상 수치로 대체하지 않습니다. **코드 완료**에는 이 보류 경로가 정상 작동하는 것까지 포함합니다.

### 구현 사양: 읽기 전용 행동 비용과 계산식

1. 승인 분기는 **묶음 총 예치액**과 최신 `allowance`로 `충분→0회`, `0→approve(total)`, `0<allowance<total→approve(0), approve(total)`을 택합니다. 사전 모의 실행은 체인 상태를 바꾸지 않습니다. 따라서 `allowance=0`에서 첫 승인만 성공 모의할 수 있고 후속 `mint`는 성공 실측으로 취급할 수 없습니다. 잔여 allowance 부족이면 첫 `approve(0)` 뒤의 재승인과 `mint`도 현재 상태 성공을 증명하지 못합니다. 각 필수 행동을 개별 `account_simulation/reference_model/unknown`으로 기록합니다.
2. 참조 모델은 **확정된 실제 거래의 동일 계약·함수·금액대 영수증**만 사용합니다. 승인 거래는 USDT 계약, 예치·환매 거래는 jUSDT 계약의 `GET /v1/contracts/{contractAddress}/transactions?only_confirmed=true`에서 최근 30일·계약별 최대 2페이지를 가져옵니다. 거래 목록에서 표본이 모자라면 서버 전용 공개 txID 허용 목록을 추가할 수 있지만 **동일한 30일·검증 규칙**을 적용합니다. 원 거래 본문/ABI 선택자·spender·원시 인자를 대조하고, `/walletsolidity/gettransactioninfobyid`에서 `receipt.result=SUCCESS`, Energy/Bandwidth·수수료·블록 시각을 검증합니다. **jUSDT mint/redeem은 반환 코드 `0`과 해당 Mint/Redeem 이벤트의 주소·원시 금액 일치, USDT approve는 반환 `true`와 Approval 이벤트의 owner·spender·금액 일치**도 요구합니다. 하나라도 없으면 성공 표본이 아닙니다. `approve(0)`은 0 전용 표본, 다른 행동은 목표 원시 금액의 0.5~2배 표본을 쓰며 **각 필요한 행동별 유효 표본 5개 미만이면 `unknown`**입니다. 현재 프록시·구현의 runtime bytecode 해시와 참조 거래 당시 구현이 동일했음을 코드/업그레이드 이력으로 확인해야 합니다. 과거 구현을 확인할 수 없거나 현재 해시가 모델 생성 이후 바뀌면 모델을 무효화합니다. 표본 최대 Energy·서명 거래 byte 수를 `CostEvidence`에 기록하고, 그 **2배 올림**을 스트레스 시나리오로 사용합니다. 2배는 프로젝트 안전 계수일 뿐 실제 비용의 상한이 아닙니다. 이 조회의 실제 응답 필드·지원 여부는 구현 첫 실증 게이트에서 확인하고, 제공되지 않으면 모델을 억지로 만들지 않습니다.
3. 현재 계정에서 성공한 `triggerconstantcontract`/지원되는 `estimateenergy`는 API 결과, TVM 반환, 계약 성공 코드와 `energy_used`/`energy_required`를 분리 검증합니다. `wallet/triggersmartcontract`는 **미서명 크기 측정만** 허용하고 서명·방송 함수 호출을 테스트에서 금지합니다. 서명 수·권한에 따른 최종 바이트 수를 검증할 수 없으면 Bandwidth는 `unknown`입니다. 단일 서명으로 확인된 경우 기존 Nile 코드의 미서명 크기+80 byte 방식은 **시나리오**로만 재사용합니다. 지갑 자원은 입구 행동 순서대로 한 번씩 차감하며 미래 회수에는 현재 무료 자원을 이월하지 않습니다. 호출자 100% Energy 부담을 보수적 시나리오로 적용합니다.
4. 계산은 정수 sun/USDT 최소단위와 `Decimal`로만 합니다. 행동별 `estimatedFeeSun = max(0, energyUnits−그 행동에 배정된 현재 무료 Energy)×getEnergyFee + max(0, bandwidthBytes−배정된 현재 무료 Bandwidth)×getTransactionFee`입니다. 스트레스 Energy와 Byte 수는 각각 `ceil(2×energyUnits)`·`ceil(2×bandwidthBytes)`이며 **무료 자원을 차감하지 않습니다**. `feeLimitSun = stressEnergy×getEnergyFee`, `bandwidthBudgetSun = stressBytes×getTransactionFee`로 현재 조건의 행동별 예산을 만들고 현재 `getMaxFeeLimit`을 넘으면 보류합니다. `requiredFeeTrxSun = Σ(입구 행동의 feeLimitSun+bandwidthBudgetSun)+Σ(미래 회수 행동의 feeLimitSun+bandwidthBudgetSun)`을 별도로 보유하도록 요구합니다. 이는 현재 단가를 사용한 예비 정책이며 미래 수수료 상한이 아닙니다. 실제 지갑 TRX가 이 값보다 작으면 투자 후보가 아닙니다.
5. 검증된 SUN TRX/USD·USDT/USD의 비율로 비용을 USDT로 환산합니다. SUN의 TRX 주소 표현은 **실제 응답에서 검증되기 전에는 미확인**입니다. 비용 환산은 USDT 6자리로 올림, 예상 수익은 6자리로 내림합니다. 구간 총수익은 `amountUsdt × scenarioRateApr × earningDays/365`입니다. `scenarioRateApr`은 **현재 온체인 APR과 묶음 전액 예치 후 모델 APR 중 작은 값**으로 정합니다. 묶음 예상 순익은 `Σ구간 수익−Σ(각 mint/redeem 예상비용)−공동 승인 예상비용`, 스트레스 순익은 같은 수익에서 **모든 행동의 무료 자원 없는 스트레스 비용**을 뺀 값입니다. 두 순익이 모두 `>0`이고 다른 게이트가 통과할 때만 조건부 후보입니다. 모델에 없는 행동·가격·예치 후 금리가 하나라도 있으면 두 순익 모두 `null`입니다.
6. `ActionCostSampleSet`의 현재 계정 성공 모의 표본은 **그 원시 금액에 정확히 일치할 때만** 사용합니다. 아니면 확정 영수증 중 목표 금액의 0.5~2배인 표본 5개 이상을 선택하고 그 최대 Energy/Byte를 사용합니다. 중간에 모델이 없는 금액을 보간하지 않습니다. 임의 선택 묶음의 `approve(total)`과 묶음 금리에 따라 달라지는 `redeemUnderlying(amount)`은 순수 계산기에서 이 규칙으로 다시 채웁니다. 표본 범위를 벗어나거나 가격/코드가 바뀌면 그 **선택 묶음만** `unknown/hold`이며 RPC를 계산기에서 즉석 호출하지 않습니다.

### 구현 사양: 날짜별 선택과 응답 경계

1. 원본 지출 목록은 모두 보존하고 같은 지급일은 USDT 원시 단위로 합칩니다. 지출액과 상시 예비액의 합이 진술액/관측액을 초과하면 모든 투자 후보를 보류합니다. `acceptsDatedExpenseLiquidityRisk !== true`이면 모든 지출 버킷을 보유하고 종료일 잉여금만 평가합니다. 이 확인은 기존 입력 확인의 필수 질문이 아니며, 사용자가 지출액 운용을 선택할 때 한 번 설명·직접 확인받습니다. 답이 없거나 거절이면 질문을 반복하지 않고 보유합니다.
2. 지출 버킷의 `plannedExitDate`는 KST 지급일 **최소 1일 전**이며 시장 출금 지연이 더 길면 그만큼 앞당깁니다. 예치일 이후 벌 수 있는 완전한 일수가 1일 미만이면 보유합니다. 종료일 잉여금은 종료일에 회수 목표를 둡니다. 이 완충은 제품 정책이며 출금 성공 보장이 아닙니다.
3. 8개 이내 후보 각각의 leg·모델 근거를 한 번 읽고, 순수 계산기는 **최대 256개 부분집합**을 평가합니다. 각 집합마다 `총 예치액→allowance 분기→공동 approve(target) 재산정→예치 후 APR→각 leg의 예상 이자→계획 환매 원시 금액→각 mint/redeem 비용→현재 현금·잔액·TRX 예비액→예상/스트레스 순익`을 계산합니다. 각 leg의 `plannedRedeemUsdtRaw`는 `amountUsdtRaw + floor(금리 시나리오 이자×10^6)`으로 정하고 **원금과 시나리오 이자를 모두 회수**하는 가정입니다. 이 값을 `redeemUnderlying(uint256)` 인자·참조 표본 범위·현재 `getCash()` 합산에 동일하게 씁니다. 실제 이자가 그보다 적으면 그 금액으로 환매가 실패할 수 있으므로 거래 실행 근거가 아닙니다.
4. 모든 보호액·출구·비용·가격·기간 게이트가 통과하고 **예상 및 스트레스 순익이 모두 양수**인 부분집합 중 스트레스 순익이 최대인 집합을 선택합니다. 동률이면 예상 순익 최대, 다시 동률이면 투자 원금이 작은 집합, 다시 동률이면 정렬한 bucketKey 문자열 순입니다. 어떤 집합도 통과하지 못하면 전체 보유합니다. 8개 밖 버킷과 원천 미확인 버킷은 여전히 결과에 보유로 남깁니다. 이 한정된 후보 범위에서는 전수 비교이지만 미래 최적 수익을 보장하지 않습니다.
5. 공동 승인 비용은 **선택 구간의 예치 원금 비율**로 USDT 6자리 최소단위에서 분배합니다. bucketKey 순서로 마지막 구간 전까지 내림 분배하고 남은 단위를 마지막 구간에 부여하여 합계를 정확히 맞춥니다. 각 구간 기여 순익은 `해당 이자−해당 mint/redeem 비용−분배 승인비`이며 합계는 선택 묶음 순익과 같아야 합니다. 공동비 분배 때문에 개별 기여 순익이 0 이하인 구간도 묶음 전체가 양수라면 선택될 수 있으므로 `DatedAllocationLeg`의 기존 개별 `expectedNetYield>0` 검사는 이 jUSDT 묶음 경로에 한해 제거하고 **묶음 전체 >0 검증**으로 대체합니다. 선택되지 않은 미확인 구간이 있으면 전체 `DatedAllocation.expectedNetYield`·`recommendation`은 자료 부족으로 유지하되, `selectedBundleNetYield`·`selectedBundleStatus`와 `datedDecision=conditional_allocate`는 **선택된 구간 한정**이라고 UI·저장·감시에 함께 표시합니다. 현재 `getCash()`에는 모든 선택 구간의 계획 환매액을 합산해 대조합니다. 미래의 실제 출구 현금은 보장되지 않습니다.
5. 에이전트 응답에는 `datedDecision: { action: 'conditional_allocate'|'hold'|'insufficient_data'; allocationId; bundleQuoteVersion; basis: 'current_conditions_scenario'|'unavailable'; reasonCodes; executionEligible:false }`를 별도로 둡니다. 기존 단일 `Plan`의 `recommendedPlanId`나 `AgentDecision.planId`를 날짜별 묶음 ID로 위장하지 않습니다. 화면·요약은 이 결정을 우선 표시하고, 기존 단일 Plan은 독립 참고값으로 남깁니다. `selectedRouteDataMode`와 전역 진단을 별도 저장해 무관한 PSM 실패가 jUSDT의 출처를 바꾸지 않게 합니다.

### 0단계 · 경계와 입력 고정

- `shared/schemas.ts`: 위 context·모델·두 견적·행동별 비용 근거의 Zod 계약과 `UserNeeds.acceptsDatedExpenseLiquidityRisk`(기본 `false`)를 추가합니다. 원시 정수는 문자열/`BigInt`, 표시 금액은 `Decimal`로 처리합니다. `amountUsdtRaw > 0`, USDT 소수점 최대 6자리, 날짜, Mainnet 주소, 자산 일치를 검증합니다. `ProductQuote`의 시장 공통 정보와 금액별 거래비용을 구분합니다. `DatedAllocationLeg`에 `sizedQuoteVersion`/`bundleQuoteVersion`/`plannedRedeemUsdtRaw`/`costBasis`/`validUntil`, `DatedAllocation`에 `selectedBundleNetYield`/`selectedBundleStatus`, `Plan.netYieldBasis`에 `current_conditions_scenario`를 추가합니다. jUSDT 묶음의 개별 기여 순익은 음수도 허용하되 묶음 양수 불변식을 검증하고, 기존 Nile/PSM 검사는 유지합니다.
- `shared/agent-request.ts`, `server/agent/intake.ts`: `explicitFacts`에는 `acceptsDatedExpenseLiquidityRisk:boolean|null`을 추가하고 `toUserNeeds()`에서는 **오직 `true`만** 수용으로 변환합니다. `null/false`는 지출액 보유입니다. 기존 요청 schemaVersion 1은 2로 한 번만 이행하며 이 필드는 `null`, `version += 1`, `confirmedVersion=null`로 만들어 요약을 다시 확인받습니다. 선택적 위험 확인 질문은 한 번 설명하고 답이 없으면 보유로 진행해 무한 질문을 만들지 않습니다. 이후 확인값을 변경하면 요청 버전·계획 ID가 바뀝니다.
- `src/lib/session.ts` 및 계획/에이전트 응답 파서: 세션 v2→v3 이행 시 원 요청·배분·거래 기록을 보존합니다. 구버전 요청은 위 확인 이행을 거치고 구버전 기록의 금액별 견적/포지션 증거는 `미검증`으로 표시합니다. 원 배분을 현재 조건부 후보로 자동 승격하지 않습니다. 저장/복원 후에도 `bundleQuoteVersion`·만료·근거·보류 사유가 유지되어야 합니다.
- `server/index.ts`: `/api/plans`는 **가상 비교**임을 응답에 명시하고 지갑 비용을 만들지 않습니다. `/api/agent/assessment`의 연결 주소를 이용하는 경로만 실잔액 기반 금액별 견적을 요구합니다. 주소는 조회 대상이며 소유·거래 권한의 증거가 아닙니다. `guardedRead`를 `/api/plans`에도 적용하고 기존 `readJson` 본문 상한과 입력 지출 100건·8버킷·40 RPC 예산을 지킵니다. 조회 API는 서명·방송 엔드포인트를 호출하지 않습니다.
- 완료 기준: 같은 시장이라도 지갑·금액·만기가 다르면 견적 ID가 달라지며, 지갑 없는 가상 계획이 실잔액 기반 추천으로 승격되지 않습니다.

### 1단계 · 신선한 Mainnet 시장 근거

- `server/data/tron-rpc.ts`: 읽기 허용 목록에 `/wallet/getnowblock`(현재 헤더)과 비용 크기용 `/wallet/triggersmartcontract`(미서명 생성만)를 목적별로 추가하고 반환 구조를 검증합니다. `/walletsolidity/getnowblock`은 확정 헤더로 따로 표기하며 현 상태와 섞지 않습니다. 조회 시작/종료 블록·시각을 기록하고 30초/10블록을 넘기면 `unknown`입니다. 전체 25초 제한은 `AbortSignal`을 큐 대기·실제 fetch까지 전달해 만료된 작업이 뒤늦게 실행되지 않게 합니다. 429에서는 기존 쿨다운·호출 예산을 존중하고 즉시 일괄 재시도로 요청량을 늘리지 않습니다. 이는 **관측 범위**이며 동일 블록 보장은 아닙니다.
- `server/data/quotes.ts`: **jUSDT 전용 온체인 어댑터를 `readMarkets()`/jUSDD/PSM/MCP의 성공 여부와 분리**합니다. 기존 코드의 REST 실패 시 `jUsdt:null` 조기 반환을 제거합니다. 공식 Mainnet 주소로 jUSDT·USDT·Unitroller 코드, `underlying()`, `decimals()`, `comptroller()`, `markets(address).isListed`를 검증하고, 공식 계약 목록의 신규 공급 `active` 상태도 별도 확인합니다. `isListed`만으로 신규 공급 허용이라고 단정하지 않습니다. `supplyRatePerBlock()`과 `getCash()`를 직접 읽고 `Source.accessMethod:'rpc'`를 부여합니다. `getCash()`는 USDT 최소단위 6자리로 환산합니다. 블록당 금리의 1e18 mantissa에 공식 예제의 연간 10,512,000블록을 곱한 값은 **단순 APR**로 저장합니다. 기존 REST `supplyRate` APY는 실패해도 견적을 막지 않는 선택적 교차 확인/화면 참고값으로 남기고 APR과 합산하지 않습니다. 즉시 인출 가능량은 현재 `getCash()`이며 지출일의 현금을 보장하지 않습니다.
- 금액이 시장 이용률을 바꿀 수 있으므로 `totalBorrows`·`totalReserves`·`reserveFactorMantissa`·현재 `interestRateModel`의 주소/코드/함수·현재 `getCash()`를 검증합니다. 현재 값으로 모델의 `getSupplyRate(cash,borrows,reserves,reserveFactor)` 원시 1e18 mantissa와 실제 `supplyRatePerBlock`을 대조합니다. 실제 값이 0이면 정확히 0이어야 하고, 양수이면 `abs(model−actual) <= max(1, ceil(actual/100))`(상대오차 1% 이내, 최소 원시단위 1)를 통과해야 합니다. 묶음 금액을 `cash`에 더한 뒤 같은 모델의 금리를 다시 계산하고 현재 금리와 **작은 값**을 `scenarioRateApr`로 씁니다. 모델 함수·구현·입력/출력이 검증되지 않으면 `scenarioRateApr=null`이고 조건부 후보를 보류합니다. 이는 예치 직후 이용률 영향만 반영한 현재 조건 시나리오이며 기간 중 변동을 확정하지 않습니다.
- 환율·포지션에 필요한 함수는 **읽기 전용**으로만 호출합니다. 기존 jUSDT 담보·차입이 있는 계정은 Unitroller `getAssetsIn`/`getAccountLiquidity`와 실제 포지션의 환매 모의 결과를 확인합니다. 현재 건전성만으로 특정 금액의 환매 가능을 확정하지 않으며, 확인 실패를 `출구 미확인`으로 둡니다. 기존 `observePortfolio()`의 블록 필드는 `null`이므로 잔액·포지션을 같은 관측 범위에서 다시 읽거나 서로 다른 범위의 독립 관측임을 표시해 적격 판정을 보류합니다.
- 완료 기준: REST/PSM 장애와 독립적으로 Mainnet 주소·단위·신규 공급 상태, 금리·현금의 RPC 출처/관측 범위를 가진 jUSDT 시장 견적이 만들어집니다. REST 조회 시각을 원천 갱신 시각으로 대체하지 않습니다.

### 2단계 · 실제 주소·금액의 행동별 비용

- 새 `server/data/jusdt-costs.ts`, `server/data/jusdt-reference-model.ts`(예정): USDT `allowance(owner,jUSDT)`를 읽어 `충분 → 승인 없음`, `0 → approve(target)`, `0보다 크고 부족 → approve(0), approve(target)`을 선택합니다. 여러 날짜 구간을 한 번에 예치한다면 **그 거래 묶음의 총 승인액**을 기준으로 allowance를 판단합니다. 이미 쓸 수 있는 승인량을 무조건 새로 설정하지 않습니다. bundle의 `actions`가 실제 0/1/2회 승인을 표시하도록 만들고, 기존 단일 `Plan.steps`의 고정 `approve`를 이 날짜별 bundle의 실제 단계로 재사용하지 않습니다.
- 각 `approve(address,uint256)`, `mint(uint256)`와 `redeemUnderlying(uint256)`의 ABI 매개변수와 USDT 최소단위를 고정합니다. 실제 호출자 주소로 `triggerconstantcontract`를 호출할 때 HTTP/API `result`, TVM `transaction.ret[0].ret`, **USDT approve의 `true`와 JustLend 함수의 성공 코드 `0`**을 각 함수에 맞게 검사한 뒤 `energy_used`를 사용합니다. `estimateenergy`가 지원되면 대조하고 미지원이면 이를 진단에 남깁니다. `callConstant()`의 고정 READ_OWNER·첫 반환 word 헬퍼를 거래 시뮬레이션에 재사용하지 않고 별도 결과 파서를 둡니다. 성공하지 않은 모의 실행의 Energy를 성공 거래의 비용으로 채택하지 않습니다.
- `/wallet/getchainparameters`의 현재 `getEnergyFee`·`getTransactionFee`, `/wallet/getaccountresource`의 실제 지갑 자원, 거래 크기의 Bandwidth 근거를 결합합니다. 승인 초기화→승인→각 예치 순서대로 **한 계정의 Energy/Bandwidth 잔여량을 차감**하여 무료 자원을 거래마다 중복 적용하지 않습니다. 수수료용 TRX 잔액, 현재 조건의 예상 TRX 소모, 모든 입구 행동을 감당할 TRX 예비액을 구분합니다. 미래 환매에는 현재 무료 자원을 이월하지 않습니다. 리소스/거래 크기를 확인할 수 없으면 비용을 0으로 가정하지 않습니다. `fee_limit`은 호출자 Energy 예산 필드이며 Bandwidth는 별도입니다.
- TRX 비용을 USDT로 환산할 때는 최신 TRX/USD와 USDT/USD 가격의 주소·단위·원천 갱신 시각을 검증해 `TRX_USD / USDT_USD`를 계산합니다. 기존 `server/agent/research.ts`의 SUN 가격 응답 검증을 공통 순수 파서로 추출할 수 있습니다. SUN에서 TRX 가격에 쓸 토큰 표현은 공식 자료/실응답으로 먼저 확인하며, 확인되지 않거나 가격이 오래되면 환산 비용은 `null`입니다. 현물 가격은 금액별 교환 실출력으로 표시하지 않습니다.
- 예치 전에는 allowance 부족 때문에 `mint`가, jUSDT 잔액 부족 때문에 미래 `redeemUnderlying`이 **실제 사용자 상태에서 성공적으로 모의 실행되지 않을 수 있습니다.** 읽기 전용 호출은 이전 거래의 상태 변화를 만들지 못합니다. 따라서 (a) 실제 주소의 성공한 현재 진입 모의 비용, (b) 검증된 기준 계정·과거 확정 영수증과 호출 조건으로 만든 비용 모델, (c) 아직 확인할 수 없는 미래 회수 비용을 분리합니다. (b)는 `scenario_only`이며 거래 성공 근거가 아닙니다. `fee_limit`만으로 미래 환매의 필요한 Energy나 USDT 비용의 상한을 증명하지 않습니다. 미래 비용 모델·환산·출구 근거를 독립 검증하지 못하면 왕복비용은 `null`이고 신규 예치는 보류입니다. 검증한 비용 모델도 **현재 조건의 계획 시나리오**일 뿐이며 실행 직전·예치 직후·회수 목표일 전에 다시 견적합니다. 악화되면 신규 예치를 중단하고 이미 예치한 자산은 현재 포지션 기준의 조기 회수 가능성을 검토합니다.
- 완료 기준: 현재 계정 관측/성공한 모의 실행, 다른 계정·과거 자료 기반 모델, 미확인을 화면과 계산에서 구별합니다. TRX·USDT 단위와 입구·출구 예비액을 중복 없이 재현할 수 있고 어느 단계가 실패해도 비용 0 또는 거래 가능으로 승격되지 않습니다. 참조 영수증/가격 제공이 불가하면 **보류 응답도 정상 완료**로 검증합니다.

### 3단계 · 날짜별 순익과 승인 비용 집계

- `shared/planning.ts`: 기존 `createDatedAllocation()`은 Nile/PSM·가상 비교용으로 보존하고, Mainnet 지갑 평가에만 `createSizedJusdtAllocation(needs, marketQuote, legQuotes, bundleInputs)`라는 순수 경로를 추가합니다. `createMainnetPlans()`는 선택적 `jusdtSizing` 인자로 이 경로를 받아 기존 단일 Plan·PSM 계산을 깨지 않습니다. `server/data/jusdt-costs.ts`는 `readJusdtSizing({ walletAddress, observedUsdtRaw, observedTrxSun, legs, marketQuote })`를 제공하고 원천 조회만 담당합니다. 순수 계산기는 RPC를 호출하지 않습니다. 비상예비액과 이미 지급 기일이 도래한 금액은 보유하며 명시적 출구 위험 확인 없는 지출액도 보유합니다.
- 기존 구간별 탐욕 선택을 그대로 쓰지 않고 위의 **최대 256개 묶음 전수 비교**를 적용합니다. 각 부분집합에서 공동 승인 0/1/2회·구간별 금액 반영 금리·환매액·비용·총 TRX 예비액·현재 출구 현금·지급일 완충을 포트폴리오 단위로 재검사합니다. 승인 비용은 묶음에서 한 번만 합산하고 구간별 기여 순익 합계가 선택 묶음 순익과 같게 합니다. 예치·환매는 실제 예정된 거래 각각에 비용을 붙이고 `network`를 다시 더하지 않습니다. 수익·가격·비용은 미래 보장이 아닙니다.
- `shared/eligibility.ts`: 기존 `feeReserve`는 `needs.asset` 단위이므로 Mainnet USDT에서는 **USDT 값**입니다. 이를 TRX 잔액처럼 쓰지 않고 의미가 드러나는 입력 자산 예비액으로 정리합니다. `requiredFeeTrx`, `availableFeeTrx`와 각 출처/시각은 별도 계약으로 받아 비교합니다. 비용 시나리오의 USDT 환산값은 순익 차감용이고 실제 수수료 지급 재원은 TRX로 확인합니다.
- 같은 jUSDT 시장을 쓰는 구간들의 예상 회수액을 합산해 현재 `getCash()`와 대조합니다. 구간별 회수 목표일, 지급일 전 완충 기간, TRX 예비액, `wallet USDT >= 비상예비액 + 보유 판정된 지출액 + 총 예치액`을 검사합니다. 현재 현금은 미래 출구 보장이 아니며, 특히 미래 지출액을 투자했다면 그 원금을 이미 유동 USDT로 보호했다고 표현하지 않습니다.
- `shared/agent-decision.ts`: 현재 단일 `Plan` 판정은 유지하되 `decideDatedAllocation()`을 추가해 위 `datedDecision`을 별도로 만듭니다. 미래 비용 모델에 기존 `all_verified`를 붙이지 않고 `current_conditions_scenario`로 표시합니다. jUSDD/PSM 실패가 jUSDT 후보의 선택 경로 상태를 `mixed`로 바꾸지 않도록 **선택 경로 진단**과 전역 진단을 구분합니다. 누락 비용·가격·TRX 재원·출구, 만기 전 회수 불가, 예상 또는 스트레스 순익 0 이하에는 `hold` 또는 `insufficient_data`를 선택합니다. `conditional_allocate`도 읽기 전용이며 `executionEligible:false`입니다.
- 완료 기준: 7일 뒤 200 USDT, 30일 뒤 800 USDT 예에서 실제 조건에 따라 각 구간이 보유/조건부 후보로 나뉘고 비용이 달라집니다. 공동 승인은 한 번만 집계됩니다. 7일 구간의 한계 예상 순익이 0 이하이거나 출구 위험 확인이 없으면 해당 구간은 보유합니다.

### 4단계 · 에이전트, 감시, 화면 연결

- `server/agent/assessment.ts`: 이미 관측한 Mainnet USDT 상한과 `PortfolioSnapshot.feeBalance`의 **TRX**를 별도 단위로 검증해 `readJusdtSizing`에 연결합니다. 기존 `dependencies.mainnetQuotes()`는 시장 공통 조회로 남기고 jUSDT 견적 실패는 PSM 실패와 독립 진단합니다. 현재 포트폴리오 관측은 `blockNumber:null`이므로 금액별 묶음의 블록 범위에 맞춰 재관측하거나 미검증으로 둡니다. 사용자 진술액, 지갑 관측액, 상시 보유액, 조건부 투자된 미래 지출액을 분리합니다. 평가 응답에 leg/bundle ID·만료·보류 이유와 `datedDecision`을 포함하고 요약은 이를 우선 반영합니다. `assessment.dataMode`는 전역 진단, `selectedRouteDataMode`는 선택 jUSDT 경로로 분리하며 역사 모델이 있으면 `all_verified`로 표기하지 않습니다.
- `server/index.ts`: 가상 `/api/plans`와 지갑 기반 `/api/agent/assessment`의 권한·라벨을 구별하고 같은 순수 계산기를 사용합니다. 상세 견적 실패가 전체 API 500 또는 가짜 샘플 수치로 바뀌지 않게 `unavailable` 진단으로 반환합니다. 주소·금액별 외부 호출에 기존 rate limit/캐시를 적용하되 만료 견적을 재사용하지 않습니다.
- `src/features/agent/AgentPanel.tsx`, `src/features/plans/PlanExplorer.tsx`: 에이전트의 **지갑 기반** 평가와 수동 `/plans`의 **가상** 비교를 합쳐 보이지 않게 구분합니다. 구간별 운용액, 현재/예치 후 금리 중 낮은 값의 수익 시나리오, 승인/예치/회수별 비용·TRX 예비액, `hold` 사유, 출처·관측 범위·만료시각을 표시합니다. 날짜별 경로의 승인 횟수는 단일 `Plan.steps`가 아니라 `JusdtBundleQuote.actions`와 일치시킵니다.
- `src/features/review/monitor-read.ts`, `src/features/review/goal-monitor.ts`, `src/features/review/ReviewPanel.tsx`: 저장한 **원 견적 버전**과 재평가한 **새 견적 버전**을 비교합니다. 에이전트 경로는 `/api/agent/assessment`로 새 금액별 견적을 읽고, 수동 `/plans` 경로는 계속 가상 재평가임을 표시합니다. `positionState=uninvested|confirmed_jusdt|unknown`을 명시합니다. `uninvested`는 새 USDT 진입 견적, `confirmed_jusdt`는 실제 jUSDT 잔액·포지션·현재 환매 견적을 사용하며 원 USDT가 그대로 남아 있다고 요구하지 않습니다. 과거 저장 기록에 확정 포지션 근거가 없으면 `unknown`으로 보류하고 사용자에게 실제 상태 확인을 요구합니다. 지출일 접근이나 비용·유동성 악화에는 `신규 예치 보류/계획 재검토/조기 회수 검토`만 제안합니다. 실제 회수 주문이나 자동 거래는 하지 않습니다.
- 완료 기준: `/needs` 에이전트 평가 → `/review` 기준선 감시에서 원 버전과 새 버전의 차이 및 보류 이유가 보입니다. 별도의 수동 `/plans` → `/review`는 가상 비교로 일관되게 표시합니다. 브라우저를 닫은 뒤 감시·알림이 계속된다고 표시하지 않습니다.

### 바로 착수할 작업 묶음과 순서

| 순서 | 선행 조건 | 변경 파일/산출물 | 통과 조건과 막힐 때의 결과 |
| --- | --- | --- | --- |
| W0 계약·세션 | 없음 | `shared/schemas.ts`, `shared/agent-request.ts`, `server/agent/intake.ts`, `src/lib/session.ts` | 구버전 요청·세션 보존, 위험 수용 기본 보유, leg/bundle ID·만료 파싱 테스트. 실패 시 W1–W4 연결 금지 |
| W1 Mainnet 원천 실증 | W0 | `server/data/tron-rpc.ts`, `server/data/quotes.ts`, 읽기 전용 원시 응답의 **스키마/지원 상태만** 기록한 테스트 fixture | jUSDT 독립 금리·현금·신규 공급, 이자율 모델, TRX/USDT 가격·시각, 계약 거래 목록/확정 영수증 필드 확인. 외부 미지원은 fixture로 성공을 꾸미지 않고 원천별 `unknown` |
| W2 행동 비용 | W1의 ABI/단위 확인 | `server/data/jusdt-costs.ts`, `server/data/jusdt-reference-model.ts` | allowance 3분기·현재 모의/참조 모델/unknown·서명 크기·TRX 예비액 테스트. 가격 또는 참조 영수증 미지원이면 순익 `null`/보류 API까지 완성 |
| W3 배분 계산 | W0, W2의 입력 계약 | `shared/planning.ts`, `shared/eligibility.ts`, `shared/agent-decision.ts` | 200/800 구간, 묶음 비용 한 번, 양의 한계 예상·스트레스 순익, 보호액·현재 현금·TRX 재원 불변식 통과 |
| W4 평가·UI·감시 | W3 | `server/agent/assessment.ts`, `server/index.ts`, `/needs`·`/plans`·`/review` 관련 컴포넌트 | 지갑 경로만 금액별 실측/모델, 가상 경로는 가상 유지. 포지션 전후 감시와 이유·원천·만료 표시 |
| W5 검증·기록 | W0–W4 | 대상 테스트, `./scripts/run run check`, `./scripts/run run doctor`, 브라우저 점검, `docs/IMPLEMENTATION_STATUS.md` | 코드/외부 읽기/조건부 후보를 각각 기록. 외부 증거가 없는 경우 보류가 맞는지 확인하고 실거래·수익성 완료로 표기하지 않음 |

W1 외부 조회에서 공급 상태·TRX 가격 표현·이자율 모델 ABI·영수증/과거 구현 일치 중 하나라도 증명되지 않으면 **그 항목을 필요로 하는 조건부 예치는 보류**합니다. 팀이 다음 구현 단계로 진행하는 것과 실사용자에게 운용 후보를 보여 주는 것은 별도 게이트입니다. 키는 서버 비공개 환경에서만 읽고 fixture·로그·문서에 넣지 않습니다.

## 4. 검증표와 완료 게이트

| 검증 위치 | 반드시 재현할 사례 | 통과 조건 |
| --- | --- | --- |
| `tests/backend-reads.test.ts`, `tests/quote-mcp.test.ts`, 신규 견적 테스트 | REST·PSM 단독 장애에서 jUSDT RPC 독립 동작, 공식 신규 공급 상태, 주소/단위 불일치, APR 1e18 환산, 현금 6자리 환산, 블록 범위 초과, 429, 오래된 원천, SUN 가격 주소·시각 오류 | 해당 항목 `unknown/unavailable`; 임의 값 삽입 없음. jUSDT는 선택적 REST 장애만으로 사라지지 않음 |
| 신규 비용 테스트 | allowance 충분/0/잔여, `approve(0)` 2회 경로, **승인 뒤 상태 미변경으로 mint 실패**, TVM/API/JustLend 반환 코드 오류, `estimateenergy` 미지원, 확정 영수증 부족·오래됨·구현 변경, 공유 자원 중복 차감, 미래 환매에 현재 무료자원 미적용, 다중서명·Bandwidth 누락, TRX 가격·잔액 부족 | 행동 수·출처 단계·TRX 비용·USDT 환산 상태가 정확하며 미확인을 0원/`fee_limit`으로 대체하지 않음. 서명·방송 호출 없음 |
| `tests/planning.test.ts`, `tests/manual-allocation.test.ts` | 200/800 USDT 서로 다른 비용, 공동 승인 1회·묶음 금액 변경 시 승인 경로 변경, **두 구간 각각 음수지만 공동 승인 묶음 양수**, 예치 후 금리 모델 불일치, 계획 환매 원시 금액과 표본 범위·여러 출구 합산, TRX/USDT 단위 분리, APR/APY 구별, 1일 회수 완충, 예상 양수·스트레스 음수, 예비액·미동의 지출액 보유, 8버킷 초과 | 최대 256집합 비교, 비용 중복 없음, 기여 순익 합계, 선택 구간과 전체 불완전 상태·보류 판정 재현 |
| `tests/agent-assessment.test.ts`, `tests/goal-monitor.test.ts`, `tests/api-boundary.test.ts`, 세션 테스트 | 지갑 없음/주소 변경, 진술액>실잔액, 만료·가격 변동, TRX 부족, 선택 jUSDT와 무관한 PSM 장애, 실제 포지션의 출구 재평가, 구버전 세션 이행/재확인, 읽기 API 폭주·429·25초 제한 | 잘못된 견적을 추천·실행으로 넘기지 않고 원 견적/새 견적·가상/지갑·예치 전/후를 구분 |
| 통합 검증 | `./scripts/run run check`, `./scripts/run run doctor`, 실제 Mainnet **읽기 전용** 소액/서로 다른 금액 재조회, 브라우저 `/needs`·`/plans`·`/review` | 테스트·타입·빌드 통과와 응답의 원천/금액/시간/보류 사유 확인. 키/주소/원문 거래 데이터는 로그에 노출하지 않음 |

**완료 선언 조건을 셋으로 나눕니다.** **코드 완료:** (1) jUSDT 온체인 경로가 REST/PSM과 독립이고, (2) 계정·금액·회수 목표일별 근거와 공동 승인 비용이 정확히 결합되고, (3) 미확인 값은 `null`/보류이며 저장·화면·감시도 이를 유지하고, (4) 테스트·타입 검사·빌드가 통과합니다. **외부 읽기 실증:** 실제 Mainnet의 서로 다른 두 금액으로 RPC·가격·자원·이자율 모델·참조 영수증·출구의 조회 근거를 확인합니다. 제공자 지원이나 미래 환매 상태 때문에 전체 왕복을 확인하지 못하면 **부분 실증**으로 남깁니다. **운용 후보 판정:** 선택 경로의 현재 자료, 수수료용 TRX, 현재 출구, 금액 반영 후 금리, 현재 조건의 모든 행동 비용 모델, 회수 완충과 명시적 위험 확인이 충족되고 **예상·스트레스 순익이 모두 양수**일 때만 읽기 전용 조건부 후보를 표시합니다. 이 셋 중 하나를 달성해도 Mainnet 거래 실증이나 지급일 회수 보증으로 표시하지 않습니다. 결과는 `docs/IMPLEMENTATION_STATUS.md`에 각각 기록합니다.

## 5. 이번 범위에서 제외하는 것

- Mainnet TronLink `approve`·`mint`·`redeem` 서명/방송, 자동 매매 및 무인 실행. 한 번의 읽기 결과나 주소 연결은 거래 승인·완료가 아닙니다.
- jUSDD/PSM 양방향 실견적. 두 경로 비교 달성 여부는 이 경로가 완성되어도 별도로 검증합니다.
- 미래 금리·시장 현금·Energy 가격·실제 거래 성공 보장. 예치 뒤 실제 회수액·수수료는 txID, 확정 영수증, 포지션 관측으로만 확인할 수 있습니다.

## 6. 공식 근거

- [JustLend 배포 계약](https://docs.justlend.org/developers/deployed_contracts/): Mainnet jUSDT/USDT/Unitroller 주소와 단위.
- [JustLend SBM 함수와 USDT 승인 주의사항](https://docs.justlend.org/developers/supply_and_borrow_market/sbm/): `supplyRatePerBlock`, `getCash`, `mint`, `redeemUnderlying`, `approve(0)`.
- [JustLend API](https://docs.justlend.org/developers/apis/): REST APY·현금은 시장 참고값이며 V1 원천 갱신 시각이 없습니다.
- [JustLend 금리 모델](https://docs.justlend.org/developers/supply_and_borrow_market/interest_rate_model/)·[출금 개념](https://docs.justlend.org/getting_started/concepts/withdraw/): 금리 변동과 현금/포지션에 따른 회수 제약.
- [TRON 시뮬레이션](https://developers.tron.network/reference/triggerconstantcontract)·[EstimateEnergy](https://developers.tron.network/reference/estimateenergy)·[FeeLimit 및 Energy](https://developers.tron.network/docs/set-feelimit)·[계정 자원](https://developers.tron.network/reference/getaccountresource): 읽기 전용 에너지 추정과 실행/비용 한계.
- [TRON 계약 거래 목록](https://developers.tron.network/reference/get-transaction-info-by-contract-address)·[확정 영수증](https://developers.tron.network/re/reference/gettransactioninfobyid-1)·[계약 코드 조회](https://developers.tron.network/re/docs/smart-contract-interaction): 참조 비용 모델의 API와 검증 대상.
- [TRON 자원 비용](https://developers.tron.network/docs/paying-for-resources): Energy와 Bandwidth의 별도 체인 단가·무료 자원 적용 순서.
- [SUN 토큰 가격 API](https://docs.sun.io/api/get-price/): 토큰별 USD 가격 문자열과 원천 `last_updated`.
