# Codex → opus5/OmO: claim 대장 재검토와 최종까지의 수행 지시

2026-09-11. 사용자 요청: 최신 구현 확인, 기존 opus5/OmO에 직접 지시 전달, 30분마다 진행 감시.

## 1. 현재 판정

**확보 대장 도입은 확인했지만, 이번 배치는 인수할 수 없다. 기존 파일 삭제와 소유 미확인 디렉터리 삭제를 compiled 제품으로 재현했다.** 복구 9/9는 해당 테스트의 통과이며 목적지 보호나 전체 복구 소유권을 증명하지 않는다.

- 확인 HEAD: `49783df`; 직전 제품 gate 기준은 `0af1025`.
- 확인 시 미커밋: operation/recovery/apply 소스 3개, 신규 `095_local_retention_claim_intents.sql`.
- terminal의 실제 출력에서 recovery 1파일/9테스트 통과, 20.09s를 확인했다. typecheck/lint RC 0은 담당자 보고이며 이번 Codex 확인에서 재실행하지 않았다.
- Codex는 제품 소스·테스트·migration·dist를 변경하거나 전체 gate를 시작하지 않았다. 다음 반례는 자기 QA 디렉터리의 합성 DB/파일만 사용했다.
- QA: `/home/jm/.cache/jarvis-codex-claim-review-20260911-4ztfcjp6`.
- `claim-ownership-repro.mjs`, `result.json`, `run.stdout.log`, `run.stderr.log`를 확인한다. 제품 dist 모듈 4개의 실행 전후 SHA256이 같았다. 새 빌드에서 재실행할 때 원본 결과를 덮어쓰지 말고 스크립트를 새 QA 디렉터리에 복사한다.

## 2. P1-C1: 확보 실패 시 기존 목적지까지 삭제

위치: `src/local-observation-retention.ts`, `applyLocalObservationRetention()`의 `claimRetentionOperation()`/snapshot 호출을 감싼 첫 catch.

실행 순서가 intent 기록 → mkdir → 실패 catch의 무조건 `releaseRetentionOperation(directory)`다. mkdir 실패는 이 호출이 그 디렉터리를 소유한다는 증거가 아니다. 기존 파일·디렉터리를 지정하면 올바른 오류를 반환하면서 지정 대상도 삭제한다.

| 합성 입력 | 오류 | sentinel 보존 | 목적지 존재 |
|---|---|---|---|
| 기존 디렉터리 + sentinel.txt | LOCAL_RETENTION_DESTINATION_INVALID | **false** | false |
| 기존 파일 sentinel | LOCAL_RETENTION_DESTINATION_INVALID | **false** | false |

수정 요구:

1. 경로 resolve, intent, 실제 배타 확보 성공, 산출물 생성의 소유 상태를 구분한다.
2. mkdir/EEXIST/권한 오류 등 확보 실패 경로에서 기존 대상을 삭제하지 않는다. 확보에 성공한 뒤의 실패만, 그때 만든 객체의 소유권이 여전히 입증될 때 정리한다.
3. catch에 단순 boolean 하나를 추가하는 것으로 끝내지 말고 확보 이후 경로 교체·symlink·경쟁 호출·중간 파일 실패도 검증한다.
4. 기존 destination 회귀를 전체 실행한다. 기존 파일/디렉터리/별칭/sidecar 보존, 동시 두 호출의 승자 보호, 정상 실패 정리까지 포함한다.

## 3. P1-C2: intent는 생성 의도이며 파일 소유 증거가 아님

위치: `src/local-observation-retention-recovery.ts`, `recoverUnrecordedClaims()`의 `rmSync(directory, {recursive:true,force:true})`.

별도 child process가 실제 `recordRetentionClaimIntent()`만 호출하고 종료하도록 했다. 디렉터리 생성은 전혀 하지 않았다. 그 경로에 미리 둔 외부 소유를 나타내는 합성 sentinel 디렉터리에 대해 부모 process가 실제 recover를 실행했다.

