# c0c0382 재검토 — 허용되지 않은 행 누락, 2026-09-11

## 판정

**R2 인수 보류.** 새 후보 검사는 외래 행의 혼입을 검사하지만, 삭제 대상으로 선정하지 않은 행의 누락을 허용한다. 실제 ATTACH 전후에 파일을 교체하고 되돌리는 결정적 테스트에서, 삭제 선정 0건인데 원본의 작업 1건이 후보에서 사라지고 재검증까지 통과했다.

대상 worktree는 `/home/jm/orca/workspaces/Orca-JARVIS/codex-routing-approval-ui`, 검토 HEAD는 `c0c03821fa1dac963ca02b93eb00b663f99fd45f`다. 제품 코드·테스트·migrations를 수정하거나 새 전체 verify를 시작하지 않았다. 진행 중인 Opus의 verify와 HEAD를 유지하기 위해 이 리뷰 문서는 커밋하지 않았다.

## 확인한 개선과 현재 gate

- c7cc50b: `/proc/self/fd`를 통한 열린 파일 식별과 pathname 대조, 기존 두 journal 조합 거절 테스트가 추가돼 있다.
- c0c0382: COUNT(*) 대조 대신 후보 행이 원본에 존재하는지 검증한다. 관련 결과 로그는 consistency 13개, 회귀 11파일/62개 통과를 기록한다.
- `verify-provenance.log`는 c0c0382 입력을 빌드했고 architecture 658모듈/2,444간선/순환 0, backend shard 1 275파일/1,886테스트 통과를 확인했다. 검토 중 shard 2가 진행 중이며 전체 RC는 아직 확인하지 않았다.
- 현재 소스 input digest와 dist artifact digest를 다시 계산해 실행 metadata와 각각 일치함을 확인했다. input=`sha256:4a7f7b917a81c0df35758d4046c4e4b12398c558fb6ccae0e1efb2db311d4a17`, artifact=`sha256:ad72695b70f5485803803b4ce05e4add55ad4caf7bb59c2310588e850eacdc40`.

전체 verify가 통과하더라도 아래 신규 반례를 덮는 회귀는 별도로 필요하다. monitor `mon_AEJYKFTYV96Q7P2P`의 종료 처리는 소유 세션에서 계속하고, 이 리뷰에서 임의 종료하지 않는다.

## P1 — 부분집합 검사만으로는 허용된 삭제인지 판정할 수 없음

위치: `src/local-observation-retention-candidate.ts:56`, 특히 후보 행을 차감한 뒤 남은 원본 행을 검사하지 않는 `:72` 이후.

함수 `assertCandidateRowsCameFromSelection(source, destination)`는 selection을 받지 않는다. 따라서 후보에서 없어진 원본 행이 실제 삭제 대상으로 선정된 행인지 구분할 수 없다. “retention이 행을 삭제하므로 후보가 부분집합이면 정상”이라는 주장은 너무 넓다. 정상 조건은 **명시적으로 허용된 삭제·변환을 정확히 적용한 결과와 후보가 일치**하는 것이다.

### 실제 ABA 재현

테스트 전용 Node 프로세스에서 native SQLite ATTACH 호출만 잠시 감싸 파일 rename 시점을 제어했다. 제품 함수·복사 SQL·검증 함수·복사된 행은 수정하지 않았다. 잠깐 끼워 넣은 wrapper는 원래 statement.run을 그대로 호출하며 finally에서 원본 pathname을 복구한다. OS 스케줄러의 우연한 타이밍을 기다리는 부하 시험과는 구분한다.

1. 원본을 migrate한 뒤 그 원본의 SQLite backup으로 별도 DB를 만든다. 같은 초기 행을 가진 이 대체 파일은 DELETE journal mode다.
2. 정상 WAL 원본에 `gjc_intents` 작업 `must-keep` 1건을 추가한다. local observation은 없으므로 cutoff에 선정되는 삭제는 0건이다.
3. 교체 없는 대조군에서 apply를 실행하면 후보에도 작업 1건이 보존되고 재검증에 통과한다.
4. 두 번째 apply에서 native ATTACH 직전에 원본을 잠시 다른 이름으로 옮기고 대체 파일을 원본 pathname으로 옮긴다. ATTACH가 열린 직후 원래 pathname을 복원한다. 후보의 attachment는 대체 파일을 계속 읽는다.
5. 나머지 빌드와 검증을 수정 없이 실행한다.

