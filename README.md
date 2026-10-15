# Stackbite: Local Multi-Agent Work App

> Work Stack organizes the work. Stackbite gets it moving.
>
> Work Stack으로 정리하고, Stackbite로 실행한다.

Stackbite는 Windows ConPTY와 Linux POSIX PTY를 사용하는 로컬 멀티 에이전트 작업 앱입니다.
Room에 작업 경로와 목표를 정하고, Seat에서 셸·Codex·Claude 같은 설치된 CLI를 병렬로
실행합니다. TUI에서 방을 이동하거나 종료해도 데몬이 소유한 터미널은 계속 실행됩니다.
Work Stack 없이 사용할 수 있으며, Work Stack 연결은 Task 권한과 실행을 분리합니다.

## 설치와 실행

공개 [Stackbite 배포 저장소](https://github.com/Shinick-Han/stackbite/releases/tag/v0.5.29)의
검증된 **0.5.29** 실행 파일과 TGZ는 GitHub 로그인 없이 받을 수 있습니다.
0.5.29는 `701935da3dbc`에서 컴파일되었고, 이 소스 트리(`main`)의 빌드·런처 고정값은 0.5.26입니다.
두 식별자의 구분은 [아키텍처 맵](ARCHITECTURE.md#build-and-release-identities)을 참고하세요.
정식 제품명은 **Stackbite**, 명령어와 저장소 이름은 **`stackbite`**입니다.
핵심 소스 저장소 [shinick-dev/stackbite](https://github.com/shinick-dev/stackbite)는 비공개로 유지합니다.

0.5.20에는 간결한 Rust 화면이 포함됩니다. `stackbite --frontend rust`로 실행하고,
Alt+Shift+Z로 집중 화면, F6로 Seats 이동을 사용할 수 있습니다. 기존 키맵과 실행
기본값은 유지됩니다. [Rust 화면과 실행 소유권 안내](docs/release-0.5.20.md)를 참고하세요.

### npm / npx 설치

Node.js 20 이상과 `tar`가 있는 Windows x64 또는 glibc Linux x64에서 실행합니다.
Python 설치는 필요하지 않으며 첫 실행은 검증된 런타임을 내려받고 다음부터 캐시를 사용합니다.
아래 두 방식 중 하나를 선택하면 됩니다. 전역 설치는 작은 런처를 설치하고,
이어 `stackbite`를 처음 실행할 때 네이티브 런타임을 내려받습니다.

```sh
npx --yes stackbite
```

계속 사용할 명령으로 설치하려면:

```sh
npm install --global stackbite
stackbite
```

[npm registry](https://www.npmjs.com/package/stackbite)의 공개 패키지를 사용합니다.
특정 버전은 다음 GitHub TGZ URL로 지정할 수 있습니다.

```sh
npx --yes https://github.com/Shinick-Han/stackbite/releases/download/v0.5.18/stackbite-0.5.18.tgz
```

macOS·ARM·Alpine은 현재 지원 대상이 아닙니다.
[런처 설치·업데이트 안내](packaging/npm/README.md)를 참고하세요.

### 네이티브 실행 파일

Windows x64 ZIP의 **전체 압축을 해제한 뒤 `stackbite.exe`를 실행**합니다.
Linux x86_64 tar.gz는 전체를 해제하고 `./stackbite`를 실행합니다. 두 플랫폼 모두
`runtime/`을 실행 파일 옆에 유지하면 Python이나 소스 checkout 없이 동작합니다.
Linux의 최소 glibc 요구 사항은 `portable.json`의 `minimum_glibc`에 기록됩니다.

선택적으로 Windows의 `install.cmd` 또는 Linux의 `./install.sh`로 사용자 계정에 설치합니다.
Codex·Claude 등 provider CLI의 설치와 로그인은 별도입니다.
설치·롤백은 [Windows](packaging/README.md) / [Linux](packaging/linux/README.md) 안내를 따릅니다.

```text
stackbite
stackbite --help
stackbite --version
stackbite --status
stackbite agent --help
stackbite update --check
```

`--help`는 TUI나 백엔드를 시작하지 않습니다. `--version`은 실제 버전·커밋을,
`--status`는 실행·상태 경로를 확인하는 데 사용합니다. `stackbite update`는 배포 파일과
체크섬을 검증하여 설치하며, 실행 중인 백엔드와 CLI를 종료하지 않습니다. 소스 checkout은
Git으로 업데이트합니다. 이미 실행 중인 백엔드는 기존 코드를 사용하므로 새 기능은 그
백엔드를 명시적으로 재시작한 뒤 적용됩니다. 백엔드 재시작은 실행 중인 CLI를 종료합니다.

0.5.18은 지원되는 로컬 백엔드와 지속적인 인증 연결로 입력을 전달하고, 변경된
화면 행을 push로 받습니다. Windows PTY 수집은 출력 이벤트를 기다리며, 물리 셀
렌더링에서는 출력만 바뀌면 기존 UI 프레임을 재사용합니다. 확대·축소, 스크롤,
복사와 좌석 세대 검증을 유지하며, 기존 백엔드에는 HTTP 조회로 연결됩니다.
실제 PTY 지연 측정의 범위와 한계는 `docs/terminal-stream-ui-1008.md`를 참고하세요.

0.5.18은 단순 키 전달에 따른 불필요한 전체 화면 갱신을 줄이고, 검증된 불변
화면 행을 재사용합니다. 한 좌석이 바쁜 동안 다른 좌석의 화면 발행을 계속하며,
렌더 시간 자체를 갱신 간격에 포함합니다. 입력 ACK·실패 시 재전송 금지·좌석과
화면 소유권 검증은 유지합니다. 이번 직렬 PTY 측정과 한계는
`docs/next-latency-release-1008.md`에 기록합니다.

이하 기능·설정 안내는 공개된 **0.5.18** 기준입니다. 설치된 client/server의
실제 버전과 지원 기능은 각각 확인하세요.

### 오래된 VTE / Citrix 터미널

MATE Terminal의 VTE 0.52 환경에서 상태 원과 의자 glyph가 한 칸으로 표시되면,
새 frontend를 다음처럼 실행합니다. csh/tcsh에서도 같은 명령을 사용합니다.

```sh
env STACKBITE_CHROME_PROFILE=vte-0.52 ./stackbite
```

이 설정은 제품 UI의 두 glyph만 폭이 안정적인 표현으로 바꿉니다. 일반 터미널은
기본 UI를 유지하며, Seat 출력·사용자 이름·폰트·터미널 설정은 바뀌지 않습니다.
0.5.18는 지원되는 POSIX VT 터미널의 화면 행을 절대 위치로 출력하므로 raw tty의 LF 처리에 의존하지
않습니다. frontend만 다시 열어도 표시 수정이 적용되며 기존 backend와 Seat를
종료할 필요가 없습니다. [호환 설정과 검증 범위](docs/citrix-chrome-1008.md)를
참고하세요.

## Room과 Seat

현재 소스는 연결된 백엔드에 방이 없으면 작업 폴더를 채운 Room 생성 화면을 엽니다.
Enter로 Room과 기본 shell을 열며, 같은 폴더에서 다시 실행하면 기억한 유효 Room으로 돌아갑니다.
재접속만으로 중단된 Seat를 실행하지 않습니다. 다른 폴더·삭제된 Room이면 목록을 엽니다.
작업실 백엔드가 꺼져 있으면 로컬 8090에서 시작합니다.
방을 선택하고 Enter로 진입합니다. `F7` / `Alt+R`로 목록으로 돌아가며, 목록에서 `Esc`는
이전에 열었던 작업실로 돌아갑니다. Room 생성 화면에서 Esc를 누르면 목록으로 돌아갑니다.
목록 입력은 관리 동작이며 좌석의 CLI에 전달되지 않습니다.

설정은 Room 생성 화면의 `Ctrl+D` 또는 Help의 `s`로 저장합니다. CLI에서는
`stackbite config set chrome_profile vte-0.52`, `stackbite config set terminal_core python`처럼
한 번 저장하고 이후 `stackbite`만 실행하면 됩니다. 명시한 환경변수·실행 옵션은 저장값보다
우선합니다. [첫 사용](docs/first-use.md), [설정](docs/launch-preferences.md),
[clone 후 단일 명령 빌드](docs/build-local.md), [Node 없는 설치](docs/install-from-release.md)를 참고하세요.

화면 아래 `[+ Room]`, `[+ Terminal]`, `[Find seats]`로 방·터미널을 관리합니다.
방에는 이름·작업 폴더·공통 목표를 지정합니다. Seat는 역할·개별 작업·범위·완료 조건·
결과물·보고 대상을 가집니다. 이름을 바꿔도 내부 seat key와 실행 기록의 연결은 유지됩니다.
검색은 여러 방의 이름·역할·명령·작업 경로를 찾고 `Tab`으로 상태를 필터링합니다.

방 안에서 `Ctrl+T` / `Alt+T` 또는 `[+ New terminal]`을 선택하고 Enter를 누르면 기본 셸을
엽니다. `codex`, `claude`, `python -i` 같은 설치된 명령과 인자도 입력할 수 있습니다.
명령 선택창은 셸 연산자나 환경 변수를 자동 평가하지 않으므로 필요한 경우 셸 안에서 실행합니다.
기존 터미널은 sidebar에서 클릭해 전환합니다.

`[Split →]` / `[Split ↓]`로 같은 방의 두 터미널을 표시합니다. pane 클릭은 입력 대상을
바꾸고, 경계선 드래그는 크기를 조절합니다. `Alt+Z`는 현재 pane을 확대합니다.
좌석·터미널 우클릭 또는 `Alt+M` / `Shift+F10`은 Rename, Close, Restart CLI 메뉴를 엽니다.
좌석 패널의 `Delete`는 선택한 좌석을 닫고, 터미널 포커스의 `Delete`는 CLI에 전달됩니다.
종료 동작은 선택한 generation만 대상으로 하며 기록은 보존합니다.

꺼진 CLI 좌석을 선택하면 같은 좌석에 복구용 기본 셸을 엽니다. 원래 CLI 명령·모델·역할은
유지하며 `Restart CLI`로 원래 명령을 다시 실행합니다. 이전 복구 요청의 전달 결과가
불명확하면 먼저 그 요청을 조회합니다. 새 실행은 `Start new terminal (new request)` 또는
`Retry CLI (new request)`로 명시적으로 요청하며 이전 요청을 자동 재전송하지 않습니다.

방 우클릭의 Archive / Restore / Delete room 또는 `/room-delete`로 방을 관리합니다.
실행 중인 좌석이 있으면 먼저 명시적으로 종료해야 합니다. 삭제 확인창은 Cancel을 기본으로
선택합니다. 정지된 활성 방은 확인 후 보관·삭제하며 작업 폴더·Git worktree·실행 기록은 보존합니다.
Restore는 좌석을 자동 실행하지 않습니다. `Ctrl+Q`는 TUI 연결만 해제합니다.

| 관리 명령 | 동작 |
| --- | --- |
| `/room-new 작업 이름` | 현재 작업 경로에 빈 작업실 생성; 자동 진입·실행 없음 |
| `/room <번호 또는 room_id>` | 작업실 선택 |
| `/seat-new qa powershell` | 선택 방에 좌석을 만들고 명시적으로 실행 |
| `/seat-add qa codex` | 정지된 좌석 정의만 추가 |
| `/room-run qa 검토해줘` | 정지된 provider 좌석에서 headless 단발 실행 |
| `/room-history`, `/room-context qa` | 실행 기록·초기 컨텍스트 확인 |
| `/room-find 검색어`, `/room-filter active` | 작업실 검색·상태 필터 |
| `/room-worktree 작업 이름` | Git 커밋 HEAD에서 별도 worktree 작업실 생성 |
| `/spawn qa codex`, `/kill qa` | 선택 방의 좌석 실행·종료 |
| `/broadcast 점검해줘` | 선택 방의 살아 있는 좌석에 지시 |
| `/archive`, `/restore` | 정지된 작업실 보관·복원 |

## 터미널 입력과 출력

`Alt+H`로 검색 가능한 도움말을 엽니다. 도움말의 `Ctrl+P`로 관리 prefix를 활성화하고
`Ctrl+K`로 `Ctrl+B` / `Ctrl+A` / `Ctrl+Space` 중 선택합니다. prefix 뒤 `%` / `"`는
좌우·상하 분할, `o`는 pane 전환, `n`은 좌석 검색, `[`는 복사 모드입니다.
같은 prefix를 두 번 누르면 문자 하나를 CLI에 전달합니다. 도움말의 `Ctrl+L`로 관리
단축키를 해제하면 해당 키를 CLI에 전달할 수 있습니다.

출력 드래그는 선택 후 버튼을 놓으면 복사합니다. CLI가 마우스 입력을 요청하면 휠·왼쪽
클릭은 포인터 아래 CLI에 전달하며, `Shift`를 누른 드래그는 Stackbite 출력 선택입니다.
`Shift`+휠은 Stackbite 이력을 탐색합니다. 메뉴나 출력 선택 중에는 CLI에 마우스를 보내지 않습니다.
CLI 포인터 입력에는 백엔드의 `terminal_mouse`와 `terminal_geometry`가 모두 필요합니다.
실제 PTY 크기·화면 원점·좌석 generation이 확인된 라이브 화면에서만 좌표를 전달합니다.
오래된 백엔드에서는 안내에 따라 업데이트·재시작합니다.
[터미널 입력·크기 계약](docs/terminal-interaction-contract.md)에 자세한 규약이 있습니다.

`Shift+PageUp` / `Shift+PageDown`은 이력을 탐색하고 `End`는 라이브 화면으로 돌아갑니다.
분할 pane은 각자 이력 위치를 유지합니다. 보관량은 좌석마다 기본 2,000줄이며
백엔드 시작 전에 `STACKBITE_SCROLLBACK_LINES`로 1~20,000줄을 지정합니다.
잘못된 값은 기본값으로 돌아갑니다. 오래된 줄부터 제거하며 보관량을 늘리면 메모리도 늘어납니다.
이력은 메모리이므로 백엔드 재시작 시 초기화됩니다.

`Alt+C` 또는 prefix + `[`로 복사 모드를 열어 `/` 검색, `n` / `N` 다음·이전 결과,
`v` 선택, 방향키 이동, `y` 복사를 사용합니다. `Esc`로 돌아갑니다.
Windows는 시스템 클립보드를, Linux는 `Ctrl+O` 또는 `STACKBITE_CLIPBOARD_OSC52=1`로
명시적으로 허용한 OSC52를 사용합니다. 호스트 터미널의 OSC52 지원이 필요합니다.

터미널은 전경색·배경색·문자 속성과 결합 문자·이모지의 셀 폭을 보존합니다.
대체 화면의 짧은 출력 묶음과 DEC2026 동기화 구간은 표시 프레임을 합치지만 모든 바이트는
즉시 파싱합니다. 실행 완료는 표시 지연과 별개이며 모든 CLI 재도색을 완전히 재현하는 것은 아닙니다.
실제 PTY 기본 환경은 `TERM=xterm-256color`, `COLORTERM=truecolor`입니다.
호출자가 좌석 환경에 명시한 `NO_COLOR`, `TERM`, `COLORTERM`은 보존합니다.

## 에이전트 협업과 API

좌석 안에서는 `stackbite-room`으로 같은 방의 동료를 관리합니다.

```text
stackbite-room context
stackbite-room ready
stackbite-room summon reviewer --provider codex --task-file review-task.txt --scope src --acceptance "tests pass" --output-path review.md --report-to coordinator
stackbite-room send reviewer --prompt-file followup.txt
stackbite-room wait reviewer --generation RECEIPT_GENERATION --turn 4 --timeout 30
stackbite-room read reviewer
stackbite-room report --state progress --message "검토 중" --artifact review.md
stackbite-room inbox
```

`assign`은 작업 메타데이터를 바꾸고 `send`는 실제 지시를 제출합니다. 여러 지시는 같은
프로세스·대화에 전달됩니다. 바쁜 좌석·사용자 입력 초안·교체된 generation에는 지시를
거절하며 자동 재전송하지 않습니다. `report --state completed`는 에이전트 보고로 보존하며
provider 완료 증거와 구별합니다. Codex·Claude의 hooks는 시작·작업·승인 대기·응답 완료를
기록합니다. CLI 로그인, workspace 신뢰, hooks 신뢰와 도구 실행 승인은 provider 안에서 처리합니다.
Stackbite는 승인·sandbox를 우회하지 않습니다.

Python SDK `AgentStackbite`는 방을 대상으로 합니다. 외부 스크립트는 `room_id`를
명시하고, 좌석 안의 에이전트는 상속된 `STACKBITE_ROOM_ID`를 사용합니다. 인증된
`TaskRoomClient`로 위임하며 방이 없는 호출은 거절합니다. 직접 방 API를 사용하려면
`TaskRoomClient`를 사용합니다.

기존 방의 좌석을 조회하는 예:

```python
from private_pty import AgentStackbite, TaskRoomClient

sdk = AgentStackbite(room_id="review-room", client=TaskRoomClient())
seats = sdk.list_agents()  # 이 방의 정의된 좌석; 정지된 좌석도 포함
```

좌석 안에서는 `AgentStackbite()`가 상속된 방을 사용합니다. 생성자는 데몬을 시작하거나
로컬 에이전트를 생성하지 않습니다.

기본 방 주소는 `http://127.0.0.1:8090`입니다. 명시적 `base_url`,
`STACKBITE_ROOM_BRIDGE_URL`, 기본 주소 순서로 선택합니다. 클라이언트는 상태 위치에서
기존 인증 토큰을 읽어 `X-Office-Token`으로 전송합니다. 토큰 값을 프롬프트나 로그에 넣지 않습니다.

```python
from private_pty import TaskRoomClient

client = TaskRoomClient()
room = client.create_worktree_room(
    "입력 안정화", source_repo=r"C:\my-project",
    objective="입력 회귀를 수정하고 테스트 결과를 보고한다",
)
rid = room["room_id"]
client.add_seat(rid, "qa", agent_kind="codex", role_title="회귀 검토")
result = client.run(rid, "qa", "입력 처리를 검토하고 결함을 보고해줘",
                    request_id="input-review-001", timeout=120)
history = client.executions(rid)
```

`run()`은 정지된 좌석의 명시적인 headless 단발 실행입니다. 대화형 `spawn` / `send`가
실패해도 headless 실행으로 바꾸지 않습니다. `dispatch()`는 살아 있는 대화형 CLI에
generation을 확인한 뒤 입력합니다. 지시별 request ID·generation·turn receipt로
전달과 완료를 구별합니다. 같은 ID·지시는 저장된 receipt를 반환하고 다른 지시는 충돌합니다.
불명확한 전달은 `unknown_delivery`로 보고하며 자동 재실행하지 않습니다.

완료는 owned process와 provider의 명시적 lifecycle 증거로 판정합니다. 잠깐의 출력 정지나
CLI 종료 코드 0만으로 AI 작업 성공을 판정하지 않습니다. blocked는 개입이 필요한 상태입니다.
결과물 등록·accepted/rejected 검토·외부 Task 완료는 각각 별도 동작입니다.

실행 저널은 지시·generation·turn·상태·완료 근거·최대 64 Ki 문자의 출력 스냅샷을 저장합니다.
모든 키 입력을 기록하는 transcript는 아닙니다. 백엔드 재시작은 셸 메모리를 복구하지 않으며
살아 있는 generation이 없는 미완료 실행은 interrupted로 표시합니다.
Windows 네이티브 실행은 전용 Job Object가 provider와 그 자식 프로세스를 소유합니다.

## 데이터와 Work Stack

새 설치는 Stackbite 이름의 경로를 사용합니다. 이전 설치의 실제 DB·토큰·설정은 상태
locator(`.stackbite-state.json`)와 파일 매핑으로 **현재 위치에서 재사용**합니다. 열려 있는 SQLite DB를 복사하거나
이름을 바꾸지 않습니다. 이전 제품명 경로가 실제 데이터 위치로 남아 있어도 추가 상태
트리를 만들 필요가 없습니다. 0.5.18의 `stackbite --status`는 실제 `state`와 인증 파일의
`auth_file` 경로를 반환합니다. 인증 파일은 그 경로를 사용하며, 상태 폴더 아래 고정된
새 파일명으로 추측하거나 별도 토큰을 만들지 않습니다. 토큰 내용은 출력하지 않습니다.
[호환성 안내](docs/stackbite-compatibility.md)에 durable data와 인증 경계가 있습니다.

Work Stack은 작업 정리와 Task 권한을, Stackbite는 로컬 Room/Seat 실행을 담당합니다.
연결 개발은 `integration/work-stack`에서 분리하고 병렬 실행·우선순위·의존성 기반 선택을
유지합니다. 선택한 Task의 workspace·revision을 확인한 뒤 방을 만들며 이 과정은 Task
상태를 수정하지 않습니다.

```powershell
python -m private_pty.workstack_link room --task T-0041 --cwd C:\my-project --isolated --source-repo C:\my-project
```

handoff의 첫 줄 `WorkStack binding:` JSON marker와 Task ID·workspace·revision 계약은
유지합니다. `publish_checkpoint()`는 새로 검증한 바인딩과 안정적인 intent ID로 호출자가
작성한 사실만 전달합니다. commit_unknown은 operation-status로 확인하고 mutation을
재전송하지 않습니다. 로그·프롬프트 자동 복사나 Task 자동 완료는 하지 않습니다.

초기 에이전트 컨텍스트에는 실제 cwd/worktree, 사용 가능한 CLI와 비밀값을 노출하지 않는
인증 API 사용법을 포함하며 다음 소개를 전달합니다.

> Stackbite는 현재 로컬에서 실행 중인 자체 멀티 에이전트 작업 앱이다.

## 개발과 성능 검토

```powershell
python -m pip install -r requirements-build.txt
python stackbite.py
```

핵심 구현은 `private_pty/`의 PTY·VT 버퍼·세션 registry·Room/Seat·실행 저널·Rich TUI와
`office_backend_bridge.py`의 인증 HTTP API입니다. 런타임 데이터와 개인 설정은 배포에 포함하지
않습니다. 별도 웹 UI는 `/stackbite/company_office_mockup.html`이며 `/agency-agents/`의
manifest identity는 유지합니다.
원격 웹 접속의 origin·신뢰 프록시는 `STACKBITE_ALLOWED_ORIGINS`·`STACKBITE_TRUSTED_PROXY_IPS`로
명시합니다. `X-Office-Token` 인증은 로컬 요청에도 필요합니다.

변경·검증·통합 경계는 [CONTRIBUTING.md](CONTRIBUTING.md)를 따릅니다.
실제 provider 테스트는 별도 opt-in이며 사용자 상태·진행 중인 좌석에서 실행하지 않습니다.

[최적화 후보](docs/optimization-candidates.md)는 우선순위·소스 근거·위험·검증을 정리합니다.
[기존 측정 보고서](docs/optimization/implementation-results-059.md)는 일부 렌더링·본문·저장소
개선과 함께 HTTP 서버 CPU 증가·일부 VT 재생 시간 증가를 기록합니다. 앱 전체가 빨라졌다고
주장하지 않습니다.

## License

Private & Proprietary — All Rights Reserved.
