# GWDC-TronB ZIP 기능 연동 범위

업로드된 `GWDC-TronB-main.zip`의 기능은 현재 프로젝트의 Mainnet 읽기 전용 경로에 맞춰 선택적으로 옮겼습니다. ZIP 내부 문서는 구현 참고 자료이며, 이 프로젝트의 실행 권한이나 검증 결과로 취급하지 않습니다.
PSM의 진입·출구 수수료 산식은 [USDD 공식 PSM 계약 소스](https://github.com/decentralized-usd/psm/blob/main/src/psm.sol)의 `sellGem`·`buyGem`을 기준으로 확인했습니다.

| 우선순위 | 기능 | 현재 연결 | 판단 |
| --- | --- | --- | --- |
| 1 | PSM 양방향 용량 | `server/data/usdd.ts`에서 PSM↔GemJoin↔Vat 연결, 토큰 주소·단위, `Vat.ilks`와 전역 `Line/debt`, GemJoin USDT 잔고를 읽습니다. `shared/psm-capacity.ts`가 6자리 USDT 단위로 계산합니다. | ZIP의 `line - Art×rate`만 쓰면 전역 부채 한도를 놓칠 수 있어 둘 중 작은 여유를 적용했습니다. |
| 2 | jUSDT/jUSDD·보유 날짜별 비교 | 기존 `shared/planning.ts`의 지출일 보호 및 용량 합산 계산을 `/plans`의 `PlanExplorer`에 연결했습니다. PSM 전환율은 `sellGem: 1−tin`, `buyGem: 1/(1+tout)`을 적용합니다. | ZIP의 혼합 배분 코드는 출금 원금과 이자 불일치, 미확인 PSM 용량 허용 문제가 있어 복사하지 않았습니다. 현재 계산기는 날짜별 경로를 비교하지만 한 날짜의 금액을 여러 상품으로 쪼개지는 않습니다. |
| 3 | USDT↔TRX 자금 경로 | `server/data/swap-pool.ts`가 SunSwap 후보 라우터의 팩토리·페어·토큰·단위·잔고를 검증하고, `/api/funding`이 보호액을 제외한 금액만 `shared/swap-funding.ts`에 전달합니다. | 수수료 0.3%는 검증된 풀 수수료가 아닌 가정입니다. 즉시 왕복 수학 예시만 표시합니다. |
| 4 | Stake 2.0 | 기존 `server/data/alternatives.ts`의 해제 대기 기간과 투표 상태 읽기를 자금 경로 화면에 연결했습니다. | SR 보상 APR, 미래 USDT 회수, 거래비용이 없어 순익·추천은 계산하지 않습니다. |

## 적용 경계

- `/plans`의 고정 5% 예시는 가상 계산이고, 아래 상품 비교는 조회 시점의 원천 데이터입니다. 지갑 기반 금액별 비용 검증은 별도 에이전트 평가 경로에서 수행합니다.
- PSM 용량은 조회 시점의 상한일 뿐 실제 체결 보장이 아닙니다. 비용이 확인되지 않으면 jUSDD 경로의 순익과 실행 적격성을 확정하지 않습니다.
- SunSwap 풀 잔고와 현재 가격으로 미래 스테이킹 출구 가격을 확정할 수 없습니다. Mainnet 거래 기능은 추가하지 않았습니다.
- 실시간 Mainnet/Nile 응답은 해당 RPC와 JustLend 원천이 연결되는 환경에서 다시 확인해야 합니다.

## 2026-09-30 검증 기록

- `./scripts/run run test`: 60개 파일, 421개 테스트 통과. `./scripts/run run build`: 타입 검사와 Vite 빌드 통과.
- `./scripts/run run doctor`: Mainnet PSM·jUSDD 토큰 연결과 양방향 용량 조회가 성공했습니다. 진입·출구 거래 자체는 Energy/Bandwidth 비용이 없어 `unknown`으로 유지됩니다.
- `getcontract`가 ABI와 코드 해시는 반환하지만 배포 바이트코드를 생략하는 USDD 계약은 공식 `getcontractinfo`의 런타임 코드와 계약 주소를 확인하도록 보완했습니다. 관련 회귀 테스트는 `tests/tron-contract-runtime.test.ts`에 있습니다.
- 로컬 `/api/plans`와 `/api/funding`의 실제 읽기 호출이 HTTP 200으로 응답했고, `/plans` 브라우저 화면에서 보호액 분리, PSM 진단, 풀 잔고 기반 즉시 왕복 예시를 확인했습니다. 브라우저 콘솔 오류는 없었습니다.
- 조회 시점 PSM 진입·출구 용량과 SunSwap 풀 잔고는 변동합니다. 왕복 거래 비용이 미확인인 동안 날짜별 배분은 보유 또는 검증 자료 부족으로 표시되고 Mainnet 거래는 진행하지 않습니다.

## 남은 실행 전 검증 순서

1. jUSDD의 REST 금리와 현금 수치 대신 온체인 `supplyRatePerBlock()`·`getCash()`와 최신 블록 시각을 사용합니다. 이 경로는 `server/data/quotes.ts`에 적용했습니다. 블록당 금리는 3초 블록 가정의 연간 10,512,000블록을 곱한 APR이며, 미래 금리를 보장하지 않습니다.
2. 공개 지갑 주소와 금액이 정해지면 해당 계정의 USDT·USDD 잔액, TRX와 Energy/Bandwidth, 각 allowance를 읽습니다. USDT→USDD에는 USDT의 GemJoin 승인과 `sellGem`, 예치에는 USDD의 jUSDD 승인이 필요합니다. 회수에는 jUSDD 인출, USDD의 PSM 승인, `buyGem`이 필요합니다. 기존 승인 상태에 따라 승인 초기화 거래도 추가될 수 있습니다.
3. 각 거래의 읽기 전용 시뮬레이션과 `estimateenergy`, 현재 체인 수수료, 예상 서명 거래 크기로 비용을 계산합니다. 현재 상태에서 아직 보유하지 않은 jUSDD의 미래 인출은 성공 시뮬레이션이 불가능할 수 있으므로 과거 실측값이나 상한 시나리오는 참고값으로만 분리합니다. 모든 거래의 근거가 갖춰지기 전에는 `roundTripCost`·`netYield`를 확정하지 않습니다.
4. 실제 거래를 별도로 승인받아 진행하는 경우 매 단계 직전에 PSM 용량·수수료·시장 현금·계정 자원·예상 비용을 다시 읽고, 단계별 확정 영수증과 잔고를 확인합니다. 미래 회수 비용은 회수 시점에 재평가합니다.
