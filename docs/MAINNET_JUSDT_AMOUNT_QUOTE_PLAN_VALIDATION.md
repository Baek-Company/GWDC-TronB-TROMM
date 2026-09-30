# Mainnet jUSDT 금액별 실견적 계획 검증

검증일: 2026-09-29  
대상: [MAINNET_JUSDT_AMOUNT_QUOTE_PLAN.md](MAINNET_JUSDT_AMOUNT_QUOTE_PLAN.md)  
범위: 현재 저장소의 데이터·계획·평가·감시 계약과 JustLend/TRON/SUN 공식 문서. **계획의 타당성 검토이며 견적 기능의 실증은 아닙니다.**

## 판정

**구현 착수 가능, 운용 후보는 조건부.** 계획의 계약·순서·수치 정책·테스트·외부 미지원 시의 보류 결과를 고정했습니다. 새 지갑에서 승인→예치→미래 환매를 읽기 전용 호출만으로 연속 성공시켜 **실제 계정의 전체 왕복 수수료를 미리 실측하는 목표는 일반적으로 달성할 수 없습니다.** 현재 계정의 성공 모의 결과, 과거 확정 영수증 기반 비용 시나리오, 미확인을 행동별로 분리합니다. 외부 시나리오 근거가 확보되지 않아도 `null`/보류 경로까지 코드로 완성할 수 있지만, 신규 예치 후보는 표시하지 않습니다. 이 판정은 **계획의 구현 가능성**이며 기능 구현·실거래 성공을 뜻하지 않습니다.

## 발견 사항과 계획 반영

