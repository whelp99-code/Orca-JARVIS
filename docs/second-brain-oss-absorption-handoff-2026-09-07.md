---
title: 세컨드브레인 기반 오픈소스 장점 흡수 — 작업 인계
type: handoff
sensitivity: T1
updated: 2026-09-08
status: direction-merged-in-recipient-plan-observed
---

# 세컨드브레인 기반 오픈소스 장점 흡수

## 1. 인계 대상과 목적

- 대상 작업: `codex://threads/01a07b30-3b47-7552-879e-adae5ab6ec33`
- 도구로 확인한 제목: **프로젝트 정의와 동작 상태 점검**
- 대상 작업공간: `/home/jm/orca/projects/second-brain-app`
- 발신 작업공간: `/home/jm/orca/projects/Orca-JARVIS`
- 대상 작업의 기존 목적: 세컨드브레인을 완성하여 자비스와 기타 프로젝트의 메인 기억 저장소를 동작시키는 것.
- 이번 전달 준비 시 대상 작업은 `active`, 최근 턴은 `inProgress`로 조회됐다. 최근 2개 턴의 본문은 반환되지 않았다. 그곳에서 이미 수행한 수정·검증을 먼저 확인하고 본 문서의 제안을 병합한다. 기존 작업을 되돌리거나 처음부터 반복하지 않는다.
- 현재 인계 상태: **수신 작업공간의 계획 반영을 파일로 확인했다.** `/home/jm/orca/projects/second-brain-app/OSS-ABSORPTION-INTEGRATION-PLAN-2026-09-07.md`는 본 인계서를 직접 참조하며 사용자 확정 방향, 네 OSS 선별 흡수, 기존 구현 대조, 에이전트별 지원 범위, 구현 순서와 검증 조건을 병합했다. `IMPLEMENTATION-STATUS.md`도 해당 통합 계획을 정본 계획으로 참조한다. 이는 계획 반영의 증거이며 전체 구현·운영 인수 완료의 증거는 아니다.
- 이번 확인에서 대상 작업에 새 메시지를 전송하지 않았다. 현재 도구 목록에는 `send_message_to_thread`와 `handoff_thread`가 없다. 아래의 전송 미실행 기록은 과거 전달 시도 이력이며, 현재 수신 계획 반영 여부와 구분한다.
- 2026-09-08 재확인: 대상 작업의 경로는 `/home/jm/orca/projects/second-brain-app`, 상태는 `active`, 최근 턴은 `inProgress`이며 본문 항목은 반환되지 않았다. 앱 직접 전달을 위해 `computer-use` 스킬과 설치된 CLI 안내를 읽고 확인했다. `orca-ide status --json`은 성공했으나 `computer capabilities --json`은 `runtime_error: Unknown system error -122: Unknown system error -122, write`로 실패했다. 대체 임시 경로를 지정한 1회 재시도도 같은 오류로 실패하여 메시지 입력·전송을 수행하지 않았다. 아래 11절 전달문으로 인계를 이어갈 수 있다.

이 문서는 대화에서 확정한 방향, 조사한 근거, 구현 제안을 구분한 인계 자료다. 새 ADR 채택이나 배포 완료를 의미하지 않는다. 발신 작업에서는 세컨드브레인 소스를 수정하지 않았고 오픈소스 설치·서비스 재시작·데이터 이전도 하지 않았다.

## 2. 사용자가 확정한 방향

### 2026-09-08 최신 인수 대조

