# GWDC 잔액 기반 거래 에이전트 구현 계획

작성일: 2026-09-29 · 검증일: 2026-09-29 · 상태: 0A·0B 읽기 경로와 A/B 정책 기반 구현, 인증된 거래 연결·실증 전

검증 결과와 착수 전 확인 항목은 [AUTONOMOUS_AGENT_PLAN_VALIDATION.md](AUTONOMOUS_AGENT_PLAN_VALIDATION.md)에 기록합니다. 구현된 범위는 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), 무인 실행의 추가 시험과 합격 기준은 [UNATTENDED_EXECUTION_VERIFICATION_PLAN.md](UNATTENDED_EXECUTION_VERIFICATION_PLAN.md)에 기록합니다. 이 계획의 단계별 **코드 완료**와 실제 지갑·체인 **실증 완료**는 별도로 판정합니다.

## 1. 목표와 권한 경계

사용자님이 요청하신 두 단계를 모두 구현 대상으로 둡니다.

| 단계 | 에이전트가 자동으로 하는 일 | 거래 권한 |
| --- | --- | --- |
| A. 승인형 | TronLink 계정의 실제 잔액·포지션 관측, 지출 재원 보호, 계획·거래 제안, 실행 직전 재검증, 거래 후 기록·재평가 | 거래마다 사용자님이 TronLink 서명 화면에서 승인합니다. |
| B. 제한된 무인형 | 사전에 설정한 정책 안에서 관측→판단→실행→확정→재평가를 반복합니다. | 사용자님이 TronLink로 한도를 정해 별도 운용 금고(vault)에 자산을 배정합니다. 금고의 온체인 규칙을 통과한 거래만 실행자가 호출합니다. |

