# Stackbite

셸과 에이전트 CLI를 Room·Seat 단위로 관리하는 로컬 멀티 에이전트 작업 공간입니다.
Rust 네이티브 런처, Room 서비스, 터미널 오너 및 TUI로 동작합니다.
[English](README.md)

## 설치

[Node.js 20 이상](https://nodejs.org/en/download)을 설치한 뒤 새 터미널에서 실행합니다.

```sh
npm install --global stackbite@latest
stackbite setup
stackbite
```

npm 패키지는 가벼운 런처입니다. `setup`은 앱을 열지 않고 고정된 네이티브 번들을 내려받아 검증하며, 생략 시 첫 실행 때 준비합니다. 이후 실행에서는 검증된 캐시를 재사용합니다. `npx --yes stackbite@latest`로도 바로 실행할 수 있습니다. 사용할 AI CLI 도구는 별도로 설치하고 로그인해 주세요. Node.js, Python, WSL 없이 [최신 릴리즈](https://github.com/Shinick-Han/stackbite/releases/latest)에서 OS별 압축 번들을 내려받아 전체 압축을 해제한 뒤 포함된 설치 스크립트를 실행할 수도 있습니다.

0.5.121 네이티브 번들 지원 환경: Windows x64, Linux x86_64(GLIBC 2.28+), Apple Silicon 및 Intel macOS 13+. Linux ARM과 musl/Alpine 번들은 제공하지 않으며, 이번 코어 배포본에는 선택 기능인 Phone 런타임이 포함되지 않습니다. 변경 사항과 검증 범위는 [릴리즈 노트](https://github.com/Shinick-Han/stackbite/releases/latest)를 확인하세요.

## 사용법

사이드바에서 Room과 Seat를 관리합니다. 상단 Menu에서 작업·설정을 열고, Rooms / Files 전환기로 사이드바 내용을 바꿉니다. Files에서는 작업 폴더 탐색과 읽기 전용 Preview를 제공합니다. 창을 닫아도 데몬이 소유한 작업은 계속 유지됩니다. Room·Seat 정의와 저장된 기록은 보존되며, 이전 대화 이어하기는 각 CLI 제공자의 resume 지원 여부에 따릅니다.

## 업데이트 및 유지보수

```sh
stackbite --version
stackbite --status
stackbite update --check
stackbite update --apply
stackbite restart
stackbite stop --apply
```

`update --apply`는 배포된 최신 런타임을 설치하고 엔진 전환을 조율합니다. 실행 중인 CLI는 기본적으로 그대로 유지되며, 명시적인 Stop 및 Resume으로 새 엔진으로 옮길 수 있습니다. `restart`는 정의와 기록을 유지한 채 로컬 Room 서비스를 복구합니다.

`stackbite --help`와 `stackbite agent --help`에서 전체 명령을 확인할 수 있으며, `stackbite uninstall --preview`로 삭제 전 제거 범위를 미리 확인할 수 있습니다.

## 배포 및 라이선스

이 저장소는 설치 스크립트, 서명·검증된 네이티브 릴리즈 아카이브, npm 런처를 배포하며 StackBite 소스 저장소는 비공개(Private)로 운영됩니다. **0.5.121**까지의 배포본은 [MIT 라이선스](LICENSE)로 게시되었고 차기 릴리즈(**0.5.122+**)부터는 자체 배포 약관(Proprietary)이 적용되며, 함께 번들링된 서드파티 구성 요소는 각자의 라이선스와 고지를 유지합니다. 현재 게시 버전: **0.5.121**.

## 단축키

`Ctrl+B`를 누른 뒤 손을 떼고 `?`를 누르면 도움말이 열립니다. `Ctrl+B` 뒤 `w`는 새 Room, `c`는 새 Seat, `f`는 목록 포커스, `q`는 Seat 실행을 유지한 채 창 닫기입니다. 직접 바인딩은 Settings → Keyboard shortcuts에서 변경할 수 있습니다.
