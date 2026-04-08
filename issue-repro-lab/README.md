# issue-repro-lab

`agentic-task-kit` open issue 를 수정 전에 재연하고 원인을 고정하기 위한 서브 프로젝트다.

## 대상 이슈
- `#4` 입력 프롬프트와 출력 길이 모니터링 누락
- `#14` 신규 Chat API content-part 입력 형식 미지원
- `#15` workflow context memory write 가 정상 반환되지만 일부 데이터가 적재되지 않는 것처럼 보이는 현상
- `#16` Ink workflow chart recursion 으로 인한 stack overflow
- `#17` workflow task error stack trace 미출력

## 실행
루트 저장소에서 의존성을 설치한 뒤 아래 명령을 사용한다.

```bash
cd /Users/fortrit/workspace/agentic-task-kit/.codex-worktrees/agentic-task-kit-main-6/issue-repro-lab
npm run repro:all
```

개별 재연:

```bash
npm run repro:issue-4
npm run repro:issue-14
npm run repro:issue-15
npm run repro:issue-16
npm run repro:issue-17
```

## 현재 메모
- `repro:*` 명령은 항상 먼저 상위 라이브러리 `dist/` 를 다시 빌드한다.
- issue `#16` 은 현재 public package surface 만으로는 renderer 내부 state cycle 을 직접 만들 수 없어서, 재연 스크립트가 내부 `src/ink-renderer.tsx` 와 `src/renderer-model.ts` 를 직접 사용한다.
- 나머지 이슈는 built package surface(`../../dist/index.js`) 기준으로 재연한다.