**기술적 경계:** TronLink DApp 연결만으로 사용자의 원래 지갑에서 조용히 서명할 수 없습니다. `tronWeb.trx.sign()`과 공식 TronLink Signer의 서명 요청은 사용자 승인 화면을 거칩니다. B 단계에서 자산은 제한된 금고 주소로 옮겨져 운용되므로, 화면은 `TronLink 지갑 잔액`과 `금고 배정 잔액`을 구분해야 합니다. 같은 원래 지갑 주소를 에이전트 키로 직접 무인 운용하는 방안은 채택하지 않습니다. TRON Active permission은 `TriggerSmartContract` 같은 **거래 종류**를 제한하지만 호출 대상 계약·함수·금액까지 제한하지 못한다는 문서 기반 설계 판단 때문입니다. [TronLink DApp](https://docs.tronlink.org/dapp/getting-started/), [TronLink Signer](https://docs.tronlink.org/ai-support/tronlink-signer/), [TRON 계정 권한](https://developers.tron.network/docs/multi-signature/)

이 계획은 기존 `팀 저장소 루트의 PROJECT_PLAN.md`의 지출 우선·같은 체인/자산 계획·실제 포지션 추적 원칙을 유지하며, `팀 저장소 루트의 IMPLEMENTATION_WORKFLOW.md`에서 제외했던 백그라운드 실행·지속 저장소·자동 재배분을 **새 개발 범위**로 추가합니다. 현재 코드의 `mainnetExecution:false`와 Nile 시험 실행 범위를 구현 완료로 확대 해석하지 않습니다.

## 2. 현재 출발점과 먼저 해결할 간극

- 현재 Mainnet의 `1,000 USDT`는 `src/lib/session.ts`의 **가상 시연 입력**입니다. 연결한 TronLink 계정의 실제 Mainnet USDT/USDD 잔액과 지출 약정을 읽어 대조하는 경로는 없습니다.
- 현재 거래 코드는 Nile TRX→JustLend jTRX 예치·환매에 한정됩니다. `src/features/execution/*`가 미리보기·사용자 확인·TronLink 서명을 수행하고, `server/transactions.ts`가 계약·잔고·수수료·영수증을 조회합니다. 실제 Nile txID와 동일 포지션의 확정 거래 성공은 아직 증명되지 않았습니다.
- 현재 거래 기록은 브라우저 `localStorage`가 중심이고 Web Locks는 같은 origin의 탭에만 적용됩니다. 종료 후 재시작, 다른 기기, 정기 실행에는 서버의 지속 원장과 원 txID별 중복 방지가 필요합니다.
- 환매의 실제 수령액과 전 구간 현금흐름 검증이 완성되지 않았습니다. 이를 보강하기 전에는 실제 순수익을 에이전트의 다음 거래 근거로 쓰지 않습니다.
- Mainnet PSM 양방향 출구·왕복 비용, 일부 RPC와 지갑 리소스가 미확인입니다. 데이터가 없으면 자동 거래 판단은 `보류`여야 합니다. [현재 구현 상태](IMPLEMENTATION_STATUS.md)

## 3. 사용자 요청을 처리하는 네 단계

사용자님이 추가한 조건은 **A/B 두 거래 모드보다 앞선 공통 처리 흐름**으로 구현합니다. 시장 조사 질문은 계획 입력이 미완성이어도 독립적으로 답할 수 있으며, 조사 답변 자체는 거래 권한이 아닙니다.

### ① 명시한 정보만 JSON으로 생성

`InputExtractor`가 대화에서 직접 말한 값과 질문을 추출해 `UserDeclaredRequest` JSON을 만듭니다. 다음은 **가상 문장** `1,000 USDT를 보유하고 30일 운용해요. 7일 뒤 200 USDT를 지출해요. 지금 JustLend 금리도 알려줘요`의 추출 예시입니다.

```json
{
  "schemaVersion": 1,
  "intent": "plan_and_research",
  "explicitFacts": {
    "asset": "USDT",
    "statedHoldings": "1000",
    "horizonDays": 30,
    "expenseDeclaration": "scheduled",
    "expenses": [{ "due": { "type": "relative_days", "days": 7 }, "amount": "200", "asset": "USDT" }],
    "reserve": null,
    "risk": null,
    "acceptsUsddRisk": null
  },
  "marketQuestions": ["지금 JustLend 금리도 알려줘요"],
  "missingFields": ["chain", "startDate", "reserve", "risk"],
  "conflicts": []
}
```

`null`은 사용자님이 말하지 않은 값입니다. `intent`, `missingFields`, `conflicts`는 추출 사실이 아니라 **파생 메타데이터**이며, `RequestValidator`가 모델 출력을 믿지 않고 다시 계산합니다. 원문 인용인 `marketQuestions`도 거래 명령으로 취급하지 않습니다. 지갑 조회로 얻은 잔액, 시연 기본값, 모델 추정, 조회 시세를 `explicitFacts`에 넣지 않습니다. 각 사실에 사용자 발화 ID·원문 위치·발화 시각을 붙이고 `explicit | wallet_observed | derived` 출처를 분리합니다. 상대 날짜는 발화 시각·`Asia/Seoul` 시간대·원문을 고정한 별도 파생값으로 해석하고, 재시작해도 기준일을 바꾸지 않습니다. 금액은 자산과 함께 문자열로 저장하고 복수 지출을 배열로 표현합니다. 보유 자산과 지출 자산이 다르거나 여러 자산을 말한 경우 단일 `asset`으로 합치지 않고 지원 여부 또는 모호함을 보존합니다. `expenseDeclaration`은 `unknown | none | scheduled`로 관리하여 `unknown`은 계획 미완료, `none`은 `expenses: []`, `scheduled`는 한 건 이상의 유효한 지출이라는 불변식을 검증합니다. `/needs`에서 JSON·누락 필드·입력 버전을 보여주고 내보낼 수 있게 합니다. 현재 `conversationFieldsSchema`의 단일 `expense`/`expenseDay`를 복수 지출 계약으로 확장하되 기존 세션은 버전별로 이행합니다.

### ② 형식·의미 검증 후 필요한 정보만 다시 질문

`RequestValidator`는 JSON 구문/스키마, 금액의 역할(보유액/희망 투자액/지출액), 자산 단위, 금액 정밀도·범위, 날짜와 시간대, 지출 목록, 서로 충돌하는 진술, 위험 동의를 순서대로 검사합니다. **모델이 잘못된 JSON을 만든 경우**에는 같은 발화를 내부에서 한 번 재추출하거나 규칙 기반 추출로 전환합니다. 사용자님께 모델의 형식 오류를 고치라고 요구하지 않습니다. **사용자 정보가 없거나 모호한 경우**에는 이미 확인된 값을 보존하고 누락/충돌 필드 하나를 구체적으로 묻습니다.

`질문 → 답변 → 해당 필드 갱신 → 전체 재검증`을 유효한 계획 입력이 될 때까지 반복합니다. 필드별 상태는 `missing | invalid | ambiguous | verified`로 보존합니다. 필수 필드는 **요청 목적과 후보별로** 계산합니다. `research_only`는 계획 입력과 구별된 요청형으로 파싱하고, 계획 필드를 요구하지 않습니다. USDD 미답변(`null`)을 거절(`false`)로 위조하지 않고, 어느 쪽이든 동의 없는 USDD 후보만 제외합니다. 다른 후보를 위해 USDD 동의를 반복 질문하지 않습니다. 기존 `UserNeeds.acceptsUsddRisk`의 필수 boolean에는 계획 계산용 **파생 유효 권한**만 전달하고, 원래 JSON의 `null`/`false`는 그대로 보존합니다. 같은 질문에 답했는데 진전이 없다면 같은 문장을 반복하지 않고, 답이 인식되지 않은 이유와 허용 형식의 예시를 제시하며 해당 입력칸으로 전환할 수 있게 합니다. `지출 없음`과 `아니요` 같은 USDD 거절도 유효한 완료값입니다. 변경된 기존 값은 후보로 보여 확인받고, 대화 초기화/늦은 응답/새로고침 뒤에도 이전 값이 암묵적으로 덮이지 않게 합니다. 현재 질문 ID·답변 세대·검증 상태를 세션에 저장해 재개합니다. 검증 완료 전에는 기존 `UserNeeds` 필수 스키마로 강제 변환하지 않습니다.

**질문 루프 종료 조건:** 필요한 필드가 유효하고 사용자님이 JSON 요약을 확인하면 계획 단계로 진행합니다. 답변 보류 시에는 `입력 미완료` 상태로 저장하고 이후 같은 버전에서 재개합니다. 확인 전 자동 추천·거래는 열지 않습니다.

### ③ 시세 조회 → 계획 계산 → 추천 결정 → 결과 요약

확인된 입력 버전으로 `AssessmentEvidenceBundle → ProductQuote → PlanSet → RecommendationDecision → Summary`를 순서대로 생성합니다. 기존 `shared/markets.ts`의 `MarketSnapshot`은 Mainnet JustLend 목록 자료형이므로 다른 자산 가격·Nile 견적까지 담는 공통형으로 재사용하지 않습니다. 한 평가에 고정한 기준시각과 허용 블록/시간 오차를 기록하고, 네트워크 조회에 제한 시간·취소·실패 상태를 둡니다. 시세에는 단순 토큰 가격뿐 아니라 JustLend 공급 금리·시장 현금/출구 유동성, USDD↔USDT 전환 실출력·용량, TRX 비용 환산율, Energy/Bandwidth·수수료 추정이 포함됩니다. 각각 chain, 계약/토큰 주소·단위, `sourceUrl`, `fetchedAt`, `sourceUpdatedAt`, 블록/버전, `live|snapshot|synthetic`, 조회 성공 여부를 기록합니다. 최신 live 근거가 없는 필수 값은 계산에 임의로 채우지 않습니다. 현재 JustLend `/lend/jtoken`은 공급 금리와 시장 값을 제공하지만 **현물 USD 시세 API가 아니고** 원천 갱신 시각도 없으므로, 화면 참고값과 거래 적격 근거를 분리합니다. 실행 적격 견적은 블록·시각을 가진 직접 RPC 읽기 또는 원천 갱신 시각이 검증된 경로로 생성하고, 블록당 금리를 연환산할 때는 체인별 블록 시간 근거도 검증합니다. Mainnet 토큰의 USD 참고 가격은 SUN `/apiv2/price`를 주소별로 조회해 문자열 가격·`last_updated`·주소 일치·신선도를 검증하는 어댑터를 추가합니다. SUN Universal Router의 금액별 견적은 검증되지 않은 V4 hook 경로를 제외하고 허용 라우터·토큰·풀, `slippageBips`, `amountOutMinimumRaw`를 기록합니다. 해당 응답에 원천 시각이 없으므로 실행 직전 온체인 경로·최소 수령액을 재검증합니다. [JustLend API](https://docs.justlend.org/developers/apis/), [SUN 가격 API](https://docs.sun.io/api/get-price/), [SUN 경로 견적](https://docs.sun.io/api/get-universal-router-quote/)

기존 `calculateLiquidity`와 `createMainnetPlans`/`createNilePlans`를 재사용해 지출액·예비액을 먼저 보호하고, 자산/체인별 후보의 기본 수익·왕복 비용·출금 가능성을 계산합니다. 추천은 LLM이 아닌 결정론적 `PolicyEngine`이 `recommend | hold | insufficient_data` 행동과 이유 코드로 확정합니다. 기존 `hold` Plan도 유효한 `recommendedPlanId`를 가질 수 있으므로 ID가 `null`인지 여부만으로 행동을 추론하지 않습니다. 비용이 수익을 넘거나 출구/수수료가 미확인되면 `거래하지 않음`과 이유를 명시합니다. `assessmentId`, 요청·확인 버전, 견적·정책 버전, 관측 기준시각을 계산·결정·요약에 공통으로 묶습니다. 현물 USD 참고 가격은 수량별 교환 견적이나 실행 적격성으로 승격하지 않습니다. NIM은 **확정된 계산 결과를 바꾸지 않고** 짧은 한국어 요약만 작성하며, 응답의 수치/계획 ID는 결정 객체와 기계적으로 대조합니다.

요약 화면에는 확인한 입력 JSON 버전, 실제 잔액과 사용자 진술 금액의 차이, 보호할 지출·예비액, 조회 시세/시각·출처, 후보별 예상 순수익·비용·출구 위험, 최종 추천 또는 보류 이유, 다음 행동을 표시합니다. 실제 잔액 미연결이면 가상 계획임을 표시하며, 요약을 받았다는 사실을 거래 승인으로 해석하지 않습니다.

### ④ 사용자 질문에 맞춘 시장 조사 결과

`MarketResearcher`는 대화에서 계획 입력과 **시장 질문**을 분리하고 필요한 자산·프로토콜·기간·비교 대상을 식별합니다. 질문을 `spot_price | lending_rate | market_liquidity | amount_specific_swap_quote | wallet_balance | protocol_rule | historical_price`로 분류하고 종류별 **읽기 전용 허용 어댑터**만 호출합니다. 범위는 먼저 TRON, JustLend, USDD, 관련 환산/네트워크 비용으로 고정합니다. 현재 금리·가격·유동성을 묻는다면 실시간 어댑터를 조회하고, 과거 가격 질문에는 기간을 지정한 자료를, 프로토콜 구조 질문에는 공식 문서를 조회합니다. 과거 추세는 현재 거래 견적이나 예상 수익으로 바꾸지 않습니다. 질문이 모호하면 조사 대상 하나만 묻습니다. 범위 밖의 질문은 답할 수 있는 출처를 추가하기 전까지 지원 범위를 설명합니다. [SUN 과거 가격 API](https://docs.sun.io/api/get-token-price-history/)

조사 결과는 질문별로 `질문 / 핵심 결론 / 근거별 값·단위·시각·링크 / 현재 확인 불가 항목 / 계획에 미치는 영향`을 반환합니다. 각 근거에 `availability(ready|unknown|unavailable)`와 `useScope(display|planning|execution)`를 붙입니다. REST·RPC·공식 MCP·공식 문서 중 실제로 확인한 출처만 인용하며, 서로 다른 체인·블록·시점의 수치를 한 순위로 합치지 않습니다. 제공자가 429/장애를 반환하거나 원천 갱신 시각이 없으면 그 사실을 표시하고 과거값을 현재 시세로 꾸미지 않습니다. 조사 중 발견한 사실은 `AssessmentEvidenceBundle`에 검증 후 반영할 수 있지만 질문 문장이나 LLM 설명이 계약 주소·거래 명령을 직접 바꾸지는 못합니다.

**완료 기준:** 사용자 질문 3종(현재 금리, USDD 출구 가능 여부, Nile과 Mainnet의 차이)에 대해 관련된 조사와 근거·시각을 반환하고, 연결 실패/429에서는 `현재 확인 불가`로 마칩니다. 계획 입력이 없어도 조사만 완료되며 거래 의도는 생성되지 않습니다.

## 4. 공통 아키텍처

`관측 → 결정 → 실행 의도(intent) → 권한 확인 → 단일 거래 제출 → solidified 확정 → 동일 포지션 재관측 → 기록/재평가`의 한 방향 상태 기계로 구성합니다.

| 구성 요소 | 역할 | 변경 위치 |
| --- | --- | --- |
| `WalletObserver` | 계정·체인·TRX/허용 토큰 잔액, 수수료용 TRX/Energy/Bandwidth, 기존 포지션을 **실제 체인**에서 조회. 블록·조회 시각·출처·토큰 단위를 보존 | `src/wallet.ts`, `server/transactions.ts`, 신규 `server/agent/observer.ts` |
| `InputExtractor/RequestValidator` | 명시값만 버전 있는 JSON에 추출하고 누락·충돌을 필드별 검증. 응답 진전 여부를 추적해 반복 질문을 막음 | `server/llm/conversation.ts`, `src/features/conversation/ChatPanel.tsx`, `shared/schemas.ts`, 신규 `server/agent/intake.ts` |
| `MarketResearcher` | 질문을 읽기 전용 공식 원천에 연결하고 시점·단위·링크가 있는 조사 결과를 반환. 계획 견적과 조사 답변의 증거 범위를 구분 | `server/data/*`, `server/mcp/*`, 신규 `server/agent/research.ts` |
| `PolicyEngine` | 지출일 재원, 예비액, 허용 자산/계약, 1회·일일·전체 배정 한도, 최소 순이익, 수수료·출구 유동성·데이터 신선도를 결정론적으로 검사. `hold`도 정상 결과 | `shared/execution-policy.ts`, 신규 `shared/agent-policy.ts` |
| `DecisionAgent` | 관측 변화나 지출일 도래에 따라 후보를 만들고 정책 결과와 근거를 기록. NIM은 입력 구조화·설명만 담당하고 서명·방송 도구를 받지 않음 | 신규 `server/agent/decision.ts`, 기존 `server/llm/*`는 읽기/설명 경계 유지 |
| `SummaryPresenter` | 확정된 JSON·시세·계획·결정과 출처를 한 화면과 JSON 응답으로 요약. 모델 문장은 계산 결과를 변경하지 않음 | `src/main.tsx`, `src/features/plans/PlanExplorer.tsx`, 신규 `server/agent/summary.ts` |
| `ExecutionCoordinator` | 서버 원장의 의도 예약·상태 전이와 브라우저/실행자의 서명·방송 책임을 분리. 결정적 `triggerId`와 DB 고유 제약으로 중복 방지 | 신규 `server/agent/coordinator.ts`, 기존 `src/features/execution/*` 재사용 |
| `SignerAdapter` | A는 TronLink 사용자 서명, B는 금고 호출용 실행자 서명. 정책 엔진은 서명 키를 직접 다루지 않음 | 신규 `src/features/execution/signer.ts`, 신규 `server/agent/keeper.ts` |
| `Ledger/Scheduler` | 정책 버전, 의도, 원 txID, 영수증, 실제 수수료·수령액, 포지션 관측을 append-only로 저장. 정기/이벤트 실행과 재시작 후 조정 | 신규 `server/agent/ledger.ts`, `server/agent/scheduler.ts` |

공통 계약은 `WalletSnapshot`(chain/address/token·position balances/block/source/time), `AssessmentEvidenceBundle`(가격·금리·유동성·수량별 견적과 각각의 블록/시각·사용 범위), `AutomationPolicy`(범위·한도·만료·pause·version), `Decision`(명시적 행동·이유 코드·사용 증거), `ActionIntent`(고유 키·계획 ID·미리보기 만료·상태), `ExecutionEvent`(원 txID·solidified 영수증·실제 수량/비용)로 정의하고 `shared/schemas.ts`에서 검증합니다. 금액은 문자열과 Decimal/BigInt를 사용합니다.

`triggerId`는 일정 구간 또는 체인 이벤트 ID와 목표 포지션 버전에서 결정적으로 만들고, `(chain, account/vault, policyVersion, triggerId, action, targetPosition)`에 DB 고유 제약을 둡니다. 주기적 새 결정과 같은 사건의 재시도를 구별하고, 임대 만료가 새 거래 허가를 뜻하지 않게 합니다. A의 서버는 의도·미리보기 해시·만료를 예약하고 브라우저는 이를 재조회한 뒤 사용자 승인·TronLink 서명을 수행합니다. 서명된 거래의 계정·체인·대상·함수·수량·최대 수수료·만료가 예약 의도와 일치하는지 검증하고 **원 txID와 서명 거래 원문을 원장에 안전하게 접수한 후** 방송하며, 접수 실패 시 방송을 막습니다. 방송 결과가 모호하면 원 txID의 solidified 상태를 재조회하고 새 의도를 내지 않습니다. 브라우저 종료·다른 기기·서버 재시작·서명 거절마다 상태 전이를 정의해 시험합니다. B도 같은 원장 순서를 사용하지만 서명 주체는 금고 실행자입니다.

새 `POST` 읽기 API에도 요청 본문 크기·세션 인증·호출 빈도·외부 API/LLM 사용량 제한을 둡니다. 사용자 발화와 잔액은 필요한 범위만 저장하고 보관 기간·삭제 경로를 정의합니다. LLM·외부 조사 응답의 텍스트는 데이터로만 취급하며 정책·계약 allowlist·거래 의도에 직접 반영하지 않습니다.

### 거래를 만들지 않는 조건

계정/체인 변경·지갑 잠금, live 출처의 시각 누락·만료, 계약/기초자산 불일치, 예상 총수익보다 왕복 비용이 큼, 예정 지출 또는 예비액 부족, TRX 수수료 재원 부족, 출구 유동성·PSM 물량 미확인, 정책 한도 초과, 미확정 원 txID 존재, 두 RPC의 핵심 값 불일치, 서버 원장 장애에는 신규 거래를 보류합니다. Nile의 경제성 미확인 거래는 A 단계에서 **명시적 기술 시험**으로만 가능하며 B 단계에서는 보류합니다.

## 5. 구현 순서와 완료 기준

### 0단계 · 읽기/대화 토대와 거래 원장

0. **0A · 읽기/대화:** 3절의 `UserDeclaredRequest`·검증 질문 상태·조사 결과·추천 결정 스키마와 읽기 전용 오케스트레이터를 구현합니다. `POST /api/agent/intake`는 명시값 JSON/검증기가 계산한 누락·충돌/다음 질문을, `POST /api/agent/research`는 출처가 있는 조사 결과를, `POST /api/agent/assessment`는 **확인된** 입력에서 시세→계획→결정→요약을 반환합니다. 새 API의 세션 인증·호출 제한을 먼저 적용합니다. 내부 계산 함수를 재사용하고, 현재 `UserNeeds`의 필수 필드는 확인 완료 후에만 채웁니다.
1. **0B · 실잔액/원장:** Mainnet/Nile 주소와 체인을 확인하고 허용 자산의 실제 잔액, 수수료 재원, 기존 JustLend 포지션을 읽습니다. 가상 입력과 실잔액을 다른 화면·자료형으로 분리합니다. 사용 가능 금액의 상한은 `min(사용자가 승인한 운용 배정액, 동일 체인·동일 자산의 확인된 잔액 − 예정 지출 − 예비액 − 미확정 거래 예약액 − 최대 수수료 재원)`으로 계산하며 음수이면 0입니다. B에서는 원지갑의 예정 지출액을 **금고 배정 전에** 보호하고, 실행 상한은 배정된 금고 잔액에만 적용합니다. 잔액/정책/지출 일정/견적 버전이 바뀌면 기존 제안을 무효화합니다.
2. 로컬 단일 사용자용 지속 원장(DB)과 트랜잭션 단위 원자적 예약을 추가합니다. 브라우저 `localStorage`는 화면 캐시로만 쓰고 원 txID·정책·관측의 진실 원천은 원장과 체인 조회로 둡니다. 정책 변경/일시정지 API에는 지갑 소유 확인, 재생 공격 방지, 요청 인증을 적용합니다. 현재 loopback Origin 검사만으로 쓰기 API를 열지 않습니다. 서명된 거래 원문은 방송 복구에 필요한 동안만 접근 제한·암호화해 저장하고 보관 기한 뒤 삭제합니다.
3. **0C · Nile 증거:** 기존 Nile 예치·환매의 실제 확정 수량·수수료·수령액을 연결합니다. 환매 수령액은 해당 tx의 검증된 이벤트와 같은 체인·블록의 잔액/포지션 변화를 대조해 산출하고, 동시 입출금 때문에 특정할 수 없으면 `미확인`으로 남겨 순익 계산을 보류합니다. 알 수 없는 방송 결과는 동일 txID만 조회하고 새 거래를 만들지 않습니다.

**코드 완료:** 명시하지 않은 값이 JSON에 생기지 않고, 잘못된 금액/날짜는 해당 필드만 재질문하며, 같은 답에 같은 질문을 무한 반복하지 않습니다. 시세→계획→결정→요약의 입력 버전과 출처가 연결됩니다. 가상 1,000 USDT가 실잔액으로 표시되지 않고 지출 보호액이 투자 상한에서 빠집니다. 모의 서명/방송 중단과 프로세스 재시작 후 미확정 txID·정책 복구를 시험합니다.

**실증 완료:** 별도 Nile 시험 지갑과 거래별 승인으로 소액 예치·환매하고, 원 txID/solidified 영수증/동일 포지션/실제 수령액 증거를 확보합니다. 시험 자산·지갑이 준비되지 않으면 코드 완료와 별도로 `실증 미완료`로 표시합니다.

### A 단계 · TronLink 건별 승인 에이전트

1. `observe → evaluate → hold/propose`를 자동으로 실행하고, 조건 변경·잔액 변화·지출일 근접 시 계획을 다시 계산합니다. 지출 지급 자산의 목표 잔액을 `지출 기한 − 최대 확정 지연 − 환매/전환 여유 시간` 전에 확보하도록 역산합니다. 지출일 변경·유동성 부족·시간 경과로 이 목표가 불확실하면 신규 예치를 중단하고 경고합니다. A의 환매에도 매번 사용자 승인/TronLink 서명이 필요합니다. 전액 투입 대신 사용자가 지정한 자산·배정액만 다룹니다.
2. 제안 카드에 현재 잔액, 보호할 지출액, 거래액, 계약·함수, 네트워크, 예상/최대 비용, 출구 위험, 예상 순수익과 `거래하지 않음` 이유를 표시합니다. 사용자님이 계획과 정책 버전을 확인한 뒤 실행을 요청합니다.
3. 서명 직전 기존 45초 Nile 미리보기와 실제 잔액·계약·정책 버전을 다시 확인합니다. TronLink의 계정/체인 변경 또는 `accountsChanged=[]`는 요청을 즉시 무효화합니다. 거래마다 TronLink 팝업 승인을 받습니다. 서버가 예약한 의도와 브라우저 서명 결과를 비교하고 원 txID를 지속 저장한 뒤 방송합니다. 방송 응답은 `pending`으로 기록하고 solidified 영수증·동일 포지션을 확인한 뒤에만 `confirmed`로 표시합니다. [TronLink 이벤트](https://docs.tronlink.org/plugin-wallet/passive-messages/), [TronLink 승인](https://docs.tronlink.org/plugin-wallet/active-requests/)
4. Nile jTRX부터 구현합니다. Mainnet USDT/USDD는 읽기·제안 상태를 유지하고, 공식 계약·양방향 출구·왕복 비용 및 실제 자산에 대한 별도 승인 검증 후 실행을 열 수 있습니다.

**코드 완료:** 중복 탭/기기, 서명 거절, 계정·체인 전환, 견적 만료, 서버 재시작, 방송 시간 초과, 비용 초과에서 보류 또는 원 txID 복구가 재현됩니다. **실증 완료:** Nile 소액 예치와 환매가 거래별 승인→원 txID→확정 영수증→실제 잔액/포지션으로 끝납니다.

### B-1 단계 · Nile 무인 실행 기계 검증

별도의 **소액 Nile 시험 지갑**으로 스케줄러·실행자·원장·중복 방지를 검증합니다. 이 지갑은 사용자님의 TronLink 원 계정과 분리하고 Mainnet 자산을 넣지 않습니다. 이 단계의 소액·횟수 제한은 **서버 규칙**이며 키 탈취 때 온체인 한도로 강제되지 않습니다. 키는 코드, `.env.local`, 로그, 프런트엔드에 두지 않으며 사용 중인 비밀 보관 방식의 백업·복구·접근 권한을 검토합니다. 공식 TronLink MCP의 Direct API `agent-wallet`도 TronLink 브라우저 서명이 아닌 별도 키 경로이고, 자동 생성 암호를 평문 런타임 파일에 저장하므로 실자금 운용의 기본 경로로 채택하지 않습니다. [TronLink MCP 보안 경계](https://docs.tronlink.org/ai-support/mcp-server-tronlink/)

**완료:** 설정한 소액/횟수/수수료/만료를 넘지 않고, 프로세스가 서명·방송 직후 중단되어도 복구 시 중복 거래가 없음. 정책 일시정지·만료·키 접근 실패 때 즉시 신규 거래를 중단함. Nile 실제 tx 증거와 원장 일치.

### B-2 단계 · 사용자 자산용 제한 금고

구현 전에 Nile jTRX의 `mint`/`redeem`을 **금고 계약 주소에서** 실제 소액 호출하고 TRX가 금고로 돌아오는 최소 호환성 실험을 수행합니다. Nile 공식 배포 주소가 시험용일 수 있으므로 코드·ABI·Comptroller 대조만으로 통과 처리하지 않습니다. 호환되지 않으면 금고 설계를 변경하며 Mainnet으로 확장하지 않습니다.

1. 사용자님이 TronLink로 정책(허용 자산·프로토콜·계약·함수, 1회/일일/전체 한도, 지출/수수료 예비액, 만료, 수령 주소)을 확인하고 금고에 **명시적 금액만** 배정합니다. 이후 에이전트 실행자는 금고의 허용된 호출만 요청하고 임의 주소로 이체할 권한은 갖지 않습니다. 스마트계약은 외부 실행자 거래로 호출되어야 하므로 지속 실행자와 수수료 재원이 필요합니다. [TRON 스마트계약](https://developers.tron.network/docs/smart-contracts-introduction/)
2. 금고가 고정한 계약 주소·함수 셀렉터, 토큰 최소 단위의 1회/UTC 일일/누적 **신규 예치 원금** 한도, 현재 포지션 노출 상한, 만료, 수령 주소, 환매 최소 실수령액을 온체인에서 강제합니다. 일일 구간은 UTC 00:00 기준으로 나누고, 거래 성공 시 사용한 예치액만 일일·누적 한도에서 차감합니다. 환매가 확정되어 현재 노출은 감소해도 소진한 일일·누적 한도는 복원하지 않습니다. 이 회계와 예치 후 반환된 포지션 토큰의 보유량을 계약 테스트로 고정합니다. 소유자에게 pause·권한 철회·금고에 남은 원자산 또는 포지션 토큰의 긴급 회수 경로를 제공하고, 백엔드 장애 때도 TronLink에서 직접 호출할 수 있게 합니다. 긴급 회수가 기초자산으로의 즉시 환매를 보장하지는 않으며 시장 유동성 제약을 화면에 표시합니다. 보유/예치/환매별 토큰 흐름과 잔고 회계, 재진입·반환값·권한 변경 실패를 시험합니다. 업그레이드 가능성과 관리자 권한은 최소화하고 별도 보안 검토 전에는 Mainnet 자산을 넣지 않습니다.
3. 화면에 `현재 정책`, `남은 한도`, `금고 보유액`, `다음 실행 사유`, `중단/철회`, `각 txID`를 표시합니다. pause는 **다음 거래**를 막는 것이며 이미 방송한 거래를 취소한 것으로 표시하지 않습니다.

**완료:** Nile에서 악의적 실행자/잘못된 계약/허용 한도 초과/만료/다른 수령 주소/최소 수령액 미달 호출이 체인에서 거절되고, 소유자가 백엔드 없이 일시정지·비상 회수할 수 있음. 금고가 제어하는 범위는 **배정된 자산**으로 한정하고, 원래 지갑의 미래 지출은 배정 전 관측·보호합니다. 독립적인 금고 코드 보안 검토와 실제 Nile 예치·환매·중단 증거 확보 후 Mainnet 전환 여부를 결정합니다.

### Mainnet 출시 게이트

Mainnet은 별도 구현 단계로 둡니다. 먼저 JustLend 시장·토큰·기초자산/활성 상태와 PSM의 USDT↔USDD 양방향 실출력·용량·승인·왕복 비용·출구를 같은 평가 구간의 체인 상태에서 검증합니다. 최신 USDD Markdown 원문과 JustLend 배포 문서는 `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`를 공통 후보로 기재하지만 오래된 웹 색인에는 다른 주소가 남아 있으므로, PSM 출력 토큰·GemJoin 입력·jUSDD `underlying()`·필요한 마이그레이션 경로를 온체인에서 연결해 입증하기 전에는 PSM→jUSDD를 후보에서 제외합니다. [USDD 배포 주소 원문](https://docs.usdd.io/developers/deployment-addresses.md), [JustLend 배포 계약](https://docs.justlend.org/developers/deployed_contracts/)

Mainnet A는 `USDT approve → jUSDT mint → jUSDT redeem`과, 위 주소·용량·출구가 검증될 때만 `PSM 진입 → USDD approve → jUSDD mint → jUSDD redeem → PSM 출구`의 각 단계를 **별도 txID와 별도 TronLink 승인**으로 구현합니다. B는 같은 단계의 금고 허용 함수·한도 안에서만 실행합니다. 단계마다 최소 수령액·최대 비용·만료·실제 잔액을 검사하고, 중간 단계가 실패하면 남은 자산/승인액을 관측해 자동 재제출을 막으며 사용자 승인형 회수 절차를 제시합니다. 승인 잔여량과 철회 가능성도 추적합니다. 검증된 두 실행 가능 경로가 없으면 대회 기획의 두 경로 비교 요건을 충족했다고 표시하지 않고, 적격한 개별 경로의 승인형 A 가능 여부만 별도로 판정합니다. 수익성이 확인되지 않은 경로는 `hold`입니다. 금고 보안 검토, 키·서버 운영 점검, 작은 배정액의 건별 승인 시험, 이상 상황 복구를 통과하기 전에는 무인 Mainnet 정책을 활성화하지 않습니다.

## 6. 필수 검증 목록

- **입력/대화:** 조사 전용 질문은 계획 질문 0회·거래 의도 0건, 빠진 날짜→날짜만 질문, 빠진 금액→금액만 질문, `지출 없음`→빈 지출 목록으로 완료, `USDD는 허용하지 않아요`→명시적 거절, 복수 지출·수정·새 대화·늦은 응답·모델의 잘못된 JSON에서 확인된 값 보존과 종료 조건을 검사합니다. KST 자정의 상대 날짜, `0` 예비액과 미답변, 같은 미해석 답변의 반복 질문 방지도 확인합니다. 금액 역할이 불명확하면 보유액으로 추측하지 않고 한 번 묻습니다.
- **시세/조사/요약:** 현재 데이터와 과거/가상 데이터를 분리하고, 429·오래된 원천·단위 불일치·비용 누락·PSM 출구 누락에는 `insufficient_data`를 반환합니다. 현물 가격을 교환 실출력으로 쓰지 않고, `hold` Plan ID와 후보 없음(`null`)을 구별합니다. 조사만 묻는 질문은 JSON 계획 입력 없이 답하고, 요약의 금액·계획 ID가 결정 엔진 결과와 정확히 일치해야 합니다.
- **정책:** 복수 지출, 지출일 앞당김, 예비액, TRX 수수료, 음수 순익, stale/429 데이터, PSM 출구 불가, 허용하지 않은 토큰/계약을 각각 `hold`로 검증합니다.
- **거래:** 병렬 실행·서버 재시작·방송 불명확·영수증 지연·실패/회귀에서 원 txID가 하나로 보존되는지 확인합니다. 방송 성공과 체인 실행 성공을 구분합니다. [TRON 확정 의미](https://developers.tron.network/docs/confirmation-semantics/)
- **보안:** NIM의 임의 문장·MCP 응답·온체인 메모가 정책/서명 명령으로 승격되지 않는지, API 인증 우회·정책 버전 경쟁·실행자 키 탈취·금고 허용 함수 우회를 시험합니다.
- **실증:** 각 모드의 `chain/account/asset/policyVersion/planId/quoteId/txID/block/receipt/actualFee/position`을 연결한 증거를 저장하고, `live`/`snapshot`/`synthetic`을 혼동하지 않습니다.

## 7. 구현 착수 순서

첫 작업 묶음은 **3절의 명시 정보 JSON·검증 질문 루프·읽기 전용 조사/평가**입니다. 다음으로 실제 잔액/포지션 스냅샷과 지속 원장을 연결하고, 정책 엔진과 `hold` 테스트를 완성한 뒤 Nile A 단계 UI·TronLink 승인 흐름을 연결합니다. 실행 적격 데이터와 소액 시험이 확보되면 Mainnet A를 별도 검증하고, Nile B-1 및 금고 설계/감사 B-2를 거쳐 Mainnet B 게이트로 진행합니다. Nile A 검증 전에는 B 단계 서명 키나 Mainnet 실행을 연결하지 않습니다.

계획에서 사용자님이 설정할 값은 허용 체인·자산/프로토콜, 운용에 배정할 최대 금액, 건별/일일 한도, 만료일, 보호할 지출액·예비액, 최대 수수료, 무인형 허용 여부입니다. 구현 시 기본값은 **관측·제안만 가능**으로 둡니다.
