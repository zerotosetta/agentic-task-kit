# Release Guide

이 문서는 `agentic-task-kit` npm 릴리스를 만드는 표준 절차를 정리한다.
현재 기준 release source of truth 는 GitHub Actions workflow [`Publish npm package`](../.github/workflows/npm-publish.yml) 다.

## 준비 조건
- npm registry publish 권한이 있는 `NPM_AUTH_TOKEN` repository secret 이 설정되어 있어야 한다.
- default branch 는 `main` 이어야 한다.
- `package.json` 과 `package-lock.json` 은 workflow 가 자동으로 version bump 한다.
- release notes 의 source of truth 는 repository root [`CHANGELOG.md`](../CHANGELOG.md) 다.
- publish artifact 는 `.npm-package/` all-in-one bundle 이고, `dist/**/*.map` source map 은 제외된다.

## 권장 릴리스 경로
가장 권장되는 경로는 GitHub Actions `workflow_dispatch` 다.

### workflow_dispatch publish
1. GitHub repository 의 Actions 탭에서 `Publish npm package` workflow 를 연다.
2. `Run workflow` 를 선택한다.
3. 입력값을 정한다.
   - `version_bump`
     - 기본값: `patch`
     - 허용값: `patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`
   - `npm_tag`
     - 기본값: `latest`
   - `dry_run`
     - 검증만 할 때는 `true`
     - 실제 배포는 `false`
4. workflow 를 실행한다.

### workflow_dispatch actual publish 의 동작
- `main` branch 인지 확인한다.
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run release:prepare-version -- <version_bump>`
- `npm run release:update-changelog -- --version <next_version> --notes-file .release-notes.md`
- `npm run build:all-in-one`
- `npm pack ./.npm-package`
- `npm publish ./.npm-package --access public --tag <npm_tag>`
- 성공 시:
  - `CHANGELOG.md` 를 새 release section 으로 갱신
  - `package.json`, `package-lock.json`, `CHANGELOG.md` 를 release commit 으로 반영
  - `v<version>` tag 생성
  - branch 와 tag 를 origin 에 push
  - 같은 changelog section 으로 GitHub Release 생성 또는 갱신

## Tag publish 경로
`v*` tag push 도 publish trigger 로 지원한다.

이 경로는 다음 상황에만 사용한다.
- 이미 source version 이 bump 되어 있고
- 해당 version 에 맞는 `v<version>` tag 를 직접 push 하려는 경우

검증:
- workflow 는 tag 와 `package.json.version` 이 정확히 일치하는지 확인한다.

주의:
- `workflow_dispatch` actual publish 성공 후 workflow 가 만든 tag push run 은 중복 publish 를 피하기 위해 skip 된다.

## Dry-run 사용법
publish 전에 payload 와 gate 를 확인할 때는 `dry_run=true` 를 사용한다.

dry-run 에서는:
- preview version 만 계산하고 source file version 은 바꾸지 않음
- changelog preview 와 `.release-notes.md` 만 생성하고 `CHANGELOG.md` 는 쓰지 않음
- npm registry 업로드 하지 않음
- release commit / tag push 하지 않음

하지만 아래는 그대로 검증한다.
- install
- typecheck
- test
- preview changelog generation
- all-in-one bundle build
- `npm pack`
- `npm publish --dry-run`
- tarball contents 에 `.map` 파일이 없는지 확인

## 로컬 검증 명령
GitHub Actions 를 돌리기 전에 로컬에서 확인하려면:

```bash
npm ci
npm run typecheck
npm test
npm run build:all-in-one
npm run publish:all-in-one:dry-run
```

version bump 스크립트만 따로 확인하려면:

```bash
npm run release:prepare-version -- patch
```

preview version 만 확인하려면:

```bash
npm run release:prepare-version -- patch --preview-only
```

changelog 를 직접 갱신하려면:

```bash
npm run release:update-changelog -- --version 0.1.8
```

## 실패 시 확인 포인트
### 1. `E403 You cannot publish over the previously published versions`
원인:
- 이미 배포된 version 을 다시 publish 하려는 경우

대응:
- `workflow_dispatch` 에서 `version_bump` 를 사용한다.
- tag publish 라면 source version 과 tag 를 새 version 으로 올린다.

### 2. `NPM_AUTH_TOKEN` 인증 실패
원인:
- secret 누락
- secret 값이 publish 권한이 없는 token

대응:
- repository secret `NPM_AUTH_TOKEN` 재확인
- npm publish 권한이 있는 token 인지 확인

### 3. tag mismatch 실패
원인:
- `v1.2.3` tag 와 `package.json.version` 이 다름

대응:
- source version 을 tag 와 맞춘 뒤 다시 push

## 배포 후 확인
- npm registry 에 새 version 이 올라갔는지 확인
- `CHANGELOG.md` 에 새 version section 이 반영됐는지 확인
- GitHub release commit 이 `main` 에 반영됐는지 확인
- `v<version>` tag 가 origin 에 생성됐는지 확인
- GitHub Release body 가 changelog section 과 일치하는지 확인
- 필요하면 published consumer sample 로 smoke test

## 운영 원칙
- 일반 배포는 `workflow_dispatch` actual publish 를 기본값으로 사용한다.
- `dry_run=true` 를 먼저 한 번 돌리고 actual publish 를 실행하는 것이 안전하다.
- source version 과 registry version 이 어긋난 상태를 남기지 않는다.