| 신호 | 실측 |
|---|---|
| ATTACH 교체 횟수 | 1 |
| 원본 pathname 복구 | true |
| selection.blocked / retained | [] / [] |
| 원본 작업 수 | 1 |
| 정상 대조군 후보 작업 수 | 1 |
| ABA 후보 작업 수 | **0** |
| apply 오류 | null, 성공 |
| 후보 재검증 | **accepted** |

원본을 실제 후보로 교체하지 않았으므로 운영 데이터 손실이 발생했다는 뜻은 아니다. 하지만 반환된 후보를 후속 교체 절차가 사용하면 선정과 무관한 작업이 사라진다. 원본 이름과 fd 식별자가 마지막에 복구되고 후보가 원본의 부분집합이므로 현 검사는 이 결과를 허용한다.

## 후속 작업 지시와 완료 기준

1. 위 재현을 먼저 회귀로 추가한다. 실패 기준은 `blocked=[]`인데 관련 없는 작업이 줄어든 후보가 성공 반환되는 것이다. test-only hook 또는 scoped mock으로 native ATTACH 전후 실제 rename을 제어할 수 있으므로, “단일 스레드에서는 결정적 재현 불가” 문장을 해당 테스트 범위에 맞게 정정한다.
2. 후보를 원본의 임의 부분집합으로 허용하지 않는다. 선택된 삭제 closure와 명시적 열 변환·재생성만 적용한 **예상 결과**를 정의하고 값·개수 양방향으로 검증하거나, 선정이 사용한 동일 연결의 snapshot에서 복사하도록 경로를 바꾼다. 실제 복사 필터와 검증 규칙은 공유해 서로 다른 규칙으로 어긋나지 않게 한다.
3. 기존 FOREIGN_ROW 검사는 유지하되, 원본에서 후보로 누락된 각 행도 허용된 삭제인지 확인한다. 비교 제외 표와 변환 열은 자체 계약을 검증하고, 제외 자체를 모든 변조의 허가로 사용하지 않는다.
4. 필수 매트릭스: 정상 복사, 명시적 retention 삭제, 참조 때문에 보존하는 그룹, 외래 행 혼입, 선정되지 않은 행 누락, ATTACH ABA, 복사 중 notification/replacement 변경, 원본 보존과 실패 후보 정리. 기존 destination 보호 회귀도 유지한다.
5. 관련 테스트 후 제품 변경이 통합된 시점에 전체 verify를 실행한다. 이번 실행은 c0c0382의 결과로 보존하고, 후속 변경의 결과로 소급하지 않는다. 변경된 R2 전체를 재검토한 뒤 종료 판정을 기록한다.
6. 급사 시 부분 파일이 남고 재시도가 거절되는 한계는 별도 복구 작업으로 유지한다. 이미 존재하는 파일을 무조건 삭제하는 방식으로 복구하지 않는다. 이 수정에 운영 교체·재시작은 필요하지 않다.

## Reflection 경고와 Todo

사용자가 전달한 `reflection-run-93` 경고는 memory reflection의 `spawn_failed` 및 transcript cursor 미진행을 보고한다. 제품 `src/scripts/package.json`에서는 같은 reflection 메시지/명령을 찾지 못했다. 따라서 이를 JARVIS verify 실패나 제품 커밋 유실의 증거로 취급하지 않는다. reflection 내부 모델 선택과 복구 상태는 이 리뷰에서 확인하지 않았으며 모델 설정을 변경하지 않았다.

Todo의 첫 단계만 진행 중이라는 표시는 현재 커밋·대상 테스트 기록과 맞지 않는다. 기존 경로 재현/동일 행 수 회귀는 완료한 범위로 표시하고, **R2 누락 방어·현재 전체 gate 종료·최종 기록·R2 전체 재검토**를 미완료로 유지한다.

## 재현 증거

- `/home/jm/.cache/jarvis-r2-copy-review-20260911/aba-omission.mjs`
- `/home/jm/.cache/jarvis-r2-copy-review-20260911/aba-omission-result.json`
- `/home/jm/.cache/jarvis-r2-copy-review-20260911/build-identity.json`

실행: `node /home/jm/.cache/jarvis-r2-copy-review-20260911/aba-omission.mjs`.
이 스크립트는 관찰값을 출력하며 테스트 프로세스 안의 native prepare wrapper를 finally에서 복원하고 전용 fixture를 정리한다. 종료 코드 0은 스크립트 실행 완료이며, 제품의 수정 완료 판정은 아니다. 원본 리뷰 증거와 다른 작업의 산출물은 변경하지 않았다.
