export const copy = {
  title: "JARVIS 현황판",
  skip: "본문으로 건너뛰기",
  navLabel: "주요 메뉴",
  nav: {
    today: "오늘",
    overview: "한눈에",
    tasks: "작업",
    proposals: "새 제안",
    agents: "에이전트",
    approvals: "승인",
  },
  liveUpdates: "실시간",
  connected: "연결됨",
  disconnected: "끊김",
  cards: {
    work: "지금 하는 일",
    agents: "에이전트",
    approvals: "승인 대기",
    risks: "위험",
  },
  cardEmpty: {
    work: "진행 중인 일 없음",
    agents: "연결된 에이전트 없음",
    approvals: "대기 중인 승인 없음",
    risks: "열린 위험 없음",
  },
  recent: "최근 일",
  noRecent: "최근 기록이 없습니다",
  noApprovals: "대기 중인 승인이 없습니다",
  noRisks: "열린 위험이 없습니다",
  noAgents: "연결된 에이전트가 없습니다",
  portfolio: {
    kicker: "맥북과 JM 서버",
    title: "두 컴퓨터 현황",
    lead: "지금 각 컴퓨터가 얼마나 바쁜지, 깃허브에 뭐가 열려 있는지를 보여줍니다.",
    host: {
      local: "맥북",
      "jm-server": "JM 서버",
    },
    freshness: {
      live: "방금 갱신",
      stale: "조금 오래됨",
      unseen: "아직 없음",
      offline: "끊김",
    },
    updated: "갱신",
    metrics: [
      ["작업 폴더", "worktree_count"],
      ["터미널", "terminal_count"],
      ["깨끗한 폴더", "clean_count"],
      ["손본 폴더", "dirty_count"],
      ["고친 파일", "dirty_path_count"],
      ["진행 작업", "active_task_count"],
    ] as const,
    github: "깃허브에서 열린 일",
    issues: "이슈",
    pulls: "풀 리퀘스트",
    milestones: "개발 일정",
    blockers: "지금 막힌 일",
    collector: "수집기",
    noReport: "아직 받은 기록이 없습니다",
    unavailable: "숫자를 아직 모으지 못했습니다",
    milestoneState: {
      done: "완료",
      in_progress: "진행 중",
    },
  },
} as const;

export function hostLabel(environment: string, fallback: string): string {
  if (environment === "local") {
    return copy.portfolio.host.local;
  }
  if (environment === "jm-server") {
    return copy.portfolio.host["jm-server"];
  }
  return fallback;
}

export function freshnessLabel(value: string): string {
  if (value === "live") {
    return copy.portfolio.freshness.live;
  }
  if (value === "stale") {
    return copy.portfolio.freshness.stale;
  }
  if (value === "unseen") {
    return copy.portfolio.freshness.unseen;
  }
  return copy.portfolio.freshness.offline;
}

export function milestoneStateLabel(state: string): string {
  return state === "done" ? copy.portfolio.milestoneState.done : copy.portfolio.milestoneState.in_progress;
}
