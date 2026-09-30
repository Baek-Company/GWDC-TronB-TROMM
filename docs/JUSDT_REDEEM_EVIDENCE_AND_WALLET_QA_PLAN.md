# jUSDT 환매 근거 확보·실지갑 읽기 전용 검증 계획

작성일: 2026-09-29  
대상: `TeamBaek/LeeMir`의 Mainnet USDT → JustLend jUSDT 날짜별 계획  
작업 성격: **읽기·계산·화면 검증만**. Mainnet 서명, 방송, 자동 거래의 활성화 계획이 아닙니다.

## 1. 목표와 현재 기준선

이 문서는 [금액별 견적 W0–W5](MAINNET_JUSDT_AMOUNT_QUOTE_PLAN.md) 이후의 두 작업을 실행 순서로 정의합니다.

1. 미래 `redeemUnderlying(uint256)`의 비용을 **검증 가능한 근거**로 모델링할 방법을 판정하고, 가능할 때만 기존 계산기에 연결합니다.
2. 실제 TronLink Mainnet 주소의 서로 다른 두 금액·두 지급일에 대해, 앱의 읽기 전용 평가를 끝까지 재현하고 결과·보류 사유를 화면에서 확인합니다.

현재 [구현 상태](IMPLEMENTATION_STATUS.md)의 기준선은 35개 파일·281개 테스트와 빌드 통과, 모의 200/800 USDT 평가의 Mainnet RPC 39회(상한 40회)입니다. 이 수치는 **실지갑 검증 결과가 아닙니다.** `server/data/jusdt-costs.ts`는 아직 `redeemModels: []`를 반환합니다. 환매 비용과 왕복 순익은 `unknown`/`null`이고 신규 예치 후보는 보류됩니다. `mainnetExecution:false`와 금액별 배분의 `executionEligible:false`를 유지합니다.

