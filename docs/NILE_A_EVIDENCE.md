# Nile 승인형 A 실증 기록

2026-09-29 22:37 UTC 기준 Nile 승인형 A의 예치·환매 왕복을 실증했습니다. 테스트넷 TRX와 jTRX만 대상으로 하며 Mainnet USDT 실거래나 무인 실행의 증거로 사용하지 않습니다. 판정 기준은 [무인 실행 추가 검증 계획](UNATTENDED_EXECUTION_VERIFICATION_PLAN.md)의 3·4절입니다.

## 사전 게이트

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| C-01~07 모의/장애 검증 | pass **(Nile 승인형 A 모의 범위만)** | `nile-a-client-gates.test.ts`, `approval-plan.test.ts`, `execution.test.ts`, `approval-gates.test.ts`, `approval-service.test.ts`, `agent-coordinator.test.ts`, `nile-approval-recovery.test.ts`, `approval-api.test.ts` 및 [C 항목별 판정](UNATTENDED_EXECUTION_VERIFICATION_PLAN.md#nile-a-진입-전-c-항목의-모의-검증-현황-2026-09-30). 추가 실제 HTTP 장애 주입 `./scripts/run run test -- tests/approval-c03-gate.test.ts` 1/1, 두 클라이언트·서버 재시작 `./scripts/run run test -- tests/approval-http-restart-gate.test.ts` 1/1 통과(2026-09-30). 이는 모의 RPC의 코드 시험 결과이며 실제 Nile 거래·TronLink 확인은 아래 별도 게이트 |
| 전용 Nile 지갑·체인 확인 | pass **(Nile A 범위)** | 사용자님은 `TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu`가 시험 전용이라고 확인. Chrome에서 Nile 연결을 표시했고, 같은 주소의 Nile RPC 읽기·TronLink 서명·원장 계정 및 거래 서명자 일치를 확인. 다른 체인이나 지갑에 대한 검증은 아님 |
| 승인 원장 준비 | pass | 로컬 `/api/health`에서 `nileApprovalLedgerReady: true` 재확인(2026-09-29 22:05 UTC). 읽기 전용 원장 확인(22:06 UTC) 시 의도·이벤트 0건. 승인 원장 키 값은 기록하지 않음 |
| 실행 금액·상한 | pass **(별도 승인 2건)** | 사용자님이 Nile 1 TRX 예치와 전체 89.46435499 jTRX 환매를 각각 직접 승인. 예치 미리보기 최대 17.419 TRX·실제 수수료 8.0894 TRX, 환매 미리보기 최대 16.5872 TRX·실제 수수료 7.2569 TRX(모두 시험 TRX) |

## 예치

| 증거 | 값 |
| --- | --- |
| 상태 | `confirmed` — 아래 영수증과 같은 포지션 jTRX 증가 확인 |
| 계획 ID·확인 입력 버전·서버 의도 ID | 계획 `nile:justlend_jtrx:80_20:v2:8090210b0cd3b263cda563383a483c86a0cf8ad6caac911dbabbfc0aa9daf313`, 확인 입력 버전 5, 서버 의도 `b5d469b260f9eb3ed9463e25fcda7b9a1e315ef36ebdc2889dfdeaf689b939ab` |
| Nile 주소·jTRX 계약·코드 해시 | `TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu`; `TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq`; 예치 전 조회 계약 코드 SHA-256 `6b3da37d86037844d5a565c1237f22c9033ce8b9a6877091eb85599cb86b8dc5` |
| 예치 전 jTRX 원시 잔고·RPC 관측 시각 | `0`; Nile RPC `live`, 2026-09-29T22:05:47.962Z. 같은 주소의 시험 TRX 잔고 1,000 TRX(1,000,000,000 SUN). 22:06 UTC에 로컬 원장 의도 0건·해당 주소의 조회 가능한 확정 예치 거래 0건. 실제 서명 직전 다시 확인 필요 |
| 확인한 예치액·예상/최대 수수료·미리보기 만료 | 승인 전 화면의 1 TRX, 예상 8.824 TRX, 최대 17.419 TRX, 계약 `TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq`, 코드 SHA-256 `6b3da37d86037844d5a565c1237f22c9033ce8b9a6877091eb85599cb86b8dc5`. 계획은 22:04~22:05 UTC에 재조회하고 미리보기는 22:09 UTC에 재발급. 사용자님이 만료 전 별도 승인함. [서명 전 화면](nile-a-pretrade.png) |
| 원 txID·방송 전 원장 접수 여부 | `7718b75fe2dbe105d588b85aac6df4aa34bf3944deca209067523c0e227a7c83`. 로컬 승인 원장 `reserved → signed → broadcast_attempt → pending → confirmed`; 방송 시도 2026-09-29T22:10:13.793Z. 저장된 서명 원문을 방송 전에 접수한 의도로 기록 |
| solidified 영수증 `SUCCESS`·실제 수수료 | 원장 확인 시 2026-09-29T22:11:30.465Z solidified, 블록 `71397552`, 블록 시각 2026-09-29T22:10:15Z, 영수증 `SUCCESS`, `8,089,400 SUN = 8.0894 TRX`, Energy 사용량 `80,894`. 독립 RPC 새 조회는 셸 네트워크 격리로 수행하지 못했고 앱의 원 txID 재조회가 `confirmed`를 표시 |
| 동일 지갑·포지션의 예치 후 jTRX 원시 잔고 | `8,946,435,499` raw = `89.46435499 jTRX`. 영수증 `Transfer` 발행량과 앱의 같은 포지션 재조회가 일치. 예치 전 `0`에서 증가 |

## 환매

| 증거 | 값 |
| --- | --- |
| 상태 | `confirmed` — 환매 원 txID의 solidified 성공 영수증과 동일 Nile 포지션 감소를 확인 |
| 환매 전 jTRX 원시 잔고·환율·시장 현금 | `8,946,435,499` raw = `89.46435499 jTRX`. 앱은 최신 환율·시장 현금·전액 환매 모의 실행과 수수료 재원을 검증해 미리보기를 발급했으나 정확한 환율·시장 현금 원시값은 별도 보존하지 않음 |
| 확인한 jTRX 수량·예상 수령 TRX·예상/최대 수수료 | 사용자님이 전체 `89.46435499 jTRX`를 별도 승인. 서명 전 화면의 현재 환율 기준 예상 수령 약 `1 TRX`, 예상 수수료 `8.4231 TRX`·최대 `16.5872 TRX`, 계약 `TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq`. [과거 서명 전 화면](nile-a-withdraw-pretrade.png)은 만료된 미리보기이며, 실제 승인 직전 앱에서 새 미리보기를 발급해 같은 표시 금액과 최대 수수료를 확인 |
| 별도 승인 의도 ID·원 txID | 의도 `485ebfb67a1b2a7981f6585ff587361606fbf074eeb0fdafd3812a9b13e651bf`; 원 txID `ea52225401d019ad0de37df8f78ca8904fd707895bf1e4581215197cd15120e7`(예치 txID와 별개). 원장 `reserved 22:35:50.231Z → signed 22:35:53.151Z → broadcast_attempt 22:35:53.164Z → pending 22:35:53.330Z → confirmed 22:37:32.829Z` |
| solidified 영수증 `SUCCESS`·실제 수수료 | 블록 `71398065`, 블록 시각 2026-09-29T22:35:54Z, 원장 확정 시각 22:37:32.827Z. 저장된 동일 txID 영수증은 `SUCCESS`, 실제 `7,256,900 SUN = 7.2569 TRX`, Energy `72,569`, Net `313` |
| 동일 지갑·포지션의 환매 후 jTRX 원시 잔고 | `0` raw. 서버는 환매 전 `8,946,435,499` raw에서 거래 수량만큼 정확히 감소한 최신 포지션 관측을 통과한 뒤 확정 처리했고, Chrome에서 같은 Nile 포지션을 새로 조회해 `0 jTRX`를 다시 확인. 원장은 이 별도 관측의 정확한 시각을 저장하지 않음 |
| 동일 원 txID의 계약→지갑 내부 송금·실수령 TRX | 원 txID의 영수증 내부 거래에서 jTRX 계약 → 시험 지갑 `TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu`로 거절되지 않은 `1,000,000 SUN = 1 TRX` native 송금 1건 확인. 다른 계약→지갑 양의 송금 0건. 앱도 `영수증에서 실제 수령 1 TRX 확인`으로 표시 |

## 판정

`A-PASS: pass` **(전용 Nile 시험 지갑의 사용자 승인형 A만)** — 두 거래의 서로 다른 원 txID, 서명 전 예약과 방송 전 원장 접수, solidified `SUCCESS`, 실제 수수료, 같은 포지션의 `0 → 8,946,435,499 → 0` raw jTRX, 환매 영수증의 계약→지갑 `1 TRX` 수령을 확인했습니다. 거래에 직접 귀속된 현금흐름은 예치 `-1 TRX`, 환매 `+1 TRX`, 예치 수수료 `-8.0894 TRX`, 환매 수수료 `-7.2569 TRX`로 **순 `-15.3463` 시험 TRX**입니다. 이는 왕복 기술 실증이며 수익 권고나 Mainnet/B 무인 거래 합격이 아닙니다.

2026-09-30 비용 비교 화면에서는 저장된 같은 환매 미리보기의 서명 전 예상 `8.4231 TRX`와 확정 영수증의 실제 `7.2569 TRX`를 대조해 **실제 − 예상 = −1.1662 시험 TRX**로 표시합니다. 이 미리보기는 무료 자원을 차감하는 최신 견적 개선 이전에 발급됐으므로, 차이를 새 견적 산식의 오차나 미래 환매 비용 모델의 검증 결과로 해석하지 않습니다. 당시의 한 거래도 과거 모델의 최소 표본 수와 당시 실행 코드 증거 조건을 충족하지 않습니다.

첫 환매 서명 요청은 브라우저 응답 파서가 서버 미리보기 `state`의 필드를 제거해 서명 전 검증에서 중단됐습니다. 당시 로컬 원장에는 환매 의도·이벤트가 0건이었고 서명·방송은 수행되지 않았습니다. `NileWithdrawalPanel.tsx`가 검증 후 전체 `state`를 보존하도록 수정했으며, 파싱된 응답을 모의 환매 실행에 투입하는 회귀 테스트(2026-09-29 22:18 UTC)를 통과했습니다. 이후 실제 환매는 위의 별도 원 txID와 확정 영수증으로 확인했습니다.

이후 반복된 `환매 조건이 바뀌었습니다` 오류는 환매 지문에 시장 현금·환율·지갑 TRX 잔고 등 조회마다 달라질 수 있는 값이 포함되는데, 브라우저의 두 차례 재조회와 서버 예약 재조회 모두 지문 완전 일치를 요구해서 발생할 수 있었습니다. 정확히 어떤 RPC 필드가 실제로 달라졌는지는 당시 두 미리보기 원문이 없어 확인하지 못했습니다. 2026-09-29 22:27 UTC 서버 원장에는 여전히 확정 예치 1건만 있고 환매 의도·이벤트·txID는 0건이었습니다. 브라우저와 서버는 이제 같은 환매 전용 비교를 사용합니다. 계획·지갑·계약 코드·환매 수량·기존 jTRX 잔고·수수료 상한은 유지하고, 최신 사전 실행과 잔고·시장 현금·수수료 재원 검사를 통과하면서 예상 수령액과 예상 비용이 원래 확인한 값보다 나빠지지 않은 경우에만 변동 시장 조회값을 허용합니다. 확인 대화상자는 실제 서명에 쓰이는 원래 미리보기의 수령 추정과 수수료 상한을 표시합니다. 변경 후 `./scripts/run run check`: **51개 파일, 373개 테스트, 타입 검사, 빌드 통과**(2026-09-29 22:33 UTC). 이후 사용자님이 새 환매 미리보기와 TronLink 거래를 승인해 위의 실제 영수증·포지션을 확보했습니다.
