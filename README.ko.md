# StackBite — 터미널과 AI 에이전트를 위한 작업 공간

셸과 설치된 CLI를 Room·Seat로 나란히 실행하고, 에이전트가 같은 CLI로 협업하게 합니다.
StackBite는 Windows·Linux·macOS용 독립 Rust 애플리케이션이며 실행에 Python이 필요 없습니다.

[설치](#설치) · [원격 실행 host](#원격-실행-host) · [English](https://github.com/Shinick-Han/stackbite/blob/main/README.md) · [Releases](https://github.com/Shinick-Han/stackbite/releases/latest) · [License](https://github.com/Shinick-Han/stackbite/blob/main/LICENSE)

## 설치

현재 [Node.js LTS](https://nodejs.org/en/download)(Node.js 20 이상 필요)를 설치한 뒤
새 터미널에서 실행합니다.

```sh
npm install --global stackbite@latest
stackbite setup
stackbite
```

`setup`은 고정된 네이티브 runtime을 내려받아 검사하며 앱은 열지 않습니다.
생략하면 첫 실행 때 준비하고, 이후에는 검사한 사본을 재사용합니다.
한 번만 실행하려면 `npx --yes stackbite@latest`를 사용합니다.
Codex·Claude 같은 provider CLI는 별도로 설치하고 로그인합니다.

[최신 release](https://github.com/Shinick-Han/stackbite/releases/latest)에서 네이티브
압축 파일을 받아 **전체를 해제**한 뒤 `stackbite.exe`(Windows) 또는 `./stackbite`
(Linux·macOS)로 실행할 수도 있습니다. 이 경로는 Node.js와 Python이 모두 필요 없습니다.

현재 버전: **0.8.1**

| Platform | Runtime |
| --- | --- |
| Windows | x64 |
| Linux | x86_64, GLIBC 2.28 이상 |
| macOS | Apple Silicon·Intel, macOS 13 이상 |

네 배포본은 runtime source `9279e6472871`로 빌드합니다. Linux ARM·Alpine/musl
배포본은 제공하지 않습니다. 배포 파일, 실제 검사 범위와 아직 검증하지 않은 항목은
[0.8.1 release notes](https://github.com/Shinick-Han/stackbite/releases/tag/v0.8.1)에 있습니다.

## 작업 공간

프로젝트 폴더에서 `stackbite`를 실행합니다. **Room**은 작업 폴더·공통 목표·**Seat**를
묶고, 각 Seat는 셸이나 설치된 CLI를 실행합니다.

- **Menu**에서 Room과 Seat를 만듭니다. **New Seat**에서 Enter를 누르면 셸이 열립니다.
- 터미널을 분할하고, 클릭으로 포커스를 옮기고, 경계선을 드래그해 크기를 바꿉니다.
- sidebar를 **Rooms**와 **Files**로 전환합니다. Files는 선택한 Room 서버 파일을
  제한된 범위에서 읽기 전용으로 미리 봅니다.
- 창을 닫아도 native owner가 소유한 작업은 계속되며, 나중에 다시 연결합니다.

## 원격 실행 host

**Menu → Connections**에서 SSH 연결을 관리하고(Add, Edit, Test, Pin, Setup,
Disconnect, Forget) **Run on**으로 실행 host를 고릅니다. provider 설치·로그인·작업
폴더는 그 host에 속합니다.

- **Setup**·**Test**가 Linux x86_64(GLIBC 2.28 이상) host에 검증된 작은 runtime
  capsule을 준비합니다. 그 host는 StackBite 전체 설치 없이 원격 Seat를 실행합니다.
  capsule은 이 앱의 release가 고정하며, 필요할 때 내려받아 검사하고 재사용합니다.
  이미 설치형 StackBite로 설정한 host는 그 연결을 유지합니다.
- 원격 Seat 상태는 묶어서 조회하며, SSH 세션을 추가로 열지 않고 기존 연결을 씁니다.
- 쓰지 않는 capsule cache 파일은 유휴 상태에서 제한된 양만큼 정리합니다. 소유를
  증명할 수 없는 파일과 Windows·NFS·식별되지 않은 파일시스템의 파일은 남깁니다.
- 연결할 수 없는 host를 **Forget**하면 로컬에서 완료하고, 그 host의 자격 회수는
  연결할 수 있을 때까지 대기 상태로 남깁니다.
- 인증은 기존 native OpenSSH(SSH config, agent, key, known_hosts)를 그대로 씁니다.
  비밀번호 저장이나 새 비밀번호 기능은 추가하지 않습니다.
- Windows 실행 host에서는 capsule을 실행할 수 없으며, 아무것도 실행하기 전에
  거부합니다. Windows는 controller로 계속 지원합니다.

공유 저장소만으로는 컴퓨터가 연결되지 않습니다. 터미널 명령은 `stackbite remote --help`를
참고합니다.

## 단축키

**Press Ctrl+B, release it, then press a key.**

| Key | Action |
| --- | --- |
| `w` | New Room |
| `c` | New Seat |
| `n` | Find Room or Seat |
| `f` | Focus list |
| `%` / `"` | Split right / down |
| `o` | Focus next pane |
| `z` | Zoom or restore pane |
| `[` | Find and copy text |
| `s` | Settings |
| `?` | Help |
| `q` | Close window; keep Seats running |

Ctrl+B를 두 번 누르면 Ctrl+B 한 번을 CLI에 전달합니다. **Settings → Keyboard
shortcuts**에서 키를 바꾸고, Help(`Ctrl+B`, `?`)에서 현재 키를 확인합니다.

## 에이전트 협업

Seat 안에서는 에이전트가 같은 `stackbite-room` 인터페이스를 씁니다.

```sh
stackbite-room context --output summary
stackbite-room ready --output summary
stackbite-room seats --output summary
stackbite-room report --state progress --message "검토 중" --output summary
stackbite-room start --help
```

컨텍스트에는 작업·범위·완료 조건과 `report_to`가 들어 있습니다. `ready`는 수신
확인이며 완료 증거가 아닙니다. provider별 권한·hooks·완료 증거는 명시적으로 다룹니다.

자동화는 native CLI와 인증된 Room HTTP API를 사용합니다. 기본 주소는
`http://127.0.0.1:8090`이며 `STACKBITE_ROOM_BRIDGE_URL`로 바꿀 수 있습니다. 인증 토큰은
기존 상태 위치에서 읽어 `X-Office-Token` header로 보내고, 토큰 값은 프롬프트나 로그에
넣지 않습니다.

## 업데이트와 복구

```sh
npm install --global stackbite@latest
stackbite setup
stackbite update --check
stackbite restart
stackbite uninstall --preview
```

npm 설치는 npm으로, 네이티브 설치는 `stackbite update`로 업데이트합니다. 설치,
management 활성화, Seat 엔진 이동은 별개 단계이며 실행 중인 CLI는 명시적인 Stop·Resume
전까지 이전 엔진을 유지할 수 있습니다. `stackbite restart`는 Room 서비스를 복구하고
Room·Seat 정의를 유지합니다. 재부팅하면 프로세스 메모리는 남지 않으며, 대화 재개는
provider에 따라 다릅니다. 전체 uninstall은 소유한 로컬 capsule cache도 정리하고,
`--keep-data`는 제품 데이터를 남깁니다.

## 소스와 라이선스

StackBite 0.5.122 이상은 [StackBite License](https://github.com/Shinick-Han/stackbite/blob/main/LICENSE)에
따른 독점 소프트웨어입니다. 수정하지 않은 바이너리 릴리스는 개인 및 내부 업무 용도로
무료 사용할 수 있으며, 1st-party 소스의 수정·재배포에는 허가가 필요합니다. MIT로 게시된
0.5.121 이하 릴리스는 해당 사본에 대해 MIT로 유지됩니다. 타사 구성 요소는 원래
라이선스와 고지를 유지합니다.

1st-party 소스 저장소는 비공개입니다. 공개 바이너리와 이슈:
[releases](https://github.com/Shinick-Han/stackbite/releases),
[issues](https://github.com/Shinick-Han/stackbite/issues).