- intent 1행, 운영 행 없음, 기록한 child 종료 확인.
- recovery=`removed_partial`, sentinel 보존=false, intent 0행.

즉 “만들려고 했다 + 프로세스가 종료됐다”를 “실제로 만들었고 지금도 자기 객체다”로 간주하고 있다. migration 주석의 bookkeeping/not authority와 실제 삭제 동작도 어긋난다.

수정 요구:

1. intent-only, 배타 확보 완료, identity 확인, operation 연결 상태를 구분한다. intent만으로 기존 파일을 재귀 삭제하지 않는다.
2. 생성 이전 크래시, 생성 직후 identity 기록 이전 크래시, snapshot 복사 중 크래시, operation 기록 전후를 별도 barrier로 시험한다. 현재 9개 회귀의 `after_claim`이 실제로 어느 SQL/파일 작업 뒤인지 확인한다.
3. 미입증 객체는 `retained_unproven` 등 명시 상태로 보존한다. 자기 고아를 끝까지 식별·회수할 수 있는 프로토콜은 별도로 완성하고, 미입증 객체 삭제로 고아 수만 0으로 만들지 않는다.
4. owner 생존 판단은 alive/dead/unknown을 구분한다. `/proc` 읽기 실패나 누락 start token을 자동으로 dead로 간주해 삭제하지 않는다. PID 재사용·부팅 구분·같은 프로세스 내 진행 중 apply와 recover의 경합도 다룬다. 현재 `pid===process.pid`를 false로 처리하는 경로를 특히 회귀로 검토한다.
5. intent→operation 전환의 operation_id·owner identity·정리 원자성, operation은 생겼지만 intent가 남은 경우의 수렴도 검증한다.
6. private directory의 0700 모드만으로 같은 UID의 다른 호출이 경로를 바꾸지 못한다고 단정하지 않는다. 소유권 검증과 삭제 사이 경합, 교체된 부모/후보/snapshot/sidecar의 보존을 검증한다.

## 4. 교체 구간 배타성: 개발 작업으로 이어갈 것

통합 지시서 `docs/claude-completion-instructions-2026-09-11.md` M2는 이미 프로세스 간 writer 배타성 또는 동등한 CAS/fence와 실제 child process 인수를 요구했다. 사용자는 최종까지 진행하도록 재확인했다. **이 개발 설계를 일반적인 “소유자 결정 대기”로 넘기고 중단하지 않는다.** 실제 운영 활성화·서비스 drain/재시작과 소스/격리 구현은 구분한다.

개발 방향은 기존 authority/runtime 경계에 결합한 공유 writer/swap 조정이다. 먼저 모든 지원 writer·open/reopen 진입점을 목록화하고, 가장 작은 일관된 경계에서 공통 lease/세대 검사를 적용한다. 기존 runtime/compaction 계약을 재사용한다. 실제 API 설계는 담당자가 근거와 회귀로 결정한다.

- retention끼리만 지키는 lock은 충분하지 않다. 다른 제품 writer의 커밋과 candidate 변경도 교체 구간을 관통하지 못해야 한다.
- 같은 inode의 SQLite lock만 쥔 뒤 연결을 닫고 rename하면 보호가 사라진다. 열린 구세대 연결의 재개·새 연결의 유입까지 다룬다.
- 마지막 byte 비교를 한 번 더 넣는 것은 배타성의 대체가 아니다. 서로 다른 프로세스가 마지막 확인 직후 실제 커밋하는 재현을 barrier로 만든다.
- 등록하지 않은 연결/협조하지 않는 writer를 안전하게 배제할 수 없으면 **파괴적 교체 전에 거절**한다. 데이터를 잃은 뒤 old-fd 발견/error 반환은 인수가 아니다.
- 대상 목록화→공통 계약→격리 구현→별도 writer/reader/죽은 owner/재시작 인수를 수행한다. product 전체 영향 때문에 필요한 ADR은 작성하되 ADR 작성만으로 종료하지 않는다.
- “현상 유지 + 한계 명시”를 교체 안전성 완료의 세 번째 선택지로 채택하지 않는다. 안전한 교체가 불가능한 환경에서는 비활성/거절 상태와 완성된 운영 전제조건을 제시한다.
- 운영 DB/설정/current 전환·서비스 재시작·권한 우회는 하지 않는다. 그 단계만 최종 적용안의 운영자 경계로 남긴다.

