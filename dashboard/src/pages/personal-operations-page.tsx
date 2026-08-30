import { useEffect, useState } from "react";

type PersonalOperationsPageProps = Readonly<{
	title: string;
	endpoint: string;
	itemLabel: string;
}>;
type PageState = Readonly<{
	status: "loading" | "ready" | "error";
	items: readonly Readonly<Record<string, unknown>>[];
}>;

export function PersonalOperationsPage({ title, endpoint, itemLabel }: PersonalOperationsPageProps) {
	const [state, setState] = useState<PageState>({
		status: "loading",
		items: [],
	});
	useEffect(() => {
		let mounted = true;
		void fetch(endpoint, { headers: { Accept: "application/json" } })
			.then((response) =>
				response.ok
					? (response.json() as Promise<{
							items?: readonly Readonly<Record<string, unknown>>[];
						}>)
					: Promise.reject(new Error("request failed")),
			)
			.then((body) => {
				if (mounted) setState({ status: "ready", items: body.items ?? [] });
			})
			.catch(() => {
				if (mounted) setState({ status: "error", items: [] });
			});
		return () => {
			mounted = false;
		};
	}, [endpoint]);
	return (
		<section className="page-frame" aria-labelledby="personal-page-title">
			<p className="section-kicker">JARVIS CONTROL CENTER</p>
			<h1 id="personal-page-title">{title}</h1>
			{state.status === "loading" && <p role="status">불러오는 중</p>}
			{state.status === "error" && <p role="alert">권위 런타임에 연결할 수 없습니다.</p>}
			{state.status === "ready" && (
				<ul aria-label={itemLabel}>
					{state.items.map((item, index) => (
						<li key={String(item.id ?? item[itemLabel] ?? index)}>{String(item.summary ?? item.title ?? item.state ?? "기록")}</li>
					))}
				</ul>
			)}
		</section>
	);
}