- 대상 작업 `01a07b30-3b47-7552-879e-adae5ab6ec33`을 다시 읽었다. 작업공간은 `/home/jm/orca/projects/second-brain-app`, 상태는 `active`, 최신 턴은 `inProgress`다. 이번에는 직전 완료 턴의 본문이 반환됐으며 검색 모델 초기화 비용 개선과 자비스 세션 연동의 미완료 조건을 유지하는 진행 메시지를 확인했다.
- 수신 통합 계획 1절은 세컨드브레인 정본, 자비스 실행·검증, dev-wiki/Git 개발 결정 원문, 네 OSS 선별 흡수, 여러 에이전트 공통 기억이라는 방향을 명시한다. 같은 계획 45절은 이 인계 문서의 현재판을 다시 읽었음을 기록한다. 따라서 **방향의 수신·계획 반영은 확인됐고, 새 메시지 발송 여부와는 별개다.**
- 수신 `IMPLEMENTATION-STATUS.md`의 최신 기록은 제품 `701e966`, 전체 931 passed/2 skipped, 실제 모델 129개 출력 일치 및 단일 배치 28.75→16.81초다. 이는 수신 작업의 기록을 읽은 결과이며 발신 작업이 테스트를 재실행한 수치가 아니다.
- 이어갈 과제는 자비스 세션의 실제 전달·compaction·삭제 수명, 검증된 프로젝트/사용자 범위, 에이전트별 수집·주입 지원, 근거 부족 응답, 실제 사용자 질문 및 GUI·운영·복구 인수다. 기존 구현을 처음부터 반복하지 않는다.
- 이번 직접 전송 경로 재확인: `send_message_to_thread`/`handoff_thread`는 제공되지 않았다. 이전 오류와 달리 `orca-ide computer capabilities --json`은 성공했다. 로컬 앱 목록은 gnome-shell, orca-ide, ptyxis, update-notifier의 4개였고 Codex 앱은 없었다. Orca 접근성 트리에는 프레임 1개만 반환되어 지정 Codex 작업의 입력창을 확인할 수 없었다. **새 메시지 입력·전송은 수행하지 않았다.**

최근 사용자 지시가 앞선 후보 추천보다 우선한다.

1. **1차 범위는 자비스와 세컨드브레인의 운영이다.** 다른 업무 프로젝트 실행자 연동은 후속 범위다.
2. **세컨드브레인을 기반으로 유지하고 다른 오픈소스의 장점만 흡수한다.**
3. **여러 에이전트가 연결되어 같은 기억을 활용해야 한다.** 특정 모델이나 Claude 전용 사용 흐름에 한정하지 않는다.
4. 코드·설정·규칙·기억 저장소가 더 섞이지 않게 정리한다. 기존 기능을 재사용하고 불필요한 자체 코드와 중복을 줄인다.
5. 세컨드브레인 구현은 대상 작업공간에서 진행한다. 자비스 작업공간에서는 인계와 자비스 측 계약 조율을 담당한다.

사용자의 최종 방향 원문:

> 그럼 세컨드브레인 기반으로 다른 오픈소스의 장점들만 흡수하자.

다음은 확정된 지시가 아니다: dev-wiki 즉시 폐기, 세컨드브레인 전체를 Tencent로 교체, 네 제품 동시 설치, 에이전트별 별도 기억 DB 구축, 모델 요청을 일괄 Proxy로 전환. 앞서 논의했던 Wiki.js·BookStack·Docmost·Basic Memory 추천도 현재 실행 계획으로 취급하지 않는다.

## 3. 역할과 경계

| 구성 | 유지할 책임 | 설계 시 확인할 경계 |
|---|---|---|
| 자비스 | 요청 접수, 작업 배정, 승인, 실행 상태와 결과 검증 | 기억 자동 요약을 실행 성공 증거로 사용하지 않는다 |
| 세컨드브레인 | 개인·업무 기억의 정본, 저장·검색·정정·삭제·출처 관리, 에이전트 간 공유 | 에이전트마다 다른 정본을 만들지 않는다 |
| dev-wiki 및 Git 문서 | 개발 결정·리포 관계·운영 규칙의 원문과 이력 | 검색에 연결할 수 있으나 승인된 원문과 자동 추출 기억을 구분한다 |
| 에이전트 연결부 | 클라이언트별 수집 형식·MCP/API 접근·문맥 공급 | 연결부마다 별도의 기억 정책·중복 저장 파이프라인을 구현하지 않는다 |

이는 사용자 방향을 구체화한 설계 제안이다. 실제 도메인 경계는 대상 저장소의 최신 구현과 대조해서 확정한다. 원본 기록, 파생 사실, 재생성 가능한 검색 인덱스의 관계도 먼저 확인한다.

