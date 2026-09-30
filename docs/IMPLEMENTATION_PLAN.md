# LeeMir 통합 구현 계획

작성 기준: 2026-09-29 11:50 KST, `LeeMir` 작업 트리. 이 문서는 **남은 기능의 구현 계획**이며 기능 완료 보고가 아니다. 제출 목표 시각은 2026-09-30 12:00 KST다. 아래 시간 목표는 현재 시점부터 다시 잡은 팀 내부 목표이며 외부 연결·지갑·테스트 자산이 확인되기 전에는 달성을 보장하지 않는다.

## 1. 기준과 완료 범위

- 제품 목표·평가 항목은 최신 루트 `팀 저장소 루트의 PROJECT_PLAN.md`를 기준으로 하고, 이 폴더의 [`PROJECT_PLAN.md`](./PROJECT_PLAN.md)는 이전 사본으로 대조한다. 로컬 제출판의 **구현 순서와 P0/P1 경계**는 루트 `팀 저장소 루트의 IMPLEMENTATION_WORKFLOW.md`를 따른다. 따라서 사본에 기본 테스트 경로로 적힌 Nile 인출은 로컬 제출판에서 P1이다.
- 워크플로우의 “현재 폴더에는 코드가 없다”는 문장은 LeeMir에는 적용하지 않는다. 기존 React/Vite, Node HTTP API, Decimal/Zod/TronWeb, 테스트와 실행 스크립트를 확장한다.
- 사용자님이 제공한 [파이프라인 그림](https://github.com/user-attachments/assets/1d9f86f8-4040-4685-bdee-587ad0b8897d)의 모든 단계와 분기를 설계·검증 대상으로 삼는다. 대화 거절→재질문, 거래 전 재조회, 조건 변경→재평가도 포함한다. 그림의 SUN.io 풀과 TRON 스테이킹·투표는 문서의 제출 P0인 JustLend/USDD 비교에 없는 **추가 상품 소스**다. 실제 조회·정규화·적격성 판정까지 별도 단계로 포함하며, 검증되지 않은 상품을 실행 가능한 계획으로 노출하지 않는다.
- 제출 P0의 분석과 실행은 별개 사례다. **Mainnet:** 1,000 USDT, 30일, 7일 뒤 200 USDT 지출을 기준으로 jUSDT A, PSM→jUSDD B, 전액 보유를 비교한다. **Nile:** Nile 전용 jTRX 값과 지갑 잔고로 80/20 및 50/50 TRX 배분을 비교하고 한 계획의 예치·확정·같은 포지션 재조회를 수행한다. Mainnet 계획을 Nile 거래가 실행한 것처럼 연결하지 않는다.
- 로컬 웹과 loopback API만 실행한다. 키는 서버의 Git 제외 `.env.local`에 보관하고, 사용자 거래의 서명은 지갑에서 한다. DB, 클라우드 배포, 자동 매매는 범위 밖이다.

추가 소스의 구현 기준은 [TronWallet Adapter](https://developers.tron.network/docs/tronwallet-adapter), [JustLend MCP](https://docs.justlend.org/ai_support/mcp_server/), [USDD MCP](https://docs.usdd.io/ai-support/mcp-server), [TRON 스테이킹 API](https://developers.tron.network/docs/staking-apis), [SUN.io 조회 API](https://docs.sun.io/api/sun-io-api/)의 현재 공식 문서와 실제 응답이다. 패키지 버전·도구 목록·계약 주소는 구현 시 다시 확인한다.

## 2. 현재 구현과 선행 확인

현재 `src/main.tsx`/`src/overview.css`에는 사용자님이 마지막으로 선택한 밝은 UI의 개요·7일 달력·상단 탐색이 있다. `/needs`에는 **가상** 1,000 USDT·7일 뒤 200 USDT·운용 상한 800 USDT를 기준으로 한 단일 지출 입력과 유동성 미리보기가 있고, `/plans`에는 jUSDT/jUSDD 기본 APY를 활용한 **거래 불가** 카드가 있다. `/markets`에는 JustLend Mainnet 조회, `/connections`에는 TronLink 주소·Nile 최신 블록이 있다. `server/index.ts`는 조회 전용 GET 세 개만 제공한다. `shared/planning.ts`와 `shared/markets.ts`에는 Decimal 계산과 단위 변환이 있다. 입력은 새로고침 후 사라지고, 대화·요약 확인, 독립 USDD/PSM 데이터, 왕복 비용, 실제 거래와 성과 추적은 없다. 특히 현재 위험 성향은 입력값만 보존하고 적격성 계산에 적용하지 않는다.

| 기존 UI 영역 | 남은 연결 | 화면 완료 조건 |
| --- | --- | --- |
| 개요·7일 달력·`조건 입력하기` | 확인된 `UserNeeds`의 날짜별 지출·자산·모드와 연동 | 기본 1,000/200 값은 `가상 예시`로 보이고, 실제 입력/저장 상태와 혼동되지 않음 |
| 요구 분석 | 대화/직접 입력 → 누락 질문 → Zod 검증 → 요약 확인 | 복수 지출·기간·지급 자산·예비액·위험을 수정할 수 있고 확인 후에만 비교 시작 |
| 계획 비교 | Mainnet A/B/보유 및 별도 Nile 80/20·50/50 | 각 카드에 같은 기준 자산의 비용·출구·위험·출처·제외 이유를 표시; 선택한 Nile 계획만 거래 화면으로 이동 |
| 시장 데이터·연결 상태 | JustLend/USDD/추가 소스의 개별 연결 상태, 정확한 체인·잔고 | 조회 실패/지연/키 미설정/자산 불일치를 분리하고 오래된 값을 라이브로 표시하지 않음 |
| 거래·검토(추가 화면) | 거래 미리보기·명시 확인·서명·txID 상태·포지션 관측 | 확인마다 원 거래와 계획 ID 연결, 새로고침 복원, 예상/실제 구분 |

첫 기술 게이트에서 다음을 읽기 전용으로 확인하고 결과를 `doctor`에 남긴다.

1. 공식 JustLend/USDD MCP의 실행 버전, 시작 부작용, `tools/list`, 필요한 읽기 도구의 입력·출력 스키마와 체인 지원. 앱 서버는 읽기 도구만 허용 목록으로 연결하고 쓰기·지갑 도구는 노출하지 않는다. IDE에 등록된 MCP만으로 앱 연결 완료로 세지 않는다. JustLend MCP의 브라우저 지갑 브리지는 현재 비활성 상태이므로 사용자 서명은 TronLink에 남긴다. [JustLend MCP](https://docs.justlend.org/ai_support/mcp_server/), [USDD MCP](https://docs.usdd.io/ai-support/mcp-server)
2. **USDD 경로의 토큰 호환성:** 현재 [JustLend jUSDD 기초자산](https://docs.justlend.org/developers/deployed_contracts/)과 [USDD TRON 배포 문서 원문](https://docs.usdd.io/developers/deployment-addresses.md)은 모두 `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`를 연결 후보로 기록한다. 검색 색인에는 오래된 주소가 남아 있을 수 있으므로 정적 주소의 일치만으로 PSM→jUSDD 직결을 확정하지 않는다. jUSDD `underlying()`과 PSM의 현재 출력 토큰·방향별 가용량을 온체인 및 실제 MCP 응답에서 읽고 비교한다. 다르면 검증된 변환 경로와 왕복 비용을 추가하기 전까지 B를 `토큰 불일치·실행 불가`로 표시한다.
3. Nile 지갑·테스트 TRX, jTRX 후보 주소·체인 코드·ABI·활성 상태, Nile 금리·환율·잔고 읽기, 예치 비용 추정. [JustLend MCP 최신 체인 설정](https://github.com/justlend/mcp-server-justlend/blob/main/src/core/chains.ts)은 Nile jTRX 후보를 `TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq`로 기록하지만 [배포 목록](https://docs.justlend.org/developers/deployed_contracts/)과 범위가 다르다. 주소를 하드코딩하기 전에 Nile RPC에서 계약 코드·시장 활성·메서드·잔고를 확인한다. Mainnet jTRX 주소를 Nile에서 사용하지 않는다. 일부 읽기가 성공해도 잔고·비용·계약 상태가 확인되기 전에는 거래 적격으로 선언하지 않는다.
   - [JustLend Nile 토큰 설정](https://github.com/justlend/mcp-server-justlend/blob/main/src/core/chains.ts)과 [USDD Nile 토큰 설정](https://github.com/decentralized-usd/mcp-server-usdd/blob/master/src/core/chains.ts)은 USDT/USDD 주소가 다르다. 따라서 Nile에서 USDD PSM→jUSDD 교차 경로를 기본 시연으로 만들지 않는다. 별도 온체인 호환성 증거가 있기 전에는 Nile jTRX만 실행한다.
4. NIM 모델 ID와 서버 키, TronGrid 키, 공식 데이터 응답의 실제 모양. 누락된 키는 `미설정`으로 표시하고 키 값을 출력하지 않는다. 키가 없어도 정해진 질문·계산은 작동하지만 실제 AI 연동 완료로 세지 않는다.

| 연결 | 키 판단 | 계획에 미치는 영향 |
| --- | --- | --- |
| [JustLend 공개 REST](https://docs.justlend.org/developers/apis/) | 기본 GET은 API 키 없이 사용 | 현재 Mainnet 시장 조회 유지. 공개 API 성공만으로 MCP·포지션·실거래 완료로 세지 않음 |
| [JustLend MCP](https://docs.justlend.org/ai_support/mcp_server/) | 로컬 stdio 읽기는 앱용 키 불필요; HTTP로 띄우면 자체 `MCP_API_KEY` 필요. Mainnet 안정성을 위해 TronGrid 키 권장 | 도구 목록/읽기 호출을 실제 앱 서버에서 확인. agent-wallet 서명 기능은 사용하지 않음 |
| [USDD MCP](https://docs.usdd.io/ai-support/mcp-server) | PSM 읽기 자체에 별도 USDD API 키가 명시되지는 않음; 시작 시 로컬 지갑 생성 가능성 확인 필요 | 안전한 읽기 연결이 안 되면 직접 읽기로 제한하고 MCP 항목은 미완료로 기록 |
| [NVIDIA NIM](https://docs.api.nvidia.com/nim/reference/llm-apis) | 호스팅 모델 호출에 서버측 `NVIDIA_API_KEY` 필요 | 미설정이면 질문 템플릿과 결정적 계산만 제공; 모델 ID는 실제 카탈로그/응답으로 선택 |
| [TronGrid](https://developers.tron.network/reference/select-network)·[SUN.io](https://docs.sun.io/api/sun-io-api/) | TronGrid 키는 신뢰성 있는 Mainnet 조회에 권장; SUN.io 저빈도 공개 읽기는 키 없이 시작 가능 | 각 연결의 실제 한도·Nile 정책은 요청 결과로 진단; 값이나 한도는 임의 추정하지 않음 |

## 3. 공통 데이터·상태 계약

`shared/schemas.ts`에 Zod 타입을 두고 UI·API·계산·기록에 공통 사용한다.

| 타입 | 필수 필드·규칙 |
| --- | --- |
| `UserNeeds` | 체인·시작 자산·문자열 금액·시작/종료일·날짜/금액/지급 자산별 지출·추가 여유액·위험 성향·USDD 위험 수용 여부·시간대·입력 버전·확인 버전 |
| `ProductQuote` | 상품/계약·입출구 토큰 **주소와 단위**·체인·기본 APY/APR·조건부 보상·유동성·전환 용량·출금 지연·비용 원자료·정밀도·활성 상태·데이터 출처/시각/모드 |
| `Plan` | 입력/quote 버전·배분·진입/출구 단계·기본 수익·검증된 보상·왕복 비용·순수익 또는 산정 불가·손익분기 기간·위험·적격성/제외 이유 |
| `ActionPreview` | 선택 Plan ID·지갑·체인·자산·최소 단위 금액·계약/메서드·승인 범위·비용 예상/상한·유효 시각·위험 |
| `ExecutionRecord` | Plan/Preview ID·원 txID·서명/제출/대기/확정/실패/거절/불명 상태·영수증·실제 비용·시각 |
| `Observation` | 같은 Plan/포지션 ID·체인 잔고·환율·기초자산 가치·관측 시각·출처·실데이터/과거/가상 표시 |

외부 관측마다 `sourceUrl`, `chain`, `fetchedAt`, 가능한 `sourceUpdatedAt`, `mode: live | snapshot | synthetic`을 보존한다. MCP 호출이면 `accessMethod`, 서버 ID·도구명·버전도 기록한다. 금액은 문자열+Decimal, 온체인 최소 단위는 BigInt로 처리한다. `미확인` 보상·비용을 0으로 바꾸지 않는다. KST로 날짜를 해석하고 시각은 ISO로 저장한다.

대화 상태는 `collecting → awaiting_confirmation → confirmed → comparing`이다. 확인 거절은 `collecting`으로 돌아간다. 입력을 수정하면 확인과 계획 선택을 무효화한다. 거래 상태는 `preview → awaiting_signature → submitted → pending → confirmed | failed`이며, 거절은 `rejected`, 방송 여부가 모호하면 `unknown`이다. `pending`/`unknown`에서는 같은 txID를 조회하고 자동 재서명하지 않는다.

API는 기존 Node HTTP 서버를 확장한다. `POST /api/chat`은 텍스트와 현재 입력 버전만 받아 검증된 추출값·다음 질문을 반환한다. `POST /api/plans`는 확인 버전과 서버 측 새 견적을 묶어 분석 결과를 반환한다. `POST /api/preview`는 **Nile 계획**의 최신 비용·자산·계약만 읽어 서명 전 미리보기를 만든다. `GET /api/transactions/:txId`와 `GET /api/observe`는 원 거래/동일 포지션을 조회한다. `GET /api/capabilities`는 데이터·모델·지갑·체인의 사용 가능 상태만 제공한다. POST는 요청 크기 제한·같은 출처 검사·Zod 검증을 적용하고, 브라우저에 API 키를 반환하지 않는다. 서버는 사용자 개인키를 저장하거나 대신 서명하지 않는다.

`ActionPreview`는 서명 전 재조회값의 **체인·계정·토큰/계약 주소·정밀도·금액·시장 활성·출구 가용량·잔고·예상/상한 비용·금리·환율·요구 버전**으로 입력 지문을 계산한다. 조회 시각만 바뀌고 이 값들이 같으면 미리보기를 유지한다. 하나라도 달라지거나 견적이 만료되면 기존 확인을 취소하고 계획/미리보기를 새로 만들어 변경 내용을 보여준 뒤 다시 확인받는다. 잔고나 수수료 재원이 부족해진 경우에는 재확인 전에 실행을 막는다.

## 4. 파이프라인별 구현 작업

| 단계 | 구현 방법과 주요 파일 | 통과 조건 |
| --- | --- | --- |
| 대화·누락 질문·Zod | `server/llm/{provider,nim,template}.ts`, `/api/chat`, `src/features/conversation`, `shared/schemas.ts`. NIM은 추출과 검증된 결과 설명만 담당한다. 모델의 `needsPatch`를 Zod로 검사하고 누락·모순 질문은 코드가 정한다. 형식 오류는 1회 보정 후 템플릿으로 전환한다. | 자유 입력 3종, 누락 날짜·금액 질문, 요약 확인, 입력 변경 시 확인 무효화. 키가 없으면 템플릿을 명시하고 AI 완료로 주장하지 않는다. |
| 지갑·잔고 | 공식 TronWallet Adapter의 TronLink 구현을 현재 `src/wallet.ts` 경계에 적용하고 계정·네트워크 변경을 감지한다. 공개 주소로 해당 체인 잔고를 조회한다. | 주소, 정확한 Mainnet/Nile 구분, 사용 가능 잔고와 TRX 비용 재원 표시. 연결·거절·계정/체인 변경 처리. |
| 공식 상품 조회 | `server/mcp/{clients,registry}.ts`, `server/data/{justlend,usdd,tron-rpc,staking,sun}.ts`. JustLend/USDD 공식 MCP의 읽기 도구를 우선 검증하고 부족한 값만 직접 API/RPC로 보완한다. TronGrid MCP 확장은 P1이며 Nile은 검증된 RPC를 유지한다. | 실제 읽기 호출, 스키마·단위·체인·신선도 검증, 출처 표시. [USDD MCP](https://docs.usdd.io/ai-support/mcp-server)는 시작할 때 지갑을 자동 생성할 수 있으므로 **격리된 경로에서 부작용을 먼저 확인**한다. 안전하게 시작할 수 없으면 이 앱에서는 필요한 읽기만 직접 구현하고 MCP 미연결을 명시한다. |
| 상품 어댑터 | 각 소스를 동일한 `ProductQuote`로 정규화한다. JustLend 기본 금리와 보상, USDD PSM 양방향 전환, TRON Stake 2.0/투표의 보상·해제 지연, SUN.io 안정화폐 풀의 수수료·풀 유동성·LP 회수 조건을 각각 분리한다. | 모든 소스가 실제 읽기값 또는 구체적 `unavailable` 이유를 반환한다. 원천 값이 부족한 상품은 수익·출구를 추측하지 않는다. |
| 위험·지출일·신선도 판정 | `shared/eligibility.ts`, `shared/planning.ts`. 검증된 회수 경로가 없는 모든 예정 지출과 추가 여유액은 처음부터 보호한다. 위험 허용, 자산 전환, 시장 활성, PSM 왕복 물량, 풀/시장 출구 유동성, 해제 지연, 데이터 만료를 검사한다. | 부적합 경로는 가격 위험·출금 지연·자료 부족 등 정확한 이유를 보여준다. 현재 가정 계산에서 7일·45일 뒤 200 USDT 지출 모두 전 기간 운용 상한은 800 USDT다. 날짜별 회수 경로가 검증될 때만 추가 배분을 별도로 평가한다. |
| 수익·계획 비교 | Decimal 계산으로 APY와 APR을 구분하고 기본 수익·조건부 보상·승인/전환/예치/인출/청구 비용·TRX→USDT 환산 시각·손익분기 기간을 구한다. A/B/보유와 최고 APY만 고른 결과를 비교한다. USDD 환율 변동·PSM 출구 제한의 별도 시나리오를 둔다. | 동일 원금·기간의 순익/위험 표. 비용 또는 환산 근거가 없으면 순익·순위·실행 권고 보류. 비용이 수익보다 크면 보유 권고. B의 이자는 jUSDD에서만 계산한다. |
| 계획 선택·거래 확인 | `src/features/execution`, `/api/plans`. Mainnet A/B는 조건부 분석으로 표시한다. Nile은 실제 Nile quote와 잔고로 별도 Plan ID를 만든다. 거절하면 비교 화면으로 돌아간다. | 각 거래에 체인·자산·금액·계약·승인 범위·예상/상한 비용·출구 위험을 보여주고 확인받는다. 계획/지갑/quote가 바뀌면 미리보기 무효화. |
| Nile 단일 경로 실행 | TronWeb으로 검증한 네이티브 TRX→jTRX 호출을 구성하고 TronLink에 단발 서명 요청. 서명 직전 잔고·체인·계정·계약 코드/시장·비용·출구 유동성을 다시 읽는다. 거래별 사용자 확인과 지갑 확인을 분리한다. | 선택한 Nile Plan ID와 거래 자산/체인이 일치한다. 원 txID를 즉시 보존하고 [확정 거래·계약 영수증](https://developers.tron.network/docs/api-signature-and-broadcast-flow)의 성공 결과를 확인한 뒤 같은 jTRX 잔고·환율을 재조회한다. 미확정/모호 상태에서는 재방송하지 않는다. |
| 추적·재평가 | `src/features/review`, `src/lib/storage.ts`, `/api/observe`, `/api/transactions/:txId`. 버전 있는 localStorage에 원계획·quote·가정·txID·관측을 보존하고 JSON으로 내보낸다. 지출은 투자 성과와 별도 현금흐름으로 둔다. | 새로고침 후 기록 복원·실제 영수증/포지션 재조회. 같은 자산·체인·기간일 때만 예상/실제 차이 계산. 지출일·금리·위험 변화 시 새 계획과 조정 비용을 제시하고 별도 승인 전에는 실행하지 않는다. |

## 5. 작업 순서와 통합 게이트

1. **공통 계약·첫 기술 게이트:** 기존 의존성/스크립트를 유지하며 schema·fixture·Nile 사전 검증을 고정한다. `GET /api/health`와 `doctor`가 외부 연결을 성공/실패/미확인으로 구분한다.
2. **병렬 작업:** (가) 대화·NIM·화면, (나) JustLend/USDD MCP·데이터, (다) 계산·적격성·기록, (라) Nile 지갑·계약·실행을 공통 fixture에 맞춰 진행한다. Nile의 Plan→거래→관측 연결을 첫 통합 증거로 확보한다.
3. **Mainnet 비교 통합:** `/api/plans`는 서버가 조회한 quote와 확인된 입력만 사용한다. jUSDT A, PSM→jUSDD B, 보유를 표시한다. PSM 양방향 물량·비용을 검증하지 못하면 B는 `현재 실행 불가`로 남긴다. 적격인 다른 JustLend 배분안을 추가하더라도 USDD 통합을 완료로 세지 않는다.
4. **파이프라인 추가 소스 통합:** 제출 P0의 Nile 거래와 Mainnet A/B 비용·출구 증거를 먼저 확보한 뒤 TRON 스테이킹·투표와 SUN.io 풀을 실제 읽기 어댑터와 적격성 분기에 연결한다. 별도 담당이 선행 조사·읽기 구현을 병렬로 진행할 수 있지만 P0 통합을 막지 않는다. 현재 USDT 사례와 동일 자산으로 진입·회수할 견적이나 출금 조건이 없으면 제외 사유를 표시한다. 이 소스의 Mainnet 거래를 Nile jTRX 실행 증거로 대체하지 않는다.
5. **검토·발표 통합:** 원계획과 실측을 구분하고 3분 시연의 각 화면, 실패·보류 화면, 데이터 출처를 고정한다. 문서·README에는 완료/부분 구현을 실제 검증 결과대로 기록한다.

### 필수 판단 게이트

- PSM 양방향 전환 가능량·비용, jUSDD 활성 여부 또는 USDD 위험 수용이 부족하면 B를 실행 가능한 두 번째 계획으로 세지 않는다. 다른 적격 계획도 없으면 두 계획 기준은 미달로 표시한다.
- TRX 수수료 잔고, 서명 직전 가격/비용, 계약 코드, Nile 지갑/시장 상태가 부족하면 실행 버튼을 비활성화한다. 80 TRX 예치는 비용 확보 전의 예시 금액이다.
- 실제 지갑·테스트 TRX가 없으면 코드/모의 검증만 완료로 표시한다. 실제 txID·영수증·포지션 재조회 증거는 만들어 내지 않는다.
- `snapshot`/`synthetic`은 실거래 적격성과 현재 수익률에 사용하지 않는다. 지연된 거래는 `대기 중`으로 남긴다.

## 6. 검증과 제출 증거

- 단위 테스트: Decimal/BigInt 정밀도, 7일→45일 지출, 지출 초과와 여유액 중복 방지, APR/APY, 미확인 보상, 왕복 비용·TRX 환산·손익분기, 음수 순익/보유, 위험 거부, 비활성 시장, PSM 부족, SUN 풀 출구 부족, 스테이킹 해제 지연, 체인/자산 불일치.
- 통합 테스트: NIM 정상/키 오류/형식 오류/타임아웃, MCP 초기화/도구 발견/읽기/스키마 오류/제한된 직접 fallback, 입력 확인 무효화, 지갑 거부·네트워크 전환, 미리보기 만료, txID `pending`/`unknown` 재조회 및 중복 서명 방지, 같은 Nile 포지션 관측.
- 로컬 검증: `./scripts/run run check`, `./scripts/run run doctor`, 실제 브라우저의 입력→확인→비교→Nile 선택·거래 확인→검토와 콘솔 오류 점검. NIM/공식 MCP/실제 Nile 거래는 해당 키·연결·지갑·테스트 자산이 있을 때 각각 별도로 확인한다.
- 증거: 공식 출처와 조회 시각, 같은 입력의 A/B/보유 비교, 최고 APY 기준과 다른 이유, 거래 보류 사례, 실제 Nile 원 txID·확정 영수증·실제 비용·동일 포지션 재조회, 새 계획/조정 제안, 실데이터/과거/가상 배지, 평가 항목별 충족·부분 구현 표, 3분 시연 자료.

**제출 P0 완료**는 누락 질문·확인, Mainnet에서 검증된 비용/출구를 포함한 **실행 가능 계획 두 개와 보유 기준선**, 날짜 변경·비용 초과 판정, 그리고 **별도 Nile 한 경로**의 실제 예치·확정·재조회를 뜻한다. B가 제외되면 다른 적격 대안이 실제로 검증되지 않는 한 두 계획 기준은 미달이다. Nile 인출, 최소 운용액 탐색, JSON 가져오기, 장기 재생, 모델의 MCP 도구 선택, TronGrid MCP 확대는 P1이다.

**그림까지 포함한 통합 완료**는 추가로 TRON 스테이킹·투표와 SUN.io 소스의 실제 읽기·정규화·판정, 제외 이유 표시, 조건 변화에 따른 재평가까지 확인해야 선언한다. 외부 서비스 장애나 데이터 부족으로 이 검증이 끝나지 않으면 완료가 아니라 부분 구현으로 기록한다. Mainnet A/B의 실제 실행은 이 로컬 제출판 범위 밖이며, 두 문서가 요구하듯 평가상 부분 구현으로 표시한다.

## 7. 남은 작업의 실행 순서와 산출물

아래 상태는 이 문서 작성 시점의 코드 기준이다. `P0`는 제출 목표, `전체`는 파이프라인 그림의 모든 상품 소스와 분기, `P1`은 루트 워크플로우의 후속 범위다. `P0`라도 외부 계약·지갑·키의 필수 검증이 실패하면 완료 표시 대신 구체적 제한을 기록한다.

| ID·우선순위 | 선행 조건 | 구체 작업과 산출물 | 완료 증거 |
| --- | --- | --- | --- |
| G0 · P0 기술 게이트 | 현재 저장소·공식 문서 | 현재 JustLend 시장/Nile 블록/TronGrid 설정만 검사하는 `scripts/doctor.ts`를 확장한다. NIM/TronGrid 설정 여부, JustLend·USDD MCP 읽기 도구/시작 부작용, PSM 양방향 상태, Nile jTRX 코드·시장·지갑/잔고·수수료 재원을 각각 검사하고 `checkId/status/reason/source/chain/checkedAt` 구조로 기록한다. 실패 사유만 출력하고 비밀값은 출력하지 않는다 | 각 항목 `ready/unavailable/unknown` 및 근거. 부분 성공을 전체 준비 완료로 합치지 않고 Nile 거래 가능 판단은 실체인 읽기값으로 확인 |
| G1 · P0 데이터 계약 | G0과 병렬 | `shared/schemas.ts`·고정 fixture. 기존 `Profile`/`profileSchema`를 하나의 `UserNeeds`로 연결하고 UI/API 응답을 런타임 Zod 검증. `Plan`/`ActionPreview`에 입력·견적 해시 또는 버전 고정 | 잘못된 자산·체인·날짜·단위·주소와 오래된 입력 버전이 API 경계에서 거절 |
| G2 · P0 요구 수집 | G1 | `/needs`를 복수 지출 직접 입력과 자연어 대화의 같은 상태로 연결. 누락·모순 질문, 요약 확인/거절/수정, NIM 추출+템플릿 대체 구현 | “1,000 USDT, 30일” 입력 후 지출·위험 질문; 확인 전 계획 잠금; 수정 시 재확인 |
| G3 · P0 상품 근거 | G0·G1 | 기존 JustLend REST를 유지하면서 실제 JustLend/USDD MCP 읽기 호출과 직접 API/RPC 보완, PSM 왕복 견적, 인센티브 조건, 비용·TRX 환율 출처를 `ProductQuote`로 정규화 | A와 B가 각자 독립 출처를 사용; PSM 토큰·입구·출구·물량·비용이 없으면 B는 제외 |
| G4 · P0 계획 엔진 | G1·G3; Nile 부분은 G0·G1 | 복수 지출·여유액의 현금흐름, 위험/시장/출구/신선도 판정, 기본 이자와 보상·왕복 비용 분리, 순익·손익분기·보유 기준선. 별도 Nile 80/20·50/50 생성 | 7일 지출→800, 운용 종료 뒤 지출→1,000(비용 전)처럼 조건 변화가 설명과 숫자에 반영; 음수 순익이면 보유 |
| G5 · P0 비교 UI | G2·G3·G4 | 새 밝은 UI 틀에서 `/plans`를 실계산 카드/표로 바꾸고 `근거·조회 시각·가상/실제·제외 이유` 표시. `/markets`와 `/connections`의 오류 상태 보강 | 같은 자산·기간의 A/B/보유 비교, 별도 Nile 선택, 불가 경로 선택 금지; 모바일·데스크톱 확인 |
| G6 · P0 Nile 실행 | G0의 Nile 준비·G1·G4 | 지갑 체인/계정 이벤트, Plan ID 고정, 직전 재조회, 미리보기·사용자 확인, TronLink 단일 서명, txID 저장, 확정 영수증과 jTRX 포지션 재조회 | **같은 Nile 계획·자산·계정**의 선택→서명→원 txID→solidified 결과→잔고/환율 관측 1건. 거절/실패/미확정 별도 |
| G7 · P0 기록·재평가 | G4·G6 | 버전 있는 `localStorage`, JSON 내보내기, 거래 상태 복원, 실제 비용/보상/포지션과 원계획 비교, 새 지출·금리·위험의 조정 제안 | 새로고침 뒤 원계획·txID 복원; 같은 자산·체인만 예상/실제 비교; 조정은 별도 승인 전 미실행 |
| G8 · 전체 상품 소스 | G1·G3·G4 | SUN.io 안정화폐 풀, Stake 2.0/투표의 실제 읽기 어댑터. 진입·회수 자산/비용·유동성·해제 지연을 공통 스키마로 연결 | 각 소스가 신선한 견적 또는 구체적 제외 이유를 반환; 미검증 상품 실행 금지 |
| G9 · P1 확장 | G6·G7 안정화 | Nile 인출, 최소 운용액 탐색, Zod 검증 JSON 가져오기, 명시적 과거/가상 장기 재생, TronGrid MCP, NIM의 **읽기 전용** 도구 선택 | 인출도 별도 확인·확정·동일 포지션 재조회. 재생/실거래 혼동 없음. 도구 허용 목록 밖 호출 거절 |
| G10 · 제출 이후 평가 격차 해소 | G3·G4·G6·G7 | Mainnet A 또는 B의 선택 계획을 **같은 Mainnet 자산·계정**에서 실제 실행하는 별도 흐름. TRC20은 필요한 승인과 예치를 각각 확인하며, B는 PSM 양방향·jUSDD 기초자산·추가 변환을 검증한 경우에만 사용 | 해당 Mainnet Plan ID에 연결된 승인·예치/전환 txID, 확정 영수증, 같은 포지션 재조회. 자발적인 Mainnet 자산과 거래별 명시 승인이 있을 때만 실제 검증 |

통합 순서는 `G0+G1`을 즉시 시작하고, `G2·G3·G4·G6`을 병렬로 진행한다. `G6`은 Mainnet A/B 완성을 기다리지 않는다. `G5·G7`은 산출물이 생기는 즉시 연결한다. `G8·G9`는 P0 증거를 해치지 않는 단계에서 진행한다. 코드 변경은 기존 `server/index.ts`, `src/main.tsx`를 점진 분리하고 공통 타입을 우선 사용한다. 현재 미커밋인 밝은 UI와 이미지 자산은 보존한다.

## 8. 담당과 통합 경계

| 담당 | 우선 소유 | 다른 담당에게 먼저 넘길 계약 |
| --- | --- | --- |
| ① UX·AI·통합 | G1 스키마 취합, G2·G5, `server/index.ts` 경로/화면 통합 | `UserNeeds` 확인 버전, 대화 결과와 오류 상태, 계획 화면의 입력 규격 |
| ② 데이터·비용 | G0의 MCP/PSM, G3, G8 데이터 어댑터 | 체인·주소·단위·시각·출처·모드가 있는 `ProductQuote`/비용 견적 |
| ③ 계획·검토 | G4·G7, G9 최소 금액/재생 | 결정적 `Plan`/`Observation`, 제외 이유, 원계획 대조 규칙 |
| ④ 지갑·실행 | G0의 Nile 계약/잔고, G6, G9 인출 | Nile 전용 `ActionPreview`와 `ExecutionRecord`, 거래별 확정 증거 |

①이 공유 스키마 변경과 기존 API 서버 통합을 조정한다. ③·④는 **같은 Nile Plan ID**를 먼저 맞춘다. ②가 PSM을 검증하지 못해도 ③·④의 Nile 수직 흐름은 진행한다. 각 담당은 본인 결과가 실패했을 때 화면에 전달할 이유와 재시도 조건을 함께 정의한다.

## 9. 제출 전 일정 재기준화

루트 `PROJECT_PLAN.md`의 9월 29일 05:00·09:00 게이트는 이미 지났다. 아래는 **2026-09-29 약 12:00 KST부터**의 목표이며, 외부 연결이 실패하면 해당 기능의 `미확인/부분 구현`을 즉시 확정해 남은 검증 시간을 보호한다.

| 목표 시각(KST) | 통합 게이트와 결정 |
| --- | --- |
| 9/29 14:00 | G0 결과, 제출 형식·테스트 지갑·Nile TRX·jTRX 시장 읽기, PSM 양방향과 키 상태 확정. 불가능한 경로와 담당 기록 |
| 9/29 17:00 | G1 공통 fixture/API 계약, G2 확인 흐름, G4 Nile 계획 계산 연결. ④의 사전 호출/비용 추정 확인 |
| 9/29 21:00 | G6 Nile 예치의 실제 확정·동일 포지션 재조회 목표. 미달이면 원인/tx 상태를 보존하고 거래 성공 주장 금지 |
| 9/30 02:00 | G3·G4·G5 Mainnet A/B/보유 비교, 조건 변경·비용 초과·제외 사유의 브라우저 확인. G7 저장·검토 연결 |
| 9/30 07:00 | 전체 `check`/`doctor`, 실패/거절/미확정 사례, 실제·가상 구분, README·평가 기준 표·3분 시연 증거 확인 |
| 9/30 10:00 | 제출물 고정·업로드 목표. 12:00 마감까지 2시간은 장애 대응에 사용 |

SUN.io·Stake 2.0의 실제 상품 통합(G8), G9의 후속 기능, Mainnet 선택 계획의 거래 검증(G10)은 별도 완료 조건을 유지한다. 마감 전에 끝난 부분만 증거와 함께 제출하고, P0 완료 여부와 **그림 전체 완료 여부를 따로** 표시한다. G0에서 경로가 막히면 무리한 거래 대신 비교/실패 화면과 실제 검증 기록을 남긴다. G8·G9·G10의 제출 이후 완료 시각은 임의로 약속하지 않는다.

## 10. 최종 인수 체크리스트

- [ ] 입력 누락·거절·수정→재확인, 복수 지출과 위험 성향 적용, 가상 기본값 표시.
- [ ] JustLend와 USDD의 각각 실제 읽기·시각·체인·토큰 주소; B의 PSM 양방향/토큰 호환성/비용 확인 또는 정확한 제외 이유.
- [ ] 같은 기준의 A/B/보유 순익·출구/위험 비교; 최소 두 **실행 가능** 계획의 실증 여부. 두 번째가 부족하면 평가 기준 미달로 표시.
- [ ] 별도 Nile 계획의 체인·지갑·잔고·비용 검증, 사용자별 거래 확인, 원 txID·solidified 영수증·동일 jTRX 포지션 재조회.
- [ ] 새로고침 복원·JSON 내보내기·실제/가상 구분·원계획 대비 관측과 조건 변경의 재평가.
- [ ] SUN.io·Stake 2.0/투표의 실제 조회·정규화·적격성/제외 이유로 원본 그림의 추가 소스 완료 여부 판정.
- [ ] 제출 이후 Mainnet 선택 계획도 같은 Mainnet 자산으로 승인·실행·확정·관측해 평가 격차 해소 여부 판정.
- [ ] `./scripts/run run check`, `./scripts/run run doctor`, 브라우저 데스크톱/모바일 시연, README/제출 증거의 기능 상태가 서로 일치.
