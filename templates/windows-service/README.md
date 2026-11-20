# Windows용 ATK 세션 서비스

1. ZIP 파일의 압축을 쓰기 가능한 폴더에 모두 풉니다.
2. `start-atk.cmd`를 두 번 클릭합니다. 서비스가 실행되는 동안 콘솔 창을 열어 둡니다.
3. 같은 PC의 브라우저에서 [세션 대시보드](http://127.0.0.1:4317/)를 엽니다. 종료하려면 콘솔에서 Ctrl+C를 누릅니다.

ZIP에는 Windows x64용 Node.js 실행 파일이 포함되어 있어 별도 설치 없이 실행할 수 있습니다.

## MCP 연결

클라이언트에서 Streamable HTTP 주소를 `http://127.0.0.1:4317/mcp`로 설정합니다. 인증에는 `Authorization: Bearer <토큰>` 헤더를 사용합니다. 처음 실행하면 `data/access-token.txt`에 토큰이 생성됩니다. 이 파일의 값을 클라이언트에 입력하고 토큰을 비공개로 보관하세요.

에이전트는 `workspace_write`로 파일을 저장하고 `artifact_publish`로 그 버전을 중간본이나 최종본으로 발행합니다. 다음 에이전트는 `artifact_read`로 당시 내용을, `session_history`로 작성자·단계·변경 사유를 확인합니다. 호출 예시는 압축에 포함된 [세션 서비스 안내](./node_modules/agentic-task-kit/docs/session-service.md)에 있습니다.

## 데이터 보관 및 설정

같은 폴더에서 다시 시작하면 이전 세션과 작업 기록을 이어서 사용할 수 있습니다. 새 버전으로 옮길 때는 서비스를 종료한 후 `data` 폴더 전체를 새 배포 폴더로 복사합니다.

필요하면 PowerShell에서 환경 변수를 설정한 후 실행합니다.

```powershell
$env:ATK_STATE_DIRECTORY = 'D:\ATK 작업\data'
$env:ATK_SERVICE_PORT = '4320'
.\start-atk.cmd
```

포트를 변경한 경우 대시보드 및 MCP 주소에도 같은 포트를 사용합니다. `ATK_SERVICE_TOKEN` 환경 변수에 직접 토큰을 지정하면 해당 값을 사용합니다. 연결 주소는 이 PC의 루프백 주소인 `127.0.0.1`입니다.