현재 `../dev-wiki/README.md`는 리포 간 개발 기억의 정본을 dev-wiki, 개인·업무 기억의 저장소를 second-brain-app으로 구분한다. 세컨드브레인을 기반으로 기능을 확장한다는 지시만으로 개발 결정의 정본까지 이전하지 않는다. 개발 문서를 검색에 연결할 때에도 원문 정본과 파생 인덱스를 구분한다.

## 4. 조사 범위와 한계

2026-09-07에 GitHub 공식 README·라이선스·트리와 일부 핵심 소스를 읽었다. 네 제품을 설치하거나 테스트 스위트를 실행하지 않았고, 성능·검색 품질·운영 안정성을 실측하지 않았다. 아래 기능 설명은 소스/문서 확인이며 운영 검증 완료가 아니다.

| 저장소 | 확인한 브랜치 | 확인한 커밋 | 루트 라이선스 |
|---|---|---|---|
| `HKUDS/LightRAG` | `main` | `7eb87008dd84bd26fd69e1459ddb4f19ec1e9784` | MIT |
| `TencentCloud/TencentDB-Agent-Memory` | `feat/server_team` | `220af62226221d7ea07f95aa61eb7c0486cb407a` | LICENSE 본문 MIT. GitHub 자동 분류는 Other |
| `t1seungy/code-brain` | `main` | `8e46f59b3bd7ed08ec9b73ffbc6736717266ffb7` | Apache-2.0 |
| `jung-wan-kim/memory-bank` | `main` | `9ea9b62cf743d1f166e3425d73343532856a90a5` | MIT |

실제 코드를 가져올 경우 채택 파일·커밋·라이선스·저작권 고지와 필요한 NOTICE를 기록한다. 제품 전체 설치, 라이브러리 의존, 일부 코드 재사용, 설계 아이디어 적용은 각각 따로 판단한다.

### LightRAG: 검색·문서 처리의 장점

- 문서에서 엔티티·관계를 추출하고 벡터 검색과 그래프 검색을 결합한다.
- 근거 인용, 문서 삭제 후 영향받은 그래프 재구성, Web UI와 REST API를 제공한다.
- 현재 검토한 서버 구성은 REST 중심이다. 내장 MCP 서버는 확인하지 못했다.
- LLM·임베딩 및 저장소 구성이 필요하다. 기본 로컬 파일 저장 구성을 운영용으로 그대로 가정하지 않는다.
- **흡수 후보:** 근거가 연결된 하이브리드 검색, 선택적 관계 확장, 원문 삭제·수정과 파생 인덱스의 일관성, 검색 평가 방식.
- **범위 제한:** 기존 검색의 부족이 측정되기 전에는 그래프 DB·멀티모달 파서·추가 LLM 단계를 일괄 도입하지 않는다.