| 심각도 | 발견한 문제와 근거 | 계획에 반영한 수정 |
| --- | --- | --- |
| P0 | [`readMainnetQuotes()`](../server/data/quotes.ts)는 REST 실패 시 jUSDT도 `null`로 반환합니다. REST V1에는 원천 갱신 시각이 없습니다. | jUSDT 온체인 금리·현금·계약 검증 경로를 REST/PSM/MCP와 분리하고 REST는 선택적 대조로 낮췄습니다. |
| P0 | [`createDatedAllocation()`](../shared/planning.ts)는 모든 금액에 동일 `ProductQuote.costs`를 적용하고 독립 구간별 탐욕 선택을 합니다. | 주소·금액·회수 목표일별 견적과 포트폴리오 행동 묶음 재계산을 명시했습니다. 공동 승인 비용은 한 번만 합산합니다. |
| P0 | 기존 `feeReserve`는 [`needs.asset` 단위](../shared/eligibility.ts)입니다. Mainnet에서는 USDT이며 수수료용 TRX와 같지 않습니다. | `requiredFeeTrx`/`availableFeeTrx`를 별도로 비교하고 USDT 환산은 순익 차감에만 씁니다. |
| P0 | `fee_limit`은 호출자 Energy 예산 한도입니다. Bandwidth와 미래 단가·환율을 포함한 USDT 총비용 상한이 아닙니다. | `roundTripUpperBoundUsdt`를 현재 조건의 비용 시나리오로 바꾸고 실행 전·예치 후·회수 전 재견적을 명시했습니다. [TRON FeeLimit](https://developers.tron.network/docs/set-feelimit) |
| P0 | 비상예비액과 미래 지출액을 모두 ‘보호’하면서 지출액을 투자한다는 표현은 모순입니다. | 예비액은 보유, 미래 지출액은 명시적 출구 위험 확인이 있는 경우에만 조건부 후보로 평가합니다. 최소 1일 회수 완충을 프로젝트 정책으로 명시했습니다. |
| P1 | `triggerconstantcontract`의 `energy_used`만으로 성공을 증명할 수 없습니다. | HTTP/API 결과, TVM 결과, JustLend 반환 코드 0을 각각 확인하도록 했습니다. [TRON 모의 실행](https://developers.tron.network/reference/triggerconstantcontract), [JustLend SBM](https://docs.justlend.org/developers/supply_and_borrow_market/sbm/) |
| P1 | 현재 계정 Energy/Bandwidth를 승인·예치마다 독립적으로 무료 적용하면 비용을 낮게 셉니다. | 행동 순서대로 자원을 차감하고 미래 환매에는 현재 무료 자원을 적용하지 않도록 했습니다. [TRON 자원](https://developers.tron.network/docs/bandwidth-and-energy) |
| P1 | [`decidePlanSet()`](../shared/agent-decision.ts)은 단일 Plan만 보고 날짜별 배분을 판정하지 않으며, 전역 jUSDD 장애가 jUSDT 화면 상태에 섞일 수 있습니다. | 날짜별 결정·선택 경로 진단을 분리하고 에이전트 결정을 실제 배분에 연결하도록 했습니다. |
| P1 | [`Plan`/날짜별 구간 스키마](../shared/schemas.ts)에 비용 근거·만료 상태가 없고 [`session`](../src/lib/session.ts)은 구버전 계획을 저장합니다. | 새 계약·응답·세션 이행을 추가하고 오래된 기록은 미검증으로 표시하도록 했습니다. |
| P1 | [목표 감시](../src/features/review/monitor-read.ts)는 `/plans` 가상 경로와 에이전트 실잔액 경로가 다르며, 기존 포지션은 신규 USDT 진입과 다릅니다. | 두 경로의 라벨을 분리하고, 이미 예치한 경우 jUSDT 포지션·현재 환매 견적으로 재평가하도록 했습니다. |
| P1 | `markets(jUSDT).isListed`는 신규 공급 정책 전체를 증명하지 않습니다. | 공식 계약 목록의 `status == active`를 별도 게이트로 추가했습니다. [JustLend API](https://docs.justlend.org/developers/apis/) |
| P0 | 금액별 leg마다 승인비를 넣으면 공동 승인비가 중복되고, 묶음 금액에 따라 allowance 분기가 바뀝니다. | `JusdtLegQuote`와 `JusdtBundleQuote`를 분리하고 최종 선택 묶음만 공동 승인 0/1/2회를 갖게 했습니다. 선택 과정은 묶음 한계 순익을 매번 재계산합니다. |
| P0 | `allowance=0`에서 승인 모의 후 예치 모의, 잔여 allowance 부족에서 승인 초기화 후 재승인 모의는 **체인 상태가 이어지지 않아** 성공 비용 실측이 아닙니다. | 각 행동에 `account_simulation/reference_model/unknown`을 기록하고 후속 행동의 성공이 증명되지 않으면 확정 영수증 모델을 요구합니다. 모델이 없으면 왕복비용·순익 `null`/보류입니다. |
| P0 | 금액이 jUSDT 시장 이용률과 공급금리를 바꿀 수 있어 현재 APR을 모든 금액에 그대로 적용하면 금액별 수익 추정이 왜곡됩니다. | 현재 이자율 모델을 온체인 금리와 대조한 뒤 묶음 전액 예치 후 APR을 계산합니다. 둘 중 낮은 APR로만 현재 조건의 수익 시나리오를 만들며 모델 확인 실패 시 후보를 보류합니다. [JustLend 금리 모델](https://docs.justlend.org/developers/supply_and_borrow_market/interest_rate_model/) |
| P1 | 입력 100건에 금액별 RPC를 무제한 붙이면 현재 queue/rate gate가 포화됩니다. | 원본 지출은 전부 보존하고 평가당 최대 8버킷·40 RPC·동시 2·25초 정책으로 제한합니다. 나머지는 `quote_budget_exceeded`/보유입니다. |
| P1 | 구버전 확인 JSON·세션과 단일 `Plan` 추천은 새 위험 수용·날짜별 묶음 결정 근거를 담지 못합니다. | 요청 v1→v2 재확인, 세션 v2→v3 보존/미검증 이행, 별도 `datedDecision`과 선택 경로 데이터 상태를 계획에 고정했습니다. |
| P0 | `receipt.result=SUCCESS`인 JustLend 거래도 함수가 오류 코드를 반환했을 수 있습니다. | 확정 영수증의 jUSDT 반환 코드 `0`과 Mint/Redeem 이벤트 주소·금액, USDT approve의 `true`와 Approval 이벤트를 함께 요구합니다. 누락되면 표본을 버립니다. |
| P0 | 선택 묶음 금액이 바뀌면 approve 대상액·예치 후 금리·미래 환매액이 모두 달라집니다. 사전 leg 비용만으로는 순수 계산기가 이를 재견적할 수 없습니다. | context와 행동별 표본 집합을 입력 계약에 추가했습니다. 임의 묶음의 승인/환매 금액은 정확 일치 모의 결과 또는 목표의 0.5~2배인 확정 표본 5개 이상에서만 모델링하고, 범위 밖은 `unknown`입니다. |
| P1 | 공동 승인비 때문에 단독으로 음수인 두 구간이 합치면 양수가 될 수 있어 탐욕 선택이 후보를 누락합니다. | 최대 8버킷의 256개 부분집합을 순수 계산으로 전수 비교하고, 스트레스 순익/예상 순익/적은 원금/bucketKey 순으로 결정합니다. 공동비 분배값과 묶음 총액의 합치기도 검증합니다. |
| P1 | 20개 참조 표본에는 확정 영수증뿐 아니라 원거래 본문 확인도 필요할 수 있으며 사용자 평가의 25초 예산과 충돌합니다. | 모델 갱신을 직렬·저우선순위 별도 작업으로 두고 계약별 2페이지, 최대 20개 영수증+필요 시 20개 원거래 본문으로 제한했습니다. 갱신 중·실패하면 보류합니다. |

## 구현 중 먼저 확인할 외부 조건

1. 현재 TronGrid에서 지갑별 성공한 승인·예치 모의 실행과 `estimateenergy`를 어느 상태까지 지원하는지 확인합니다. 읽기 호출은 연속 상태를 만들지 않으므로 후속 행동은 개별 검증 또는 참조 모델로만 채웁니다. 지원되지 않는 단계는 `null`로 남깁니다.
2. SUN `/apiv2/price`가 Mainnet TRX와 USDT를 어떤 주소 표현으로 반환하는지 실제 응답의 주소·`last_updated`로 검증합니다. 확인 전 TRX→USDT 비용 환산을 계획 적격 근거로 쓰지 않습니다. [SUN 가격 API](https://docs.sun.io/api/get-price/)
3. 공식 jUSDT의 신규 공급 `active` 정책과 온체인 `isListed`를 모두 확인합니다. `getCash()`는 **현재** 현금이며 미래 지출일의 회수 용량이 아닙니다. [JustLend 배포 계약](https://docs.justlend.org/developers/deployed_contracts/), [출금](https://docs.justlend.org/getting_started/concepts/withdraw/)
4. 과거 **확정 성공 영수증** 모델의 계약·함수 반환 코드·이벤트·금액 범위·Energy/Bandwidth·시각과 당시/현재 구현 일치를 검증합니다. 현재 계정의 정확한 금액에 대한 성공 모의 결과가 없다면 필요한 행동마다 목표 금액 범위의 유효 표본 5개 이상이 있어야 하며, 부족하면 전체 왕복비용과 순익은 미확인입니다. [TRON 계약 거래 목록](https://developers.tron.network/reference/get-transaction-info-by-contract-address), [확정 영수증](https://developers.tron.network/re/reference/gettransactioninfobyid-1)
5. 이자율 모델 주소/ABI·현재 입력 대조·예치 후 금리 추정을 검증합니다. 모델 불일치는 현재 금리의 단순 연장으로 우회하지 않고 조건부 후보를 보류합니다.
6. 실제 Mainnet 지갑의 USDT, 수수료용 TRX, 기존 jUSDT 담보·차입 상태와 지급일 전 회수 여유를 관측합니다. 주소만 입력된 상태를 소유 증명이나 거래 권한으로 취급하지 않습니다.

## 이번 검증의 범위와 다음 게이트

- 현재 코드와 문서의 정적 대조, 공식 문서 확인, 계획 문서 수정까지 수행했습니다. Mainnet 거래·실제 소액 환매·무인 실행은 하지 않았습니다.
- 구현 시작 시 [계획의 W0–W5 작업 묶음](MAINNET_JUSDT_AMOUNT_QUOTE_PLAN.md#바로-착수할-작업-묶음과-순서)대로 계약→Mainnet 스키마 실증→비용→배분→평가·감시를 진행합니다. W1 외부 조회가 막혀도 W2의 `unknown`과 W3–W4의 보류 동작을 완성할 수 있습니다. **REST 독립성, TRX 가격, 이자율 모델, 과거 영수증, 지갑별 행동 비용**은 별도의 운용 후보 게이트입니다.
- 이후 [계획의 검증표](MAINNET_JUSDT_AMOUNT_QUOTE_PLAN.md#4-검증표와-완료-게이트)에 있는 모의 테스트, 타입 검사·빌드, 실제 읽기 전용 Mainnet 조회, 브라우저 경로 확인을 각각 기록합니다.