## 5. 다음 순서와 제출 기준

1. 현재 본인 변경과 gate 상태를 확인한다. 이미 진행 중인 검증의 입력을 바꾸지 말고 그 run의 범위를 정확히 기록한다.
2. P1-C1/C2를 정식 실패 회귀로 등록하고 소유권·복구 프로토콜을 함께 고친다. 기존 destination/shared builder/retention 회귀를 포함한다.
3. 배타성을 구현·격리 검증하고, 통합 지시서 M0–M6의 내부 개발 잔여를 끝까지 진행한다. 이미 해결된 부분은 재작성하지 않는다.
4. 다른 설계 보류도 최신 계약과 기존 권한으로 재평가한다. 프로젝트 범위의 위치 등 개발 가능한 설계는 기존 TaskSpec의 검증된 scope와 명시 정책을 기준으로 결정한다. 출처가 모호하면 fail-closed로 처리하고 임의 project/owner authority는 만들지 않는다.
5. 실제 provider 계약/인증이 없는 일만 구체적 adapter·계약/patch·검증 harness·재개 조건을 갖춘 외부 잔여로 남긴다. 기존 “외부 항목뿐” 선언을 그대로 복사하지 않는다.
6. 내부 리뷰와 수정 루프가 끝난 안정된 입력에 전체 verify·최신 패키지·필요 프로세스 인수를 수행한다. 새 코드가 있는데 `0af1025`의 gate/제출물을 현재 제품 검증으로 사용하지 않는다. 그 결과는 과거 기준점으로만 유효하다.
7. 마지막에 `claude-completion-final-reply-2026-09-11.md`와 증거 manifest를 갱신하고 Codex에 최종 검증을 요청한다. 단위별 “다음 턴에 계속”으로 끝내지 않는다.

## 6. 전달·감시 방식

수신 대상은 Orca가 반환한 기존 `OmO - Resume Orca-JARVIS Prior Task - Orca-JARVIS`, handle `term_bd29da1904a5081e923206072f55d514`다. Orca context는 `/home/jm/orca/projects/Orca-JARVIS`지만 제품 작업 경로는 위 개발 worktree다. 모델의 실제 실행 식별자는 별도로 입증하지 않았다.

이 Codex desktop 세션에는 Orca sender terminal이 없어 orchestration 조회가 `no_active_sender_terminal`로 거절됐다. 다른 사람의 `--from`을 사칭하거나 새 구현 worker를 만들지 않는다. 기존 TUI에 직접 지시를 전달하고, Orca의 정기 automation으로 읽기 위주의 진행 감시를 설정한다. 정식 Run/Dispatch를 생성한 것으로 기록하지 않는다.

감시는 30분마다 수행한다. 새 완료 후보·검증 실패·실제 판단 필요·실행 가능한 작업이 남은 명확한 중단만 알린다. 동일 상태나 reflection 경고만으로 재촉하지 않는다. 기존 worker가 작업 중이면 방해하지 않고, 명확한 중단이면 이 지시 범위의 재개를 1회 전달하고 응답/실제 도구 실행을 확인한다. 같은 원인에 2회 재개해도 반복 중단하면 추가 자동 전송을 중지하고 알린다. 사용자 중단 요청을 우선한다.

최종 후보는 새 SHA·검증 입력·receipt·P1 응답·최신 package를 확인해 Codex 최종 검증 대상으로 알리며 감시를 종료한다. 감시자가 제품을 수정하거나 최종 인수를 승인하지 않는다.
