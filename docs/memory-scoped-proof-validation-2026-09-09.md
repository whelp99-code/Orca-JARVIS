# Scoped 완료 proof·영수증·독립 세대 대조

2026-09-09. 세컨드브레인의 실제 v4 proof/receipt를 자비스 요청·수락 응답 및 별도로 읽은 세대와 대조하는 내부 검사를 추가했다.

## 구현·검증

`verifySecondBrainScopedProof`는 정확한 필드/버전, 요청·provider·scope ID, 원문 UTF-8 SHA256, generation/head/tree를 대조한다. receipt의 proof hash와 status hash를 재계산하고 완료 시각이 수락 이후·관측 시각 이전인지 검사한다. 기존 generation binding parser와 accepted parser를 재사용한다. 요청 만료 뒤의 과거 결과 검사는 쓰기 권한을 갱신하지 않는다.

- 실제 Python 실행 결과를 기반으로 한 unit fixture와 수락 원장 검사: **26 passed / 4.49초**.
- proof 내용과 proof/status hash를 함께 재계산해 바꾸어도 요청/범위/provider/본문/세대가 다르면 거부한다.
- 미완료·실패 receipt, 해시 손상, 미래/과거 시간, 추가 필드와 다른 독립 세대를 거부한다.
- 최종 타입 검사·변경 파일 ESLint(max-warnings=0)·격리 emit 통과.

실제 내부 인수에서는 JARVIS의 CLI/서명 fixture로 생성한 요청을 Python provider가 수락하고 proved까지 처리했다. 또 다른 Python 프로세스가 결과 세대의 `load_verified_manifest`로 파생 inventory/자료 무결성을 확인하고 binding을 반환했다. 새 자비스 프로세스는 이를 실제 proof·receipt와 대조했다. head가 다른 독립 binding은 거부했다.

Python4/소비 Node4, 총 **8개** 독립 프로세스. 수락 commit 후 exit73과 새 소비자의 replay도 포함한다. 최종 proof/세대 일치, 수락 event1, FK오류0, 자비스 reconciling 유지. [결과](../../second-brain-app/SCOPED-PROOF-VALIDATION-2026-09-09.json).

재현: JARVIS 루트에서 `TMPDIR=/var/tmp node /home/jm/orca/projects/second-brain-app/scripts/scoped-proof-acceptance.mjs <격리 TypeScript 빌드 경로>`.

## 발견된 P0와 적용 보류

별도 재현에서 같은 본문·다른 프로젝트 접근 분류가 **같은 generation ID/ledger manifest digest**를 생성했다. 실제 각 프로젝트의 허용/거부는 정상적으로 달랐다. [원인·독립 읽기4건·다음 수정 조건](../../second-brain-app/SCOPED-GENERATION-IDENTITY-AUDIT-2026-09-09.md).

이 때문에 새 API의 결과는 `proof_consistent`이다. 해시/요청/관측 세대의 일치를 표현하며, 접근 분류까지 완전히 입증했다는 판정이 아니다. 이 결과만으로 scoped outbox를 settled 또는 control completed로 만드는 연결은 보류한다. generation의 접근 분류 결합과 독립 scoped artifact 검증이 선행되어야 한다.

Hash는 발신자 인증을 대신하지 않는다. 인수는 고정 시각의 fixture authority와 격리된 세대이며 운영 인증·전송이나 동시에 변경되는 운영 세대의 read pin 검증이 아니다. 공개 v4 MCP/영수증 계약, 운영 verifier, 완료 기록과 M1~M14 전체 인수는 계속 남는다. 운영 배포·서비스 재시작·push는 수행하지 않았다.
