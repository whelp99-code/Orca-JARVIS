# 현재 릴리스의 의존성 재사용 검사

두 `ops/*/publish-verified-release.sh`는 현재 control-center 릴리스의 node_modules를 복사해 새 코드와 함께 배포한다. 2026-09-09 읽기 전용 점검에서 그 릴리스에 새 코드가 요구하는 `@modelcontextprotocol/sdk`가 없음을 확인했다. 기존 모듈 묶음을 그대로 재사용하는 전환은 보류한다.

`scripts/check-release-dependency-reuse.mjs <workspace> <dependency-release>`는 파일을 변경하지 않고 다음을 확인한다.

1. package-lock.json bytes가 동일하다.
2. 작업공간 package.json의 production dependencies가 lock의 root metadata와 일치한다.
3. 모든 직접 runtime dependency의 설치 버전이 lock의 node_modules entry와 일치한다.

두 publisher는 이 검사를 build 전에 실행하고, 복사된 stage도 다시 검사한다. 불일치 때 build·manifest 생성·current 교체까지 진행하지 않는다. 자동 npm install이나 기존 릴리스 수정으로 해결하지 않는다.

검증9개 통과(0.44초 test 실행, 전체 Vitest0.649초). 두 실제 Bash publisher를 임시 runtime/가짜 verifier·npm으로 실행해 build 전 lock 불일치 및 build 중 package 제거를 거부하고 current가 유지되는지 확인했다. 테스트 환경의 승인 값은 임시 경로 시험에만 적용했으며 운영 publisher는 실행하지 않았다. TypeScript 격리 emit·ESLint·JS/Bash 구문·diff 검사 통과.

실제 작업공간의 직접 runtime dependency7개는 통과했다. 실제 운영 dependency release를 읽은 검사는 RELEASE_DEPENDENCY_LOCK_MISMATCH로 거부했다. 당시 release는 artifact-4146a192b5fb9e489e2ce3fcb9629077739df0134bc26094750628369dcfdb98이며 SDK package.json은 없었다.

이 검사는 전체 transitive dependency closure, 파일 내용 봉인, native ABI, 실행 호환성을 대신하지 않는다. 정본 release 절차의 sealed manifest·exact migration vector·provider contract·실행 gate를 유지한다. 현재 lock에서 준비·검증한 dependency artifact를 갖추기 전 운영 전환은 보류한다. 운영 배포·서비스 재시작·current 변경은 하지 않았다.
