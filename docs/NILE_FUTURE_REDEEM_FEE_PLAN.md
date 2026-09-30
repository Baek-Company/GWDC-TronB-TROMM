# Nile jTRX 미래 환매 수수료 추정 구현 계획

작성일: 2026-09-30. 대상은 **Nile 시험망의 TRX → jTRX 예치와 `redeem(uint256)` 환매**입니다. 금액별 계획 화면에서 미래 환매 비용의 참고치를 보여주되, 거래 가능 판정과 최종 지갑 승인에는 최신 계정별 검증을 사용합니다. Mainnet USDT 비용이나 무인 거래 권한으로 전용하지 않습니다.

## 1. 현재 상태와 해결할 문제

- `server/data/quotes.ts`의 Nile 상품 견적은 `deposit`, `withdraw`, `network` 비용과 연환산 기본 금리가 모두 `null`입니다. 따라서 `shared/planning.ts`의 검증된 왕복 비용·순익·손익분기도 비어 있습니다. 비용 추정만 추가해도 **금리 검증은 별도 과제**이므로 검증된 순익을 즉시 표시할 수는 없습니다.
- `server/transactions.ts`의 `readNileRedeemCostBound`는 예치 전 jTRX가 없는 상태에서 환매 거래의 크기와 체인 전체 `fee_limit` 상한만 읽습니다. 반환되는 `estimatedFeeSun: null`이 맞습니다. 이 상한을 예상 수수료로 표시하지 않습니다.
- 같은 파일의 `readNileWithdrawalState`는 **jTRX를 실제 보유한 계정**에서 해당 수량의 환매를 현재 상태로 시뮬레이션하고 Energy·Bandwidth 단가, 시장 현금, TRX 잔고를 확인합니다. 최종 미리보기의 수명은 180초입니다. 현재 `estimatedFeeSun`은 보유 무료 Energy·Bandwidth를 차감하지 않아 실제 TRX 소각액의 계정별 예상치라기보다 보수적인 전액 소각 가정입니다. 현재 `feeLimitSun = 예상 Energy 비용 × 2`도 미래 동적 Energy 변화의 보증 상한은 아닙니다.
- `docs/NILE_A_EVIDENCE.md`의 **1 TRX 예치 → 전량 환매 1건**은 환매 실비 7.2569 시험 TRX, 예치 포함 왕복 수수료 15.3463 시험 TRX를 입증합니다. 이 거래 하나로 다른 금액·지갑·날짜의 환매 수수료를 추정하거나 50/50·80/20 후보의 순익을 확정할 수 없습니다.

## 2. 결과를 세 등급으로 분리

| 등급 | 표시 내용 | 사용 가능한 시점 | 계획·실행에서의 용도 |
| --- | --- | --- | --- |
| 과거 실비 | 확정 거래 영수증의 실제 Energy, Bandwidth, TRX 수수료 | 확정 이후 | 이전 시험 결과와 오차 비교. 미래 견적으로 복사하지 않음 |
| 예치 전 참고 시나리오 | 충분한 jTRX를 가진 **기준 계정의 현재 모의 실행** 또는 같은 계약의 검증된 과거 유사 거래로 만든 현재 단가 기준 비용 범위. 사용한 근거를 각각 표시 | 기준 계정 모의 실행에 성공하거나 과거 표본 게이트 통과 후 | 후보 금액별 참고 비용과 수수료 예비액 제안. `roundTripCost`·`netYield`의 검증값 또는 자동 거래 승인으로 승격하지 않음 |
| 보유 계정의 현재 견적 | 실제 주소·jTRX 수량으로 성공한 `redeem(uint256)` 시뮬레이션, 현재 자원 반영 소각 예상치, 별도 수수료 상한 | 환매 가능한 포지션 보유 후 | 현재 시점의 환매 미리보기. 서명 직전 재발급·재검증 필요 |

자료가 부족하면 `unknown`을 반환합니다. `0 TRX`나 체인 전체 최대 한도를 예상 수수료처럼 표시하지 않습니다. 실제 수수료는 확정 영수증에서만 확정합니다.

## 3. 산식과 근거 계약

