# Agent Instructions

- 이 저장소는 agentic-task-kit 프로젝트의 실제 구현 저장소다.
- AXPM 구조상 설계, 계획, 운영 기록은 sibling PM 저장소 `../agentic-task-kit-axpm` 에서 관리하고 구현은 이 저장소에서 진행한다.
- 작업 시작 전에 `.axpm/connection.json` 을 읽고 현재 연결된 GitHub/Linear 정보를 확인한다.
- 구현 전에는 `../agentic-task-kit-axpm/agentic-task-kit/README.md`, `Architecture.md`, `DevelopmentPlan.md`, `Dashboard.md` 를 먼저 검토한다.
- 개발 방식은 분석 -> 설계 -> 구현 -> 테스트 -> 이행 순서를 따른다.
- 설계 변경, 사용자 요구사항 반영, 작업 근거는 PM 저장소에 우선 기록한다.
- 이 저장소에는 실행 코드, 테스트, 스택별 문서만 유지한다.
- 매 작업이 끝날 때마다 현재 작업 내용을 commit 하고 원격에 push 한다.
- Linear 연결이 필요한 경우 `.axpm/connection.json` 을 갱신하고 PM 저장소 문서에도 반영한다.
