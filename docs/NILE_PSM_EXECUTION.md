# Nile PSM 시험거래 구현·검증 계획

## 범위와 우선순위

사용자님 요청에 따라 Mainnet 거래 실행은 이 작업에서 제외합니다. Nile의 PSM USDD↔USDT 왕복을 기존 TRX↔jTRX 시연과 별도 흐름으로 구현합니다. PSM USDD와 Nile jUSDD 기초자산의 동일성이 확인되지 않았으므로 PSM 출력을 jUSDD에 자동 예치하지 않습니다.

1. **읽기 근거:** PSM·GemJoin·USDT·USDD·Vat 계약의 코드와 연결 주소·소수 자릿수, 활성 상태, 수수료율, 양방향 용량, 지갑 잔고·허용액을 Nile에서 조회합니다. 공식 후보 주소와 실제 계약 연결이 다르면 거래를 중단합니다.
2. **금액·비용 미리보기:** `buyGem`은 정확한 USDT 수령량과 필요한 USDD를, `sellGem`은 정확한 USDT 지출량과 예상 USDD 수령량을 원시 정수로 계산합니다. 승인·교환을 각각 재조회하고 Energy/Bandwidth와 TRX 수수료 상한을 표시합니다. 비용을 확인할 수 없으면 서명 가능으로 표시하지 않습니다.
3. **서명·기록:** 같은 Nile 지갑의 메시지 인증과 단계별 사용자 확인을 요구합니다. `approve(USDD→PSM) → buyGem(USDD→USDT) → approve(USDT→GemJoin) → sellGem(USDT→USDD)` 순서로 각 거래를 별도 예약합니다. 서명 원문과 txID를 암호화 원장에 저장한 후 원문 일치를 확인해 방송합니다. 미해결 거래가 있으면 다음 단계를 막고 복구 조회를 우선합니다.
4. **확정 검증:** 방송 응답만으로 완료 처리하지 않습니다. Nile solidified 영수증의 성공 여부와 단계 후 잔고·허용액을 다시 조회합니다. 사용자 확인 없이 다음 거래를 자동 서명하지 않습니다.
5. **최종 점검:** 계산·서명 경계의 집중 테스트, 타입 검사, 빌드, 연결 진단을 진행합니다. 실제 Nile 거래 증거는 토큰 입금, TronLink 사용자 서명, solidified 영수증이 모두 있어야만 별도로 통과 판정합니다.

## 중단 조건과 한계

- PSM이 사용하는 USDD 계약의 실제 잔고가 0이거나, 입력 잔고·용량·허용액·수수료 재원이 부족하면 해당 단계는 실행하지 않습니다.
- Nile 지갑 화면의 달러 합계는 TRX 가치가 포함될 수 있으므로 USDD 잔고로 해석하지 않습니다.
- PSM 금리 상품이나 수익 전략은 아닙니다. 교환 수수료와 TRX 네트워크 비용을 포함하면 왕복 수량은 감소할 수 있습니다.
- 실거래 성공 판정은 코드·모의 테스트와 구별해 txID, solidified 상태, 사후 잔고를 기록한 뒤에만 합니다.

## 2026-09-30 실제 Nile 읽기 근거

| 확인 항목 | 관측값 |
| --- | --- |
| 시험 지갑 | `TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu` |
| PSM 입력 USDD | `TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt` · 잔고 **0** |
| PSM 입력 USDT | `TZDnq7egPqzi7H4SXy1ABvwaVRvRTaVfJW` · 잔고 **0** |
| 지갑에 들어온 별도 USDD | `TFT7sNiNDGZcqL7z7dwXUPpxrx1Ewk8iGL` · **2,000 USDD** |
| 별도 USDD 입금 | txID `a75fa2ec1110c5b669df13812673a302e6c5a2d736aa98e75c34827a56d690b7`, Nile 블록 71,399,984, solidified `SUCCESS` |
| 실제 PSM 읽기 | PSM/GemJoin/Vat/토큰 연결 일치, 양방향 활성, `tin` 0.12%, `tout` 0.2%; 1 USDT를 사는 데 1.002 USDD 필요(조회 시점 값) |
| 잔고 API 재조회 | 2026-09-30 09:18:09 KST · PSM USDD/USDT 모두 0, 수수료용 TRX 984.6537 |

화면의 녹색 USDD 0과 회색 USDD 2,000은 **동명이지만 다른 계약**입니다. [USDD 팀의 Nile PSM 후보 주소](https://github.com/decentralized-usd/mcp-server-usdd/blob/master/src/core/chains.ts)와 실제 `PSM.usdd()`를 대조했습니다. 회색 토큰을 PSM에 승인하거나 교환하지 않습니다. [Nile 공개 faucet](https://nileex.io/join/getJoinPage)의 USDT도 PSM 입력 USDT와 계약 주소가 다릅니다. 공식 공개 자료에서 이 PSM 전용 토큰을 받는 faucet이나 두 USDD 사이의 Nile Migration 경로는 확인하지 못했습니다. 이 지갑만으로 Vault를 통한 신규 USDD 발행도 최소 부채 조건을 충족하지 못합니다.

현재 `/api/nile/psm/balance`의 실제 조회는 성공했고, 1 USDT `approve_usdd` 미리보기는 잔고 부족으로 HTTP 409에 중단됐습니다. 이는 **차단 동작의 검증**이며 승인·전환 거래의 실증은 아닙니다. 정확한 PSM용 시험 USDD 또는 USDT를 확보한 뒤 단계별 TronLink 사용자 서명과 확정 영수증을 별도로 검증해야 합니다.
