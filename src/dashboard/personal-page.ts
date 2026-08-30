import type { PersonalCursorCodec } from "./personal-cursor.js";
import type { PersonalListResource, PersonalPage, ResourceState } from "./personal-contracts.js";

type Keyed<T> = { readonly item: T; readonly key: readonly [string, string] };
type PageInput<T> = {
  readonly resource: PersonalListResource;
  readonly values: readonly Keyed<T>[];
  readonly limit: number;
  readonly cursor: string | null;
  readonly now: Date;
  readonly codec: PersonalCursorCodec;
  readonly state: ResourceState;
};

export function personalPage<T>(input: PageInput<T>): PersonalPage<T> {
  const decoded = input.cursor === null ? undefined : input.codec.decode(input.cursor, input.resource, input.limit, input.now);
  const values = decoded === undefined ? input.values : input.values.filter((value) => afterAnchor(value.key, decoded.anchor));
  const items = values.slice(0, input.limit);
  const total = decoded?.total ?? input.values.length;
  const consumed = total - values.length + items.length;
  const hasMore = consumed < total && values.length > items.length;
  const last = items.at(-1);
  const nextCursor = hasMore && last !== undefined ? input.codec.encode({
    resource: input.resource,
    limit: input.limit,
    total,
    anchor: last.key,
    issued_at: decoded?.issued_at ?? input.now.toISOString(),
  }) : null;
  return {
    schema_version: 1,
    resource: input.resource,
    generated_at: input.now.toISOString(),
    state: input.state,
    items: items.map((value) => value.item),
    page: { limit: input.limit, returned: items.length, total, has_more: hasMore, next_cursor: nextCursor },
  };
}

function afterAnchor(value: readonly [string, string], anchor: readonly [string, string]): boolean {
  return value[0] < anchor[0] || (value[0] === anchor[0] && value[1] < anchor[1]);
}
