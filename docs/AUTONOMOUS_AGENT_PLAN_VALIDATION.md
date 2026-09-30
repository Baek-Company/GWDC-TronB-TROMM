# 잔액 기반 거래 에이전트 계획 검증

검증일: 2026-09-29 · 대상: [AUTONOMOUS_AGENT_PLAN.md](AUTONOMOUS_AGENT_PLAN.md)

## 판정

**조건부 타당.** 사용자님이 요청하신 명시 정보 JSON, 유효성 확인과 재질문, 시세→계획→결정→요약, 질문별 시장 조사와 TronLink 건별 승인(A)·제한된 무인 실행(B)의 큰 흐름이 들어 있습니다. 현재 코드와 공식 문서에 대조하면 **0A 읽기/대화 단계는 착수 가능**하지만, 실제 거래를 권고하거나 자동 실행할 수 있는 근거는 아직 없습니다. 0B/0C/A/B/Mainnet은 아래 선결 조건과 실증을 단계별로 통과해야 합니다. 이 검증은 코드 구현이나 실거래 성공 판정이 아닙니다.

## 우선 수정 항목과 반영 결과

| 우선 | 검증에서 발견한 문제와 근거 | 계획에 반영한 해결 방식 · 통과 기준 |
| --- | --- | --- |
| P0 · 입력 사실 | 현재 대화 계약은 지출 1건과 순차 질문 중심입니다. [`conversation.ts`](../server/llm/conversation.ts)의 단일 `expense`/`expenseDay`, 필수 USDD 질문을 그대로 확장하면 조사만 묻는 사용자에게도 질문이 이어질 수 있습니다. [`UserNeeds`](../shared/schemas.ts)는 필수 필드가 모두 채워져야 합니다. | 명시 사실/파생 메타데이터를 분리하고 누락 목록은 검증기가 재계산합니다. `research_only`는 계획 스키마로 강제하지 않으며, 후보별 필수값만 묻습니다. `unknown/none/scheduled`, USDD `null/false`, 복수 지출, 발화 기준 KST 상대 날짜의 불변식을 테스트합니다. |
| P0 · 견적 신뢰 | [`readMainnetQuotes`](../server/data/quotes.ts)는 온체인 계약을 확인해도 JustLend V1 REST의 `sourceUpdatedAt:null`을 견적에 남깁니다. [`isCurrentLiveSource`](../shared/provenance.ts)는 원천시각 없는 REST를 현재 실행 근거로 인정하지 않습니다. 비용·PSM 출구도 현재 `null`입니다. | 블록/시각이 있는 직접 RPC 근거 또는 검증된 원천시각을 가진 견적을 별도로 생성합니다. SUN 현물 USD 가격은 참고값이며 금액별 실출력과 분리합니다. 필수 비용·출구·시각이 없으면 `insufficient_data`, 거래 의도 0건입니다. [JustLend API](https://docs.justlend.org/developers/apis/), [SUN 견적](https://docs.sun.io/api/get-universal-router-quote/) |
| P0 · USDD 주소 | 최신 [USDD Markdown 원문](https://docs.usdd.io/developers/deployment-addresses.md)과 [JustLend 배포 문서](https://docs.justlend.org/developers/deployed_contracts/)는 모두 jUSDD 기초자산 후보 `TXDk...`를 가리키지만 오래된 웹 검색 색인에는 `TCrEV...`가 보입니다. 문서 표면마다 시점이 달라 정적 주소만으로 현재 PSM 출력 호환성을 단정할 수 없습니다. | 양쪽 `PROJECT_PLAN.md`에 출처 시점과 검증 한계를 명시했습니다. PSM 출력·GemJoin 입력·jUSDD `underlying()`·마이그레이션 경로를 실제 체인에서 연결하기 전 계획 B를 실행 가능으로 표시하지 않습니다. 동일성 또는 안전한 변환 경로가 증명되지 않으면 후보에서 제외합니다. |
| P0 · 중복 거래 | 현재 서명/방송은 브라우저 [`execution`](../src/features/execution/)에서 수행하고 `Web Locks`는 같은 origin 안에서만 작동합니다. 계획의 서버 DB 예약과 서명 사이 책임·장애 경계가 없었습니다. | 결정적 `triggerId`와 DB 고유 제약, 서버 의도 예약→브라우저/실행자 서명→원 txID 및 서명 거래 접수→방송→원 txID 재조회 순서를 계약으로 고정했습니다. 임대 만료·브라우저 종료·재시작·다른 기기에서도 같은 사건을 다시 방송하지 않는 테스트가 필요합니다. |
| P0 · 지출 시점 | 기존 계획의 `지출일 근접`은 지출일 전에 지급 자산을 확보할 시점이 정해져 있지 않았습니다. [`PROJECT_PLAN.md`](PROJECT_PLAN.md)는 출금·재전환을 거쳐 당일 필요한 금액을 확보하도록 요구합니다. | 확정 지연·환매/전환 여유 시간을 지출일에서 역산한 목표 시각을 둡니다. 지연·유동성 부족이면 신규 예치를 멈추고 경고하며, A 환매는 별도 사용자 승인을 받습니다. 시간 경과·일정 변경 회귀 시험이 필요합니다. |
| P0 · Mainnet 다단계 | 현재 [`server/index.ts`](../server/index.ts)는 `mainnetExecution:false`입니다. 기존 계획은 출시 게이트만 있고 승인→전환→예치→환매의 중간 실패 처리가 없었습니다. | jUSDT와 USDD 각 단계의 별도 txID·승인·최소 수령·최대 비용·실패 후 잔여 자산/allowance 관측·회수 절차를 단계로 추가했습니다. Nile 성공을 Mainnet 성공으로 간주하지 않습니다. |
| P0 · 금고 한도 | B-1 별도 지갑 제한은 서버 규칙이라 키 탈취 시 온체인 보호가 아닙니다. B-2 금고의 한도 단위·일일 경계·잔고 회계·수령 하한이 없었습니다. | B-1은 Nile 시험으로 한정합니다. B-2는 금고에 **배정된 자산**에만 고정 계약/함수, 토큰 최소 단위의 1회·UTC 일일·누적 한도, 만료, 수령 주소, 최소 수령액을 온체인 강제하고 악성 호출 거절을 시험합니다. 원지갑 지출은 배정 전 보호합니다. |
| P1 · 환매 수령액 | [`readSolidifiedNileTransaction`](../server/transactions.ts)은 영수증·수수료만, 브라우저 [`withdraw.ts`](../src/features/execution/withdraw.ts)는 jTRX 감소까지 관측합니다. 기초 TRX 실수령을 입증하지 못합니다. | 해당 tx 이벤트와 체인 잔액·포지션 변화를 대조하고, 동시 거래 등으로 귀속할 수 없으면 `미확인`으로 두며 실제 순익 계산을 보류합니다. |
| P1 · 데이터/보안 | 기존 [`Source`](../shared/schemas.ts)에는 블록·사용 범위가 없고, 로컬 [`server/index.ts`](../server/index.ts)의 Origin 확인만으로 정책 변경/지속 저장을 보호할 수 없습니다. | `AssessmentEvidenceBundle`에 각 근거의 블록·시각·`display/planning/execution` 범위를 두고, 새 POST API에 세션 인증·본문/호출 제한을 적용합니다. 정책 변경에는 지갑 소유·재생 방지를 적용하고 발화/서명 거래의 접근·보관 기간을 정합니다. |

## 단계별 착수·통과 게이트

1. **0A 읽기/대화:** 실제 거래 권한 없이 구현을 시작합니다. 조사 전용 질문은 추가 질문 0회, 잘못된 모델 JSON은 내부 재추출 1회 후 폼 전환, 답변해도 같은 질문이 무한 반복되지 않음, 명시값 JSON과 출처 연결, 요약 수치/Plan ID의 결정 결과 일치를 테스트합니다.
2. **0B 실잔액/원장:** 사용자 진술액·실측 잔액·보호 지출액·예비액·미확정 예약액을 자산별로 대조하고, 중복 기기/프로세스 재시작에서 단일 원 txID를 복원합니다. 코드/모의 테스트 결과와 실제 체인 증거를 분리합니다.
3. **0C/A Nile 승인형:** 소액 시험 지갑과 거래별 TronLink 승인으로 예치·환매·solidified 영수증·동일 포지션·실제 실수령액을 확인합니다. 시험 지갑/자산 미준비는 `실증 미완료`입니다.
4. **B-1/B-2 무인형:** B-1은 별도 Nile 지갑으로 스케줄러·원장을 시험합니다. B-2는 금고 주소에서 실제 jTRX 예치·환매 후 악성 실행자/한도/만료/수령액 하한 실패를 체인에서 확인하고 독립 보안 검토를 거칩니다. 소유자의 pause·긴급 회수는 백엔드 장애 때도 작동해야 합니다.
5. **Mainnet:** USDD 토큰 경로, 실행 적격 최신 견적, 양방향 출구·왕복 비용, 자산별 다단계 실패/회수, 소액 건별 승인 시험이 모두 통과해야 합니다. 둘 이상의 실행 가능 계획이 없으면 대회 기획의 비교 요건을 충족했다고 표시하지 않습니다. 무인 정책의 기본값은 `관측·제안만`입니다.

## 확인한 범위와 남은 검증

- 계획과 현재 저장소의 스키마·계획 계산·견적·서명·영수증 경계를 읽고 대조했습니다. 이 문서 작업 중 코드를 실행하거나 실제 TronLink 서명/거래를 수행하지 않았습니다.
- 공식 JustLend V1 API에는 V2와 달리 응답 최상위 `timestamp`가 없고, 공식 SUN 교환 견적의 `amountOutMinimumRaw`·검증되지 않은 hook 플래그는 실행 전에 확인해야 합니다. [JustLend API](https://docs.justlend.org/developers/apis/), [SUN Universal Router](https://docs.sun.io/api/get-universal-router-quote/)
- **미확인:** 현재 RPC/PSM 응답과 블록별 상태, Nile 시험 지갑·잔고, jTRX 실제 거래, 금고 호환성, Mainnet 출구·실비용, 금고 보안 감사. 이 자료가 없으면 `hold` 또는 `insufficient_data`를 유지합니다.