JustLend의 `redeemUnderlying` 인자는 기초자산인 USDT의 6자리 최소 단위이고, jToken 잔액은 8자리 단위입니다. 프록시인 CErc20Delegator 뒤 구현 주소가 바뀔 수 있습니다. [JustLend 출금 단위](https://docs.justlend.org/developers/common_pitfalls/), [JustLend 배포 구조](https://docs.justlend.org/developers/deployed_contracts/)

## 2. 두 작업의 공통 불변식

- **지급일 우선:** 비상예비액과 위험 수용을 하지 않은 예정 지출은 보유합니다. 7일 지출액 200 USDT를 예치 후보로 시험하려면 사용자의 별도 `acceptsDatedExpenseLiquidityRisk=true` 확인이 필요합니다. 확인이 없으면 200은 보유, 나머지 800만 견적 대상입니다. 확인이 있어도 지급일 전 회수는 보장되지 않습니다.
- **자료 구분:** 실제 주소·실잔액·현재 시장 읽기, 현재 계정 모의 실행, 과거 확정 거래 모델, 예시 데이터를 서로 다른 근거로 표시합니다. 모델의 현재 비용 시나리오를 미래 실비용 상한으로 표시하지 않습니다.
- **실행 차단:** 이 작업의 모든 API와 UI는 서명·방송을 요청하지 않습니다. 주소 조회는 소유권이나 거래 승인 증거가 아닙니다. 계정·네트워크 전환, 미확인 비용, 만료, 429, 시간 초과에는 `hold` 또는 `insufficient_data`입니다.
- **조회 예산:** 사용자 평가의 Mainnet RPC 40회·25초·동시 2회와 8개 견적 버킷 제한을 보존합니다. 참조 거래 수집은 별도 저우선순위·유한 조회 작업으로 분리하고 동일한 전역 RPC 대기열·429 중단 정책을 사용합니다. 병렬 수집으로 평가를 굶기지 않습니다.
- **비밀·개인정보:** API 키는 서버의 무시된 `.env.local`만 사용합니다. 지갑 개인키·복구 구문을 받지 않고, 저장소의 검증 기록에는 전체 지갑 주소·잔액·원시 응답·키를 넣지 않습니다. 로컬 화면에서 주소와 잔액을 확인하되 공유 기록은 주소 축약값과 상태·호출 수·시각·차단 사유만 남깁니다.

## 3. 작업 A — 미래 환매 비용 근거

### A0. 증거 확보 가능성 판정

**수정 전 조사·PoC:** jUSDT delegator의 현재 구현 포인터를 체인에서 읽는 지원 방법과 실제 구현 코드 해시를 확인합니다. 공식 계약 목록의 구현 주소는 대조에 쓰되 단독 온체인 증명으로 쓰지 않습니다. 과거 후보 거래의 **실행 직전 시점** 구현 포인터·코드 해시를 독립적으로 검증할 수 있는 역사 상태 출처가 있는지 조사합니다. 같은 블록에 구현 변경 거래가 있으면 블록 끝 상태만으로 해당 환매 거래의 구현을 판정할 수 없습니다. 일반 TRON `eth_getCode`·`eth_getStorageAt`은 `latest`만 지원하고, 과거 블록 객체를 받는 `eth_call`도 최신 상태에서 실행하므로 이 API들만으로 과거 구현을 복원할 수 없습니다. [TRON eth_getCode](https://developers.tron.network/reference/eth_getcode), [eth_getStorageAt](https://developers.tron.network/reference/eth_getstorageat), [eth_call](https://developers.tron.network/reference/eth_call)

허용되는 증거 경로는 다음 중 하나입니다.

| 경로 | 필요한 확인 | 판정 |
| --- | --- | --- |
| 과거 상태 재생/검증 가능한 아카이브 | 후보 거래의 블록 ID·거래 순서에서 **실행 직전** 구현 주소·런타임 코드 해시, 현재 구현 주소·해시, 재현 가능한 상태 증명 | 두 실행 시점의 구현 주소와 코드 해시가 모두 같을 때만 해당 거래 채택 |
| **지금부터** 연속 관측 | 시작 확정 블록의 구현 주소·코드 해시를 고정하고 이후 확정 블록의 모든 구현 변경 경로와 거래 순서를 누락 없이 추적할 수 있음 | 관측 시작 후 발생한 거래만 채택. 블록 공백·재시작 중 누락·미확인 저장소 쓰기 경로·코드 변경 시 해당 구간 폐기 |
| 현재 jUSDT 보유 계정의 환매 모의 | 같은 계정·현재 포지션·현재 시장 현금에서 해당 금액의 성공 모의 결과 | **현재 회수 검토**에만 사용. 신규 예치 전 미래 환매 표본으로 승격 금지 |

TronGrid 이벤트 검색은 후보 발견용 인덱스이며, 검색 결과가 없다는 것만으로 구현 변경 부재를 증명하지 않습니다. 본문과 확정 영수증은 다른 자료입니다. [TRON 이벤트 조회](https://developers.tron.network/reference/get-events-by-contract-address), [확정 영수증](https://developers.tron.network/reference/gettransactioninfobyid-1), [확정 의미](https://developers.tron.network/docs/confirmation-semantics)

연속 관측 경로를 택한다면 앱 브라우저를 닫아도 작동하는 별도 읽기 수집기, 마지막 확정 블록과 거래 순서의 **지속 저장**, 재시작 시 누락 구간 재생이 먼저 필요합니다. 전 범위를 복원할 자료나 운영 환경이 없으면 이 경로는 `evidence_unavailable`입니다.

**A0 완료 기준:** 선택한 경로의 소스·검증 절차·재현 가능한 예시 1건과 누락 감지 방법을 기록합니다. 어느 경로도 충족하지 못하면 `evidence_unavailable`로 A1–A2를 보류하고, 기존 `redeemModels: []`와 신규 예치 보류를 유지합니다. 과거 delegator 바이트코드 해시를 구현 코드 해시로 대체하지 않습니다.

**실행 결과 (2026-09-29):** 현재 Mainnet jUSDT `implementation()`은 공식 배포 목록과 일치하고, delegator와 implementation의 현재 코드는 읽힙니다. 그러나 과거 높이의 `eth_getCode`와 `eth_getStorageAt`은 각각 `-32602`이며, 과거 블록 객체의 `eth_call`은 최신 호출과 같은 현재 상태 결과를 냅니다. 거래 실행 직전 구현 주소·코드 해시의 독립 증명이나 누락 없는 관측 체크포인트를 확보하지 못했습니다. A0는 현재 RPC 경로에서 **`evidence_unavailable`**, A1–A2는 **증거 게이트 대기**입니다. 재현 절차와 판정의 한계는 [환매 근거 게이트](JUSDT_REFERENCE_EVIDENCE_GATE.md)에 기록했습니다. B0–B2는 이 결과와 독립적으로 읽기 전용 구현·시험을 진행할 수 있습니다.

### A1. 별도 확정 거래 수집기와 증거 계약

A0를 통과했을 때만 다음 코드를 구현합니다.

| 파일 | 변경 내용 |
| --- | --- |
| `server/data/jusdt-reference-model.ts` | 기존 `verifyReferenceCandidate`·`buildReferenceModel`의 5개 서로 다른 txID, 30일 이내, 원 거래 본문/서명 크기, solidified `SUCCESS`, 함수 반환 코드 0, `Redeem` 이벤트·USDT 원시 금액 검사를 재사용합니다. `historicalCodeIdentity`를 단순 문자열 주입만으로 신뢰하지 않고 아래 증명 객체의 검증 결과에 묶습니다. |
| `server/data/jusdt-reference-collector.ts` **신규** | 후보 txID를 제한된 페이지에서 찾고 `/walletsolidity/gettransactionbyid`와 `/walletsolidity/gettransactioninfobyid`를 대조합니다. 블록 ID·거래 순서의 구현 증명을 붙인 뒤 검증기로 전달합니다. 후보 부족, 페이지 누락, HTTP 429, 확정 전, 반환 코드·이벤트 불일치, 증명 공백은 각기 실패 이유로 기록합니다. |
| `shared/schemas.ts` | 증거에 `chain`, delegator/implementation 주소와 코드 해시, 거래 블록, 검증 경로·범위, 유효기간, 표본 txID를 결속하는 계약을 추가합니다. 증명 미확인 상태는 모델로 파싱되지 않게 합니다. |
| `server/data/tron-rpc.ts` 또는 기존 read gate | 이미 허용된 읽기 엔드포인트·전역 큐를 재사용하고, 필요한 외부 목록 조회만 서버에서 제한합니다. 사용자 평가 40회 밖의 직렬 갱신이며 무제한 백필·무제한 재시도를 하지 않습니다. |

연속 관측이 선택되면 `server/data/jusdt-implementation-history.ts`와 로컬 지속 체크포인트 저장도 구현합니다. 확정 블록 ID·마지막 거래 순서·구현 주소/해시를 원자적으로 기록하고, 재시작 시 마지막 구간을 재검증합니다. 파일 유실·공백은 모델 폐기이며 “변경 없음”의 근거가 아닙니다. 아카이브 경로가 선택되면 해당 어댑터가 거래 직전 상태 증명의 검증을 담당합니다.

참조 집합은 행동·계약·실제 **구현**·선택자별로 분리합니다. 목표 환매액의 0.5–2배 구간에서 **성공한 서로 다른 거래 5개 이상**이어야 하며, 최대 20개 검증 표본·30일 경과 제한·10분 모델 만료를 유지합니다. 후보 목록은 계약당 최대 2페이지, 영수증 최대 20건, 목록에 본문이 없으면 별도 본문 최대 20건으로 제한합니다. 역사 상태 증명 비용은 PoC에서 별도 측정하고 이 제한에 맞지 않으면 수집을 중단합니다. 200/800 USDT의 목표 환매액은 날짜별 예상 이자 계산 뒤 정해지므로 두 액수에 대해 각각 표본 적용 범위를 확인합니다. 만료 모델은 연장하지 않고 다시 수집합니다. 코드/구현 변경이 관측되면 기존 모델은 즉시 적격에서 제외합니다.

### A2. 기존 견적·판정 연결

`server/data/jusdt-costs.ts`의 `readJusdtSizing()`에 검증된 모델 읽기 의존성을 주입해 `redeemModels`를 채웁니다. 증명 실패 또는 모델 부재에는 지금처럼 빈 배열을 반환합니다. `shared/jusdt-cost-model.ts`가 각 **최종 예상 환매 원시 금액**에 표본 범위를 적용하도록 유지하고, `shared/jusdt-allocation.ts`에서 공동 승인 1회, 금액별 예치·환매, Energy/Bandwidth, 수수료용 TRX, 현재 `getCash()`와 스트레스 순익을 다시 계산합니다. 모델은 `reference_model` 및 `current_conditions_scenario`로만 표시하고 `executionEligible:false`를 유지합니다.

참조 모델 갱신으로 사용자 평가에 RPC 호출이 추가되면 안 됩니다. 40회 예산이 깨지면 수집을 평가 경로에서 떼어내고 갱신 중에는 보류합니다. 참조 모델이 준비돼도 **승인·예치·가격·시장·지갑·출구·TRX 재원** 중 하나가 미확인이거나 예상/스트레스 순익이 0 이하이면 조건부 후보를 만들지 않습니다.

### A3. 검증

- `tests/jusdt-reference-model.test.ts`와 수집기 테스트: 실제 API 스키마를 반영한 고정 fixture로 성공 5건, 중복/4건, 금액 범위 밖, 잘못된 선택자·반환값·이벤트, 미확정/실패 영수증, 서명 크기 오류, 현재/과거 구현 불일치, 관측 공백, 만료·업그레이드를 각각 확인합니다. 모의 fixture 통과를 실제 체인 증거 확보로 표기하지 않습니다.
- `tests/jusdt-costs.test.ts`, `tests/jusdt-allocation.test.ts`, `tests/agent-assessment.test.ts`: 200/800 각각의 환매 적용 범위, 공동 승인 한 번, 비용 합산과 `unknown` 전파, 수수료용 TRX 부족·현재 현금 부족·순익 0 이하를 검증합니다.
- 외부 읽기 결과는 [환매 근거 게이트](JUSDT_REFERENCE_EVIDENCE_GATE.md)에 증거 경로·검증 시각·표본 건수·막힌 단계만 기록합니다. **A 통과:** 두 목표 환매액에 유효한 표본과 구현 동일성 증거가 있고, 선택 묶음이 현재 조건 시나리오로 재계산됩니다. 모델이 없어도 정확한 보류가 구현된 상태는 `code_complete/evidence_blocked`로 기록합니다.

## 4. 작업 B — 실제 TronLink 주소의 두 금액 읽기 전용 검증

### B0. 보류 상태의 부분 견적 노출

현재 `readJusdtSizing()`가 두 `JusdtLegQuote`를 만들어도 `redeemModels: []`이면 선택 묶음이 없고, `Assessment.datedAllocation`의 보유 구간은 금액별 `sizedQuoteVersion`을 노출하지 않습니다. 화면에는 주로 일반적인 왕복 비용 보류가 보입니다. 실지갑에서 무엇을 읽었고 무엇이 비었는지 검증하려면 먼저 이 표시 공백을 메웁니다.

| 파일 | 최소 변경 |
| --- | --- |
| `shared/schemas.ts` | **진단용** 읽기 전용 구간 근거 계약: `bucketKey`, 금액 원시 단위, 지급/회수 목표일, context·시장·leg 버전, 만료, 진입 비용 상태, 환매 모델 상태, 보류 이유. `null`을 0으로 변환하지 않습니다. |
| `server/agent/assessment.ts` | 이미 얻은 sizing의 안전한 투영값을 `Assessment`에 별도 필드로 담습니다. 선택된 배분·추천과 분리하고, 지갑/체인/입력 버전이 바뀌면 제거합니다. `ready`는 **읽기 성공**이지 왕복 견적 완료가 아님을 응답에 명시합니다. |
| `src/features/agent/AgentPanel.tsx` | `/needs`에서 선택 묶음이 없어도 200/800 각 구간의 현재 진입 근거, 미확인 환매, 만료·출처, 공동 승인 분기를 표시합니다. 부분 견적을 투자 금액·순익·추천으로 오인할 수 없게 `보유/자료 부족`과 `거래 권한 없음`을 유지합니다. |
| `tests/agent-assessment.test.ts`, `tests/conversation-ui.test.ts` | 환매 부재 시 두 구간 부분 근거가 응답/화면에 남지만 선택 배분·순익·거래 권한은 생기지 않는지 확인합니다. 계정/체인 변경 시 이전 근거가 보이지 않는지도 검사합니다. |

### B1. 모의 통합·안전 차단 재검증

기존 `tests/jusdt-assessment-budget.test.ts`의 200/800 기준을 확장해 실제 API 응답 모양과 화면의 두 행을 검사합니다. 40 RPC·25초 상한, 선택 경로의 JustLend 조회와 PSM 장애 분리, 승인 상태 0/충분/부분, jUSDT 기존 포지션, USDT 부족, TRX 부족, 가격·시장·근거 만료, 429를 확인합니다. 요청 경로에 서명·방송이 없고 `/api/capabilities.mainnetExecution === false`이며 모든 결과의 `executionEligible === false`인지 검사합니다.

### B2. 실제 지갑 재현 절차

실행 환경은 **TronLink 확장이 있는 Chrome**과 로컬 앱입니다. `/connections`에서 Mainnet 계정 연결을 승인한 다음 `/needs`에서 사용자님이 직접 확인한 입력 JSON을 사용합니다. [TronLink 연결·계정/체인 이벤트](https://docs.tronlink.org/dapp/getting-started/)

1. 시험 시나리오: 서울 날짜 기준 시작일 오늘, 종료일 30일 뒤, 7일 뒤 200 USDT 예정 지출, 예비액 0, 보유액 1,000 USDT를 **예시**로 만듭니다. 두 금액을 모두 견적하려면 예정 지출 운용 위험 확인을 명시적으로 켭니다. 기본값이면 200 USDT는 정상적으로 보유됩니다.
2. 실제 지갑에 이 금액이 없다면 1,000 USDT로 가장하지 않습니다. 두 양수 구간의 합이 **진술액과 관측 USDT 잔액 이하**인 별도 시험 입력을 만들고, 수수료용 TRX와 기존 jUSDT 포지션도 관측합니다. 기존 jUSDT가 0이 아니면 현재의 신규 예치 모델은 보류가 맞습니다. 자금·지갑이 준비되지 않으면 B2 상태는 `not_run`입니다.
3. 주소·Mainnet·확인 버전이 일치하는 상태에서 평가를 한 번 요청합니다. `assessmentId`, 조회 시각, USDT 실잔액 상한, 두 `bucketKey`/금액/버전/만료, 승인 분기, 예치·환매 근거, `selectedRouteDataMode`, 보류 이유, 호출 수를 대조합니다. 블록 범위는 동시 스냅샷이 아니라 관측 구간으로 기록합니다.
4. 같은 화면에서 새로고침·지갑 계정 변경·Nile 전환·자료 만료를 재현합니다. 이전 구간 근거가 재사용되지 않고 지갑 재연결/재평가를 요구해야 합니다. 개발자 도구 네트워크 기록에서 서명·방송 요청이 0건인지 확인합니다. 키나 전체 주소를 캡처/문서에 남기지 않습니다.
5. [구현 상태](IMPLEMENTATION_STATUS.md)에 **실지갑 읽기 결과만** 기록합니다: 실행 여부, 두 금액의 부분/완전 상태, 보류 코드, RPC 상한, 원천 시각, 코드 버전. 실잔액·주소·키·원시 응답은 기록하지 않습니다. A가 미완료이면 “진입 근거 일부 확인, 미래 환매 근거 없음, 신규 예치 보류”가 정상 결과입니다.

**B 통과:** 실제 지갑에서 두 서로 다른 금액의 현재 읽기·진입 근거 또는 정확한 개별 미확인 사유가 API와 UI에 일치하고, 계정/체인 전환·만료 후 근거가 무효화되며, 서명·방송 0건과 40 RPC·25초 제한을 확인합니다. 이는 **읽기 전용 관측 합격**입니다. A 통과 및 다른 모든 적격 조건이 있어야만 `conditional_allocate`를 별도로 판정할 수 있고, 그때도 거래 허가는 아닙니다.

## 5. 착수 순서와 최종 판정표

| 순서 | 작업 | 의존성 | 결과 기록 |
| --- | --- | --- | --- |
| 1 | A0 역사 구현 증명 PoC와 증거 경로 판정 | 공식 원천·실제 읽기 | `available`/`evidence_unavailable` 및 재현법 |
| 2 | B0 부분 근거 응답·화면 + B1 모의 안전 시험 | 기존 W0–W5 | 코드·테스트 합격. A0 실패여도 진행 |
| 3 | A1 수집기·A2 비용 연결·A3 테스트 | **A0 증명 경로 통과** | 금액별 5건·구현 동일성·모델 버전 또는 보류 |
| 4 | B2 실제 TronLink 두 금액 읽기 검증 | Chrome 지갑, Mainnet 주소, 관측 가능 자산, 로컬 서버 | `pass`/`blocked`/`not_run`과 비밀 없는 결과 |
| 5 | `./scripts/run run check`, `./scripts/run run doctor`, `/needs` 브라우저 QA | 위 변경 | 테스트/빌드/외부 읽기/실지갑 결과를 따로 기록 |

| 상황 | 사용자에게 보일 판정 |
| --- | --- |
| 역사 구현 증명이 없거나 유효 환매 표본이 부족함 | 금액별 **부분 견적**, 왕복 순익 `미확인`, 신규 예치 `보류` |
| 실제 지갑이 없거나 잔액·TRX·시장·가격·시간 근거 부족 | **관측 부족**, 진술액 기반 예시는 실운용 후보 0 |
| 두 금액의 유효 환매 모델과 나머지 적격 근거가 모두 있음 | 현재 조건의 **읽기 전용 조건부 비교**. 지급일 출금·미래 비용·실거래 성공 보장 없음 |

이 계획의 완료와 [무인 실행 검증 계획](UNATTENDED_EXECUTION_VERIFICATION_PLAN.md)의 Mainnet 실행 게이트는 별개입니다. 실제 거래는 각 단계의 지갑 승인·원 txID·확정 영수증·포지션 재조회와 별도 보안/운영 심사가 필요합니다.