모든 체인 금액은 `SUN` 정수 문자열과 `BigInt`, 화면의 TRX 환산은 `Decimal`로 처리합니다. `fee_limit`은 **호출자가 부담할 Energy 사용 상한**이고, Bandwidth 비용은 별도로 더합니다. 실제 Energy 비용에는 계약의 호출자·배포자 분담과 사용 가능한 Energy가 영향을 줍니다. 분담을 입증하지 못하면 호출자 100% 부담으로 계산합니다. [TRON FeeLimit·Energy](https://developers.tron.network/docs/set-feelimit), [TRON 자원 과금](https://developers.tron.network/docs/paying-for-resources)

1. **현재 계정 시뮬레이션:** 같은 주소·계약·정확한 jTRX 원시 수량으로 `triggerconstantcontract`를 호출합니다. API `result`, 제공된 TVM 실행 상태, `redeem()`의 반환 코드 `0`을 확인합니다. 지원되는 노드의 `estimateenergy.energy_required`도 읽고, 성공한 두 Energy 값의 큰 쪽을 비용 계산에 사용합니다. `estimateenergy` 명시적 미지원에만 성공한 constant simulation의 `energy_used`로 대체하며, 429·timeout·계약 실패를 0 비용으로 바꾸지 않습니다. [TRON 시뮬레이션](https://developers.tron.network/reference/triggerconstantcontract), [TRON Energy 추정](https://developers.tron.network/reference/estimateenergy-2), [JustLend 환매 함수](https://docs.justlend.org/developers/supply_and_borrow_market/sbm/)
   예치 전에는 사용자님 지갑 대신 충분한 jTRX를 가진 **기준 계정**으로 같은 읽기 전용 호출이 가능한지 P0에서 실제 Nile 조회로 확인합니다. 가능하다는 판단은 TRON API의 `owner_address`와 JustLend 환매 동작을 연결한 **추론**입니다. 기준 계정의 보유량·담보·시장 유동성·실행 경로가 다르므로 성공해도 `representative_simulation` 참고치로만 저장합니다. 후보 계정을 찾지 못하거나 실행이 실패하면 이 경로는 `unknown`입니다. [TRON 시뮬레이션 API](https://developers.tron.network/reference/triggerconstantcontract), [JustLend 출금 조건](https://docs.justlend.org/getting_started/concepts/withdraw/)
2. **현재 자원 반영 소각 시나리오:** `E = 시뮬레이션 Energy`, `B = 서명 예상 거래 바이트`, `pE = getEnergyFee`, `pB = getTransactionFee`로 두고, 확인된 호출자 부담 Energy에서 현재 사용 가능한 Energy를 차감한 양에 `pE`를 곱합니다. `B`에서 현재 사용 가능한 Bandwidth를 차감한 양에 `pB`를 곱해 더합니다. 이는 **조회 순간의 소각 예상치**이며, 다른 거래의 자원 소비·재생과 실행 경로 변화는 반영하지 못합니다. 서명 전 `B`는 unsigned 거래 바이트에 서명·인코딩 여유를 더하고, 실제 서명 길이/영수증으로 검증합니다. [TRON 계정 자원 조회](https://developers.tron.network/reference/getaccountresource)
3. **미래 참고 시나리오:** 적용 가능한 과거 성공 표본의 최대 기본 Energy와 체인의 `getDynamicEnergyMaxFactor`로 동적 Energy 변화를 반영합니다. `energy_penalty`를 확인할 수 없는 표본은 기본 Energy를 단정하지 않고 더 보수적인 총 Energy 기준으로 계산합니다. 미래 무료 자원은 **0**으로 두고 현재 단가 `1×`와 `2×`를 각각 보여줍니다. `2×`는 사용자가 읽을 수 있는 스트레스 가정일 뿐 미래 가격 상한이 아닙니다. 표본 밖 실행 분기와 체인 정책 변경도 보증하지 않습니다. [TRON 동적 Energy·견적 한계](https://developers.tron.network/docs/set-feelimit)
4. **서명용 상한:** 현재 성공한 시뮬레이션 Energy의 2배와 현재 기본 Energy에 체인의 동적 Energy 최대 배수를 적용한 값 중 큰 쪽을 근거로 `feeLimitSun`을 잡는 정책을 검토합니다. 동적 Energy 파라미터를 읽지 못하면 이를 아는 척해 상한을 확정하지 않습니다. 체인 `getMaxFeeLimit` 초과 시 중단합니다. `feeLimitSun + 서명 전 Bandwidth 예산`은 지갑이 준비할 **사전 비용 예산**으로 표시하고, 서명 후 실제 거래 바이트 크기를 방송 전에 다시 검사합니다. 이를 예상 실제 납부액이나 미래의 절대 상한과 혼동하지 않습니다.

## 4. 예치 전 참조 표본의 증거 게이트

**우선 시도할 읽기 전용 경로:** Nile에서 동일 jTRX를 충분히 보유한 기준 계정을 찾고, 후보 금액을 현재 환율로 환산한 jTRX 원시 수량을 그 계정이 보유하는지 확인합니다. 담보·차입 때문에 환매가 막히는 계정은 제외합니다. 각 후보 수량으로 성공한 `redeem(uint256)` 모의 실행을 얻으면 계약 코드·계정·수량·블록/조회 시각·Energy·자원/가격 근거를 묶어 `representative_simulation`으로 표시합니다. 이 값은 **기준 계정의 현재 실행 비용 시나리오**이며 사용자님 지갑의 견적이 아닙니다. 표본 영수증은 이 결과를 과거 실비와 비교해 편향을 점검하는 별도 근거입니다. 이 읽기 전용 경로가 실패해도 거래를 일으켜 결과를 만들지 않습니다.

**과거 실비 기반 모델의 게이트:** 아래 조건을 모두 통과해야 `historical_reference` 숫자를 만듭니다.

1. 읽기 전용으로 Nile jTRX `Redeem` 이벤트에서 후보 txID를 찾거나, 사용자 승인형 시험 거래가 이미 남긴 원장을 사용합니다. 인덱스 이벤트는 발견 경로일 뿐 성공 증거가 아닙니다. 후보마다 solidified 원 거래 본문·영수증을 다시 읽고 `SUCCESS`, 동일 Nile 체인·계약, `redeem(uint256)` selector·수량, 실제 `fee`·`energy_usage_total`·`net_fee`, 서명 거래 크기, 블록 시각을 대조합니다. [TRON 거래 영수증](https://developers.tron.network/reference/gettransactioninfobyid)
2. **실제로 실행된 코드 동일성**을 먼저 확인합니다. Nile jTRX가 프록시인지 조사하고, 프록시라면 표본 당시와 현재의 구현 주소·구현 코드 해시를 독립적으로 증명합니다. 현재의 jTRX 런타임 코드 해시나 일부 이벤트만으로 과거 구현을 증명하지 않습니다. 증명 경로가 없으면 표본 수가 많아도 모델은 `unknown`으로 유지하고 과거 실비만 표시합니다. Mainnet에서 같은 문제로 참조 모델을 보류한 근거는 `docs/JUSDT_REFERENCE_EVIDENCE_GATE.md`에 있습니다.
3. 해당 **수량 구간·전량/부분 환매 경로마다** 동일 계약·구현·메서드의 서로 다른 성공 txID를 최소 5건 확보하고, 이어진 독립 1건으로 모델 상한과 실비를 비교합니다. 대상 수량의 0.5~2배 밖, 30일 초과, 중복·실패·다른 체인·코드 불일치 표본은 제외합니다. 이 숫자는 프로젝트의 초기 품질 정책이지 통계적 보증은 아닙니다. 오차 검증이 실패하면 수치 추천에 연결하지 않고 정책을 재평가합니다. 현재 1 TRX 사례는 이 조건을 충족하지 않습니다.
4. 공개 이력과 코드 증거가 모자라면 `unknown`으로 종료합니다. 추가 실거래를 표본 확보 목적으로 자동 수행하지 않습니다. 별도의 Nile 시험 거래가 필요해지면 금액·최대 수수료·지갑 승인을 거래마다 사용자님께 제시합니다.

## 5. 구현 순서와 변경 대상

| 단계 | 작업 | 주요 파일 | 완료 기준 |
| --- | --- | --- | --- |
| P0 — 증거 가능성 | Nile jTRX 코드 구조와 과거 구현 증명 가능성, 이벤트/영수증 데이터 경로, 충분한 jTRX를 가진 기준 계정의 읽기 전용 모의 실행 가능성을 점검 | `server/transactions.ts`, `server/data/tron-rpc.ts`, 이 문서 | `representative_simulation`·`historical_reference`를 각각 사용 가능/불가 및 이유로 판정. 둘 다 실패해도 P2의 현재 견적 개선은 진행 |
| P1 — 비용 증거 | Nile 전용 엄격한 schema와 기준 계정 모의 실행·과거 영수증 표본 검증기/모델 추가. `mainnet` 한정 `shared/jusdt-cost-model.ts`는 규칙만 참고 | `shared/schemas.ts`, 신규 `shared/nile-cost-model.ts`, 신규 `server/data/nile-costs.ts` | 모든 근거에 체인·계약·메서드·수량·시각·출처를 묶음. 과거 모델은 실제 실행 코드·txID가 불일치하면 `unknown`; 기준 계정 시뮬레이션은 성공 결과와 해당 계정의 현재 상태를 검증하며 계정별 견적으로 표시하지 않음 |
| P2 — 현재 견적 | 환매 모의 실행 결과 확인 강화, 두 Energy 추정 비교, 자원 반영 소각액과 `fee_limit`/Bandwidth 상한 구분 | `server/transactions.ts`, `shared/nile-withdrawal-revalidation.ts` | 실제 jTRX 보유 계정만 현재 견적을 받고 180초 후 만료. 지갑/수량/코드/유동성/조건 악화 시 재확인 또는 중단 |
| P3 — 금액별 계획 | 후보 예치액에서 예상 jTRX 수량을 계산하고 참조 비용을 각 후보에 적용. 현재 예치 시뮬레이션 비용과 미래 환매 시나리오를 합산하되 수수료 중복 제거 | `server/index.ts`, `server/data/quotes.ts`, `shared/planning.ts`, `server/agent/assessment.ts` | 80/20·50/50별 근거와 시나리오를 반환. `deposit`/`withdraw`가 각각 네트워크 수수료를 포함하면 별도 `network`를 더하지 않음. 참고치만으로 검증된 `roundTripCost`·`netYield`·추천 적격성을 생성하지 않음 |
| P4 — 예비액·UI | 보호 지출을 먼저 떼고 예치 상한 및 환매 스트레스 비용을 반영한 TRX 예비액을 후보별로 계산. 실제 잔액보다 크면 `거래하지 않음` 표시 | `shared/planning.ts`, `src/features/plans/PlanExplorer.tsx`, `src/features/execution/NileWithdrawalPanel.tsx` | 참고 비용/현재 지갑 견적/확정 실비가 서로 다른 라벨과 출처·시각·가정·만료를 표시. 비용 근거가 없을 때 `미산정` 이유와 다음 필요한 증거 표시 |
| P5 — 영수증 보정 | 확정 수수료와 직전 예상치의 오차를 기록하고, 수량·전량/부분·자원 조건별 편향을 검토 | 승인 원장·포지션 관측 코드, `docs/NILE_A_EVIDENCE.md` | 확정 영수증과 포지션을 모두 확인한 거래만 학습 자료로 채택; 오차가 상한을 넘으면 모델 무효화 |

`P4`의 수수료 예비액은 금액에 따라 달라집니다. 후보 예치액을 먼저 계산한 뒤 **진입 상한 + 출구 스트레스 비용**을 유동 자산에서 남겨 두고 예치액을 재계산합니다. SUN 단위로 안정될 때까지 제한 횟수 안에서 반복하고, 수렴하지 않거나 예비액이 남은 운용 가능액보다 크면 예치를 보류합니다. 예정 지출액을 수수료 재원으로 잠식하지 않습니다. 참조 모델이 없으면 출구 예비액도 확인 불가로 두고 경제성 추천을 보류하되, 별도 승인형 Nile 기술 시험 경로는 명확한 경고와 최신 미리보기 정책에 따라 유지할 수 있습니다.

## 6. 검증 및 인수 기준

- 단위·API 시험: 무잔고 환매, 보유량 부족, 담보/유동성 때문에 실패한 환매, ABI 오류 코드, `estimateenergy` 미지원과 429/timeout, 무료 자원 0/충분, Energy·Bandwidth 분리, 동적 Energy·가격 변경, 금액·체인·코드·txID·시각 불일치, 중복 네트워크 비용, 보호 지출/수수료 재원 부족을 재현합니다. `tests/execution.test.ts`, `tests/planning.test.ts`, `tests/nile-schedule.test.ts`, `tests/approval-plan.test.ts`, `tests/agent-assessment.test.ts`와 신규 Nile 비용 모델 테스트를 사용합니다.
- 근거 검증: 과거 1 TRX 한 건만으로 50/80 TRX 비용이 생성되지 않아야 합니다. 프록시 과거 구현 증거가 없거나 표본·현재 단가가 만료되면 과거 모델은 `unknown`으로 돌아가야 합니다. 기준 계정의 성공 시뮬레이션은 `representative_simulation`이라고 표시하고, 사용자님 계정의 환매 실패를 덮거나 실행을 허용하지 않아야 합니다. 보유 후 현재 계정 견적이 예치 전 참고치보다 우선하고, 최종 서명에는 재발급한 미리보기만 사용해야 합니다.
- 회귀 검증: `./scripts/run run check`, `./scripts/run run doctor`, Nile 연결 화면에서 금액·출처·만료·상한 표시를 확인합니다. 실제 온체인 검증은 **읽기 전용 조회**까지 자동으로 진행합니다. 새 예치·환매 서명은 이 계획의 자동 검증 범위에 포함되지 않습니다.

### 완료 판정

사용자님은 예치 전 각 금액에 대해 **“기준 계정 모의 실행인지 과거 실비 모델인지, 어떤 수량·단가·무료 자원 가정으로 나온 참고 비용인지”**를 볼 수 있어야 합니다. 두 경로 모두 실패하면 구체적인 이유를 보고, 잘못된 숫자 대신 `미산정`을 보아야 합니다. 포지션을 보유한 뒤에는 본인 지갑의 **현재 예상 소각액**과 **사전 비용 예산**을 구별해 보고, 환매 직전에 최신 조건으로 다시 확인해야 합니다. 검증된 수익률·환매 조건까지 충족하기 전에는 비용 참고치만으로 신규 예치 추천이나 무인 거래를 활성화하지 않습니다.

## 7. 구현 및 읽기 전용 검증 결과 (2026-09-30)

| 단계 | 결과 | 확인 경계 |
| --- | --- | --- |
| P0 | Nile 공개 RPC에서 jTRX 계약·시장·환율을 확인했습니다. 보유자 인덱스로 찾은 별도 기준 계정에서 1 jTRX 및 현재 환율로 환산한 50·80 TRX 후보 수량의 `redeem(uint256)` 읽기 전용 모의 실행이 성공했습니다. | 거래를 서명하거나 방송하지 않았습니다. 기준 계정의 성공은 사용자님 지갑의 미래 성공을 보증하지 않습니다. |
| P1 | `shared/nile-cost-model.ts`와 `server/data/nile-costs.ts`에 체인·계약·수량·코드·계정·시각을 묶은 참고 모델을 추가했습니다. 충분한 보유자와 성공 시뮬레이션이 없으면 `unknown`입니다. | 과거 거래 기반 모델은 독립적인 당시 실행 코드 증거와 확정 영수증 5건 및 보류 검증 1건이 확보되기 전까지 활성화하지 않았습니다. 기존 1 TRX 왕복 사례는 여기서 제외됩니다. |
| P2 | 실제 보유 계정의 환매 견적에서 성공 시뮬레이션·ABI 반환 코드·두 Energy 조회를 확인하고, 현재 무료 자원을 차감한 예상 소각액, 자원 0 가정 비용, Energy `fee_limit`, Bandwidth 예산을 분리했습니다. 서명된 거래의 protobuf 크기와 결과 바이트를 서명 직후·서버 저장 전·방송 직전에 예산과 대조합니다. | 실비는 solidified 영수증만 확정합니다. 단가·Energy·시장 상태 변화 때문에 사전 비용 예산은 미래 절대 상한이 아닙니다. |
| P3·P4 | `/api/nile/plans`와 에이전트 평가에 금액별 읽기 전용 비용 sidecar를 연결했습니다. 예치 현재 비용과 환매 참고 비용을 한 번씩 합산하고, 보호 지출을 제외한 운용 가능액에서 수수료 예비액을 남기는 축소 상한을 후보 금액별로 최대 4회 다시 조회합니다. 계획 카드와 에이전트 화면에는 근거·시각·만료·미확인 이유를 표시합니다. | 축소 상한은 **비용 재원만** 반영한 참고치입니다. 기존 `Plan.roundTripCost`, `netYield`, 추천·승인 적격성은 검증된 금리와 출구 근거가 없으므로 변경하지 않았습니다. |
| P5 | 기존 확정 환매에서 저장된 동일 미리보기의 예상 소각액과 실제 solidified 수수료 차이를 화면에 표시합니다. | 현재 확정 왕복 1건은 과거 수수료 모델을 학습·활성화할 표본이 아닙니다. 당시 예상치는 P2 개선 이전 산식이어서 새 산식의 오차 검증에도 사용하지 않습니다. |

읽기 전용 실조회에서는 환율을 반영한 50·80 TRX 후보의 기준 계정 환매 참고치가 각각 **9.1295 시험 TRX**, 현재 단가 2배 스트레스 가정이 **18.259 시험 TRX**였습니다. 같은 조회 조건에서 금액이 같게 나왔다는 관측일 뿐, 비용이 수량과 무관하다거나 장래 수수료가 이 값이라는 주장이 아닙니다. 별도 공개 시험 지갑으로 조회한 100 TRX 입력·20 TRX 예비액 예시에서는 원래 80/50 TRX 후보 모두 수수료 예비액 부족으로 표시되고, 비용 재원을 반영한 읽기 전용 상한은 44.267 TRX로 계산됐습니다. 이 값도 수익성 추천과 거래 미리보기에는 사용하지 않습니다. 조회 근거는 시간이 지나면 만료되며 새로 조회해야 합니다.
