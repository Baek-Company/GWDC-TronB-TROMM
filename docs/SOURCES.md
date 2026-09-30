# 공식 출처와 데이터 규칙

확인일: 2026-09-28. 계약·상품·보상 조건은 변할 수 있으므로 실제 실행 구현 시 다시 확인합니다.

| 출처 | 용도 | 현재 상태 |
| --- | --- | --- |
| [TRON 개발 문서](https://developers.tron.network/) | 주소, 거래, Bandwidth/Energy | 검토 |
| [네트워크](https://developers.tron.network/docs/networks) | Mainnet/Nile 구분 | Nile RPC 검사 코드 |
| [지갑 연동](https://developers.tron.network/docs/tronlink-integration) | TronLink provider와 연결 | 현대 API, 이전 API 호환 연결 |
| [JustLend API](https://docs.justlend.org/developers/apis/) | 시장과 포지션 조회 | `/lend/jtoken` 실제 연결 |
| [JustLend 배포 주소](https://docs.justlend.org/developers/deployed_contracts/) | proxy, active/legacy, Nile 가용성 | 실행 시 재검증 |
| [JustLend V2](https://docs.justlend.org/developers/justlend_v2/) | 격리 시장, Vault | 문서상 Nile Vault 미배포, V2 REST는 Mainnet |
| [USDD 문서](https://docs.usdd.io/) | USDD 구조와 참여 조건 | 문서 준비; 상품 어댑터 미구현 |
| [USDD Savings](https://docs.usdd.io/user-guide/usdd-savings) | sUSDD 참여 흐름 | 문서 예시는 Ethereum/BNB; TRON 지원을 가정하지 않음 |
| [USDD 배포 주소](https://docs.usdd.io/developers/deployment-addresses) | 네트워크별 계약 | 현재 문서·토큰 API·탐색기를 교차 검증할 것 |
| [USDD Earn](https://app.usdd.io/earn) | 수익 상품 후보와 참여 조건 | JS 앱; 실제 상품/조건을 발표 후 확인 |
| [GasFree](https://docs.gasfree.io/) | 선택적 토큰 전송 경로 | B 공통 개발 범위에 포함하지 않음 |

## 연결된 데이터

`GET https://openapi.just.network/lend/jtoken`은 인증 없는 읽기 API입니다.
V1 성공 코드는 `0`이고 V2는 `200`입니다. HTTP 상태만 검사하지 않습니다.
이 프로젝트는 V1 시장 응답을 Zod로 검사하며 예상하지 못한 형식은 오류로 처리합니다.
`supplyRate`와 `borrowRate`는 연율의 소수 표현입니다. 표시할 때 100을 곱합니다.
금액은 이미 원자산 단위로 변환된 문자열이므로 화면에서 decimals를 다시 적용하지 않습니다.
온체인 입력은 반대로 자산 decimals를 적용해야 하며 `toBaseUnits`가 이를 검사합니다.

`supplyRate`에는 별도 인센티브가 포함되지 않습니다. 인센티브의 지급 자산, 자격,
만료일, 지급 주기, 수령 비용이 검증되지 않으면 추가 수익을 0으로 확정하지 않고 미확인으로 둡니다.
시장 목록에는 legacy가 포함될 수 있습니다. 거래 대상은 공식 계약 디렉터리에서 active 확인 후 선정합니다.

조회 시각은 `fetchedAt`이며 원천 갱신 시각이 미제공이면 `sourceUpdatedAt: null`을 유지합니다.
테스트넷 잔고/실행 결과와 Mainnet APY를 하나의 실제 포트폴리오 실적으로 합치지 않습니다.
