import { useEffect, useState } from "react";
import type { PersonalTodayProjection } from "../../../src/personal-operating-read.js";

type TodayPageProps = Readonly<{
	load: () => Promise<PersonalTodayProjection>;
}>;

export function TodayPage({ load }: TodayPageProps) {
	const [state, setState] = useState<
		Readonly<{
			status: "loading" | "ready" | "error";
			data?: PersonalTodayProjection;
		}>
	>({ status: "loading" });
	useEffect(() => {
		let mounted = true;
		void load()
			.then((data) => {
				if (mounted) setState({ status: "ready", data });
			})
			.catch(() => {
				if (mounted) setState({ status: "error" });
			});
		return () => {
			mounted = false;
		};
	}, [load]);
	if (state.status === "loading") return <p role="status">오늘을 불러오는 중</p>;
	if (state.status === "error" || state.data === undefined) return <p role="alert">오늘 정보를 불러오지 못했습니다.</p>;
	const today = state.data;
	return (
		<section className="page-frame" aria-labelledby="today-title">
			<p className="section-kicker">JARVIS TODAY</p>
			<h1 id="today-title">오늘</h1>
			<div className="today-grid">
				{(["NOW", "BLOCKED", "DECISIONS", "NEXT 3", "WORKERS", "RISKS"] as const).map((section) => (
					<article key={section} aria-labelledby={`today-${section}`}>
						<h2 id={`today-${section}`}>{section}</h2>
						<p>
							{section === "NEXT 3"
								? today.recommendations.next_actions
										.slice(0, 3)
										.map((action) => action.title)
										.join(" · ") || "없음"
								: section === "DECISIONS"
									? String(today.decisions.length)
									: section === "WORKERS"
										? String(today.runs.length)
										: "확인 필요"}
						</p>
					</article>
				))}
			</div>
			<p className="muted">
				생성 시각: <time dateTime={today.generated_at}>{today.generated_at}</time>
			</p>
			{today.omissions.map((item) => (
				<p className="muted" key={item}>
					제외됨: {item}
				</p>
			))}
		</section>
	);
}
