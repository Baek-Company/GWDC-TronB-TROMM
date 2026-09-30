# LeeMir 앱: 비공개 팀 저장소 업로드 안내

이 폴더는 2026-09-30의 `TeamBaek/LeeMir` 작업 디렉터리에서 추출한 **앱 단독 스냅샷**입니다. 현재 미커밋 코드와 테스트를 포함하며, 원래 저장소의 Git 이력과 팀 공통 루트 문서는 포함하지 않습니다. 일부 앱 문서가 언급하는 팀 공통 계획 문서는 기존 팀 저장소에서 확인해 주세요.

## 포함·제외 범위

- 포함: `src/`, `server/`, `shared/`, `tests/`, `scripts/`, `data/`의 시연 입력, `docs/`의 설계·실증 문서, 설정 예시, `package-lock.json`.
- 제외: 실제 키가 들어 있는 `.env.local`, 의존성·빌드·QA 산출물, 임시 원장·스냅샷, 개인 로컬 경로, Git 이력.
- **비공개 저장소 전용:** 실증 문서에는 시험용 Nile 지갑 주소와 거래 ID가 있습니다. 공개 전환 시 관련 문서와 이미지를 별도로 검토해 주세요.

## 실행 확인

Node.js 24와 npm이 필요합니다. 폴더 안에서 다음을 실행하세요.

이 추출본에서 `./scripts/run ci` 설치와 `./scripts/run run check` 검증을 마쳤습니다. **64개 테스트 파일의 435개 테스트, TypeScript 검사, Vite 빌드가 통과**했습니다. 외부 API·지갑 연결과 실제 거래는 이 검증에 포함되지 않습니다.

```sh
npm ci
npm run check
npm run dev
```

macOS에서는 `./scripts/run ci`, `./scripts/run run check`, `./scripts/run run dev`도 사용할 수 있습니다. 브라우저는 `http://127.0.0.1:5173`, API 상태는 `http://127.0.0.1:8787/api/health`에서 확인합니다. 키가 필요한 기능은 `.env.example`을 복사해 **각자의 로컬** `.env.local`에 설정해야 합니다. 키를 Git에 추가하지 마세요.

## GitHub에 올리기

새 비공개 저장소를 사용할 경우, GitHub에서 README·라이선스 없이 빈 **Private** 저장소를 만든 다음 이 폴더에서 실행합니다.

```sh
git init -b main
git add .
git commit -m "Add LeeMir app snapshot"
git remote add origin <비공개_저장소_URL>
git push -u origin main
```

기존 팀 저장소에 올릴 경우에는 이 폴더의 내용을 팀 저장소의 `TeamBaek/LeeMir/`에 복사하고, 팀 저장소에서 작업 브랜치를 만든 뒤 해당 경로만 `git add`하여 Pull Request로 공유합니다. 팀 저장소의 루트 문서와 다른 팀원 폴더를 덮어쓰지 마세요.

`LICENSE` 파일은 이 추출본에 없습니다. 사용 조건은 팀에서 정해야 합니다.