근거: [README](https://github.com/HKUDS/LightRAG/blob/7eb87008dd84bd26fd69e1459ddb4f19ec1e9784/README.md), [서버](https://github.com/HKUDS/LightRAG/blob/7eb87008dd84bd26fd69e1459ddb4f19ec1e9784/lightrag/api/lightrag_server.py).

### TencentDB-Agent-Memory: 공통 기억 관리의 장점

- Chat Memory·Skill·Wiki·CodeGraph와 소유권·공유 범위·상태·관리 UI를 묶는다.
- 에이전트별 Proxy를 통해 대화를 수집하고 기억을 주입한다. 로컬 배포 경로가 있으며 기본 전체 구성은 Core·Hub·Proxy다.
- Knowledge MCP의 12개 도구는 조회용이다. 생성·삭제·동기화 관리 작업은 이 MCP 표면에 노출되지 않는다.
- README는 Team Memory Beta라고 명시한다. 에이전트별 요청 형식·초기 세션 연결 조건이 있다.
- 확인한 배포 스크립트에는 Core gateway Bearer 인증과 Proxy 사이 호환성 제약이 명시되어 있고, Proxy의 auth/verify 호출에는 해당 Authorization 헤더가 없다. 그 구성을 그대로 포팅하지 않는다.
- **흡수 후보:** 공통 기억 인터페이스, 프로젝트/사용자/에이전트 범위, 검토·공유·출처·버전 관리 개념.
- **범위 제한:** 별도 공통 기억 서버를 병렬로 추가하거나 현재 모델 인증·요청 경로를 자동으로 Proxy에 연결하지 않는다. 개인 운영 1차 범위에서 팀 관리 전체를 재구현할 필요도 없다.

근거: [README](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/220af62226221d7ea07f95aa61eb7c0486cb407a/README.md), [MCP 도구](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/220af62226221d7ea07f95aa61eb7c0486cb407a/MemoryKnowledge/src/mcp/tools.ts), [배포 스크립트](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/220af62226221d7ea07f95aa61eb7c0486cb407a/deploy/global-images/start-memory-core.sh), [Proxy 인증](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/220af62226221d7ea07f95aa61eb7c0486cb407a/MemoryProxy/src/auth.ts).

### code-brain: 개발 문맥을 작게 제공하는 장점

- 리포별 `.ai/`에 개발 기억, BM25/FTS5 검색, 작은 context pack, 진단·감사·훅을 구성한다.
- Claude Code·Codex·Antigravity 설치 자산과 MCP가 있다.
- 결정/실패의 근거·재검증 시점, 작업 인수인계, 분량 제한, 작은 기본 도구 목록이 참고 대상이다.
- 설치 범위에는 에이전트 설정·Git 훅·스킬 등이 포함되고, MCP에는 워커 큐·실행 도구도 있다.
- README 설치·업그레이드 예제는 사용자가 지정한 소유자와 다른 `ezBuilder/code-brain` 경로를 가리킨다. 소스 출처와 업데이트 대상을 확인해야 한다.
- **흡수 후보:** 관련 문맥만 제한된 예산으로 공급, 결정/실패 기록의 근거·시점·상태, 단계적 도구 검색, 관측 가능한 사용량.
- **범위 제한:** 워커 오케스트레이터·전역 훅·개발 규칙 묶음을 통째로 설치하지 않는다. 자비스·Orca·기존 코드 탐색 도구와의 중복을 먼저 제거한다.

근거: [README](https://github.com/t1seungy/code-brain/blob/8e46f59b3bd7ed08ec9b73ffbc6736717266ffb7/README.md), [MCP 구현](https://github.com/t1seungy/code-brain/blob/8e46f59b3bd7ed08ec9b73ffbc6736717266ffb7/.ai/runtime/src/ai_core/mcp_server.py).

### jung-wan-kim/memory-bank: 대화에서 기억을 추출·재사용하는 장점

- SQLite·sqlite-vec 기반 대화 검색, 사실 추출, 프로젝트 범위, 원문 추적, 관계·충돌·대체 관리, MCP와 UI를 제공한다.
- 세션별 중복 주입 방지, 관련도 기준, 주입 분량 제한과 로그가 구현되어 있다. README의 속도·절감 수치는 저자 측 수치이며 우리 환경의 실측값이 아니다.
- 자동 수집·주입 훅은 `CLAUDE_PLUGIN_ROOT`에 의존한다. MCP로 다른 클라이언트가 조회하는 것과 다른 에이전트의 로그를 자동 수집하는 것은 다르다.
- `codingAgent` 분류/필터는 있으나 확인한 sync 경로는 동일한 Claude 형식 파서를 호출한다. 이 필드의 존재를 Codex·Antigravity 로그 수집 지원의 증거로 취급하지 않는다.
- 파서는 도구 결과를 tool_use에 연결하지 않으며 `tool_result`는 NULL, `is_error`는 0으로 남긴다고 명시한다. 이 구조로 실행 성공을 판정해서는 안 된다.
- **흡수 후보:** 원문으로 돌아갈 수 있는 사실, 중복·충돌·대체의 수명주기, 프로젝트별 기억, 세션별 주입 이력과 예산.
- **범위 제한:** Claude 전용 수집 형식, 도구 결과 생략, 의존성 자동 설치·개인 UI 묶음을 그대로 가져오지 않는다.

근거: [README](https://github.com/jung-wan-kim/memory-bank/blob/9ea9b62cf743d1f166e3425d73343532856a90a5/README.md), [훅](https://github.com/jung-wan-kim/memory-bank/blob/9ea9b62cf743d1f166e3425d73343532856a90a5/hooks/hooks.json), [수집](https://github.com/jung-wan-kim/memory-bank/blob/9ea9b62cf743d1f166e3425d73343532856a90a5/src/sync.ts), [파서](https://github.com/jung-wan-kim/memory-bank/blob/9ea9b62cf743d1f166e3425d73343532856a90a5/src/parser.ts#L140).

## 5. 세컨드브레인에서 먼저 대조할 기존 구현

발신 작업에서는 아래 파일의 **존재만 확인**했다. 구현 수준·활성화 여부·검증 통과를 의미하지 않는다. 대상 작업에서 이미 감사·수정한 결과가 있으면 우선 재사용한다.

- 안내·구성: `AGENTS.md`, `README.md`, `pyproject.toml`
- 검색: `sb/search.py`, `sb/hybrid_search.py`, `sb/sealed_search.py`, `tests/test_search.py`, `tests/test_search_incremental.py`
- MCP: `sb/mcp.py`, `sb/mcp_contract.py`, `sb/mcp_write_models.py`, `contracts/second-brain-mcp-v1.json` 및 `.sha256`
- 기억·보존: `sb/memory_records.py`, `sb/export_retention.py`
- 계약 테스트: `tests/test_mcp_contract_runtime.py`, `tests/test_mcp_profile_compatibility.py`, `tests/test_mcp_generation.py`
- 수명주기 테스트: `tests/integration/test_memory_lifecycle.py`, `test_memory_two_process.py`, `test_memory_crash_recovery.py`, `test_memory_restore_reingress.py`
- 운영 유닛: `systemd/user/jm-second-brain-requests.*`, `jm-second-brain-maintenance.*`, `deploy/systemd/second-brain*.service`

각 흡수 후보를 **이미 있음 / 연결·활성화 부족 / 구현 개선 필요 / 신규 필요 / 이번 범위 제외**로 분류한다. 파일명만 보고 기존 기능을 새로 만들지 않는다.

## 6. 자비스와 유지·검증할 계약

자비스 측 현재 참조 파일:

- `/home/jm/orca/projects/Orca-JARVIS/src/second-brain-contract.ts`
- `/home/jm/orca/projects/Orca-JARVIS/src/second-brain-transport-contract.ts`
- `/home/jm/orca/projects/Orca-JARVIS/src/second-brain-frozen.ts`
- `/home/jm/orca/projects/Orca-JARVIS/src/second-brain-adapter.ts`
- `/home/jm/orca/projects/Orca-JARVIS/src/second-brain-write-adapter.ts`
- `/home/jm/orca/projects/Orca-JARVIS/src/second-brain-readiness.ts`

확인한 메서드에는 `sb_search`, `sb_read_page`, `sb_recent_changes`, `sb_open_conflicts`, `sb_resolve_memory_target`, `sb_generation_status`, `sb_request_status`, `sb_write_request`가 있다. `sb_remember`도 계약 목록에 있으므로 프로파일별 실제 노출·호환성까지 확인한다.

요청·승인·처리 영수증, 중복 방지, 세대/스냅샷, 정정·삭제·복원 이후 재유입 방지의 기존 규칙을 파악한 후 변경한다. 계약 확장이 필요하면 버전과 이전 클라이언트 호환 테스트를 설계한다. 해시나 계약 검사만 완화해서 통과시키지 않는다.

자비스 작업에서는 앞서 실행 lease 복구와 단건 명령 조회를 수정했다. 세컨드브레인 연동 완성이나 운영 배포 완료를 의미하지 않는다. 당시 운영 DB의 작업 관련 여러 테이블이 0행이었으나 이는 과거 관측이다. 현재 대상 작업의 상태를 재확인한다.

자비스의 상세 내부 문제 목록: `/home/jm/orca/projects/Orca-JARVIS/docs/improvement-backlog-2026-09-07.md`. 기존 변경·검증 기록: `/home/jm/orca/projects/Orca-JARVIS/docs/runtime-maintenance.md`. 자비스 쪽 결함을 세컨드브레인의 우회 코드로 해결하지 않는다.

## 7. 제안하는 구현 순서

사용자가 기능별 우선순위까지 확정한 것은 아니다. 아래 순서는 현재 지시를 구현하기 위한 제안이며 실제 결함과 의존관계에 따라 조정한다.

| 순서 | 작업 | 완료 증거 |
|---|---|---|
| 0 | 기존 코드·운영·대상 작업 변경 확인, 중복 기능표 작성 | 파일/심볼/테스트/운영 관측으로 각 후보 분류 |
| 1 | 자비스와 기존 기억 읽기→저장 요청→완료 확인→재조회 연결 | 양쪽 계약을 거친 식별 가능한 한 요청의 결과 |
| 2 | 공통 에이전트 접근과 클라이언트별 수집 경계 정리 | 실제 사용 에이전트 목록별 조회·쓰기·수집·주입 지원표 |
| 3 | 근거·출처·프로젝트 범위·중복·정정/철회 수명주기 보강 | 같은 사건 재수집 및 반대 사실 입력에도 추적 가능한 결과 |
| 4 | 관련 기억 선택·세션 내 중복 방지·문맥 예산 | 주입 근거/버전/분량/지연 로그와 회귀 테스트 |
| 5 | 검색 품질 측정 후 하이브리드 검색·관계 확장 개선 | 동일 질문 세트의 기준선 대비 결과; 효과 없는 복잡성 제외 |
| 6 | 최소 운영 가시성 | 원문·근거·처리 실패·검색 준비 상태를 확인할 수 있는 기존 화면/API 개선 |

1차부터 별도 위키·검색·기억·프록시 서버를 모두 띄우거나 팀 관리 전체를 구현하지 않는다. 라이브러리/알고리즘/계약 일부만으로 목적을 달성할 수 있는지 먼저 확인한다.

## 8. 검증 시나리오와 완료 기준

서비스가 active이거나 MCP 도구 목록이 보이는 것만으로 완료 처리하지 않는다. 의미 있는 테스트 데이터로 아래를 확인한다.

1. **에이전트 간 기억 공유:** A가 기록한 결정을 B가 원문·프로젝트·버전과 함께 회수한다. 서로 다른 에이전트/연결부를 사용한다.
2. **자비스 통합:** 기억 조회→작업 결과 검증→저장 요청→영수증/상태 확인→다음 요청에서 재사용한다. 요청 ID와 근거를 연결한다.
3. **중복:** 동일 원본/요청 재전송·재수집이 중복 기억이나 외부 효과를 만들지 않는다.
4. **정정·철회:** 대체된 결정은 최신 답변에서 유효한 결정처럼 제시되지 않고 이전 출처는 추적 가능하다.
5. **실패 증거:** 실패·미확정 도구 실행이 성공 경험으로 승격되지 않는다.
6. **범위:** 허용되지 않은 프로젝트·사용자 범위가 검색/관계 확장/원문 조회로 노출되지 않는다.
7. **삭제·복원:** 삭제가 파생 검색 결과에도 반영되고 복원·재색인 시 억제된 기억이 되살아나지 않는다.
8. **동시성·복구:** 둘 이상의 작성자, 처리 중 종료, 재시작에서 변경 유실·중복 완료가 없는지 검증한다.
9. **검색·분량:** 한글 개발/업무 질문과 근거 문서를 고정한 평가 세트로 정답 근거 회수, 오래된 결정 노출, 지연, 주입량을 비교한다. 저자 벤치마크를 우리 성능으로 보고하지 않는다.

자동 테스트에서 확인한 것과 실제 클라이언트/운영 경로로 확인한 것을 구분한다. “모든 에이전트”는 사용 중인 클라이언트 목록을 먼저 확정하고 각 항목의 실측으로 표현한다. MCP 호환성만으로 자동 수집·수정·문맥 주입까지 보장하지 않는다.

## 9. dev-wiki 관련 이전 분석

- 최신 역할 선언과 과거 me-wiki의 개인/업무 페이지가 혼재되어 있었다.
- 일부 기존 프로젝트 페이지는 7월 기준이고 안내 경로가 현재 존재하지 않았다.
- 민감도 규칙은 frontmatter 없는 파일을 T2로 취급하나 주요 진입 문서에 메타데이터가 없었다. 대상 작업은 읽기 정책을 먼저 확인한다.
- 이 문제는 저장 도구 교체만으로 해결되지 않는다. 정본·역사 문서·자동 파생 기억을 구분해야 한다.
- dev-wiki 폐기·자동 수정·전체 색인은 이번 사용자 최종 방향에서 확정되지 않았다.

## 10. 인수 작업에 요청하는 결과물

1. 기존 구현과 네 오픈소스 장점의 대조표: 유지/재사용/개선/제외 및 근거.
2. 세컨드브레인 중심의 작은 구현 계획: 기존 코드에서 바꿀 지점, 없어지는 중복, 자비스 계약 영향.
3. 실제 개선 코드와 적절한 계약·수명주기·통합 검증. 이미 완료한 작업이 있으면 재사용하고 미완료 부분부터 진행.
4. 코드 재사용이 있으면 출처·커밋·라이선스 고지.
5. 자비스 작업공간에 전달할 변경 계약과 연동 검증 결과. 실제 배포/재시작 권한은 대상 작업의 기존 사용자 지시와 저장소 운영 규칙을 확인한다. 본 인계만으로 운영 변경까지 승인됐다고 간주하지 않는다.

발신 작업에서 추가 세컨드브레인 구현은 하지 않는다. 수신 작업은 이 방향을 기존 목적에 병합해 작업을 이어간다.

## 11. 필요 시 대상 작업에 붙여 넣을 전달문

수신 통합 계획에 이미 병합된 방향이다. 아래 문구는 재개 시 참조용이며, 기존 구현을 처음부터 반복하라는 요청이 아니다.

```text
자비스 작업공간에서 논의한 방향을 이 세컨드브레인 작업에 병합해 진행해줘.

인계 문서:
/home/jm/orca/projects/Orca-JARVIS/docs/second-brain-oss-absorption-handoff-2026-09-07.md

확정 방향은 세컨드브레인을 기반으로 유지하면서 LightRAG, TencentDB-Agent-Memory,
code-brain, jung-wan-kim/memory-bank의 필요한 장점만 흡수하는 것이다.
1차 목표는 자비스와 세컨드브레인의 실제 운영이며, 여러 에이전트가 공통 기억에 접근해야 한다.

이 작업에서 이미 진행한 변경과 검증을 먼저 확인하고, 인계 문서의 후보들을
기존 구현/연결 부족/개선 필요/신규 필요/보류로 대조한 뒤 필요한 개발을 이어가줘.
자비스는 실행·승인·결과 검증, 세컨드브레인은 기억 관리,
dev-wiki는 리포 간 개발 결정과 운영 규칙의 정본이라는 경계를 유지해줘.

우선 자비스의 기억 조회→저장 요청→처리 결과 확인→재조회와
서로 다른 에이전트 간 기억 공유를 실제 연결 경로로 검증해줘.
그다음 출처·범위·중복·정정·삭제, 문맥 주입 예산, 검색 품질 순으로 보강해줘.
모든 에이전트 지원은 클라이언트별 조회/쓰기/수집/주입 검증표로 표현해줘.
네 제품 일괄 설치나 dev-wiki 폐기는 확정된 사항이 아니다.
자비스 쪽 계약 변경이 필요하면 영향과 호환성 검증 결과를 정리해줘.
```
