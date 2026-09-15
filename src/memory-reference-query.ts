/**
 * The provider's lexical query contract, and what a natural-language question has to lose to meet
 * it.
 *
 * A Second Brain provider parses a query into whitespace-separated terms and keeps only records
 * whose text contains *every* term, compared with whitespace removed and case folded. Punctuation
 * is part of a term: the question "What should happen next?" asks for the literal `next?`, so a
 * record saying "What should happen next: ..." does not match, and a real vault answers a perfectly
 * reasonable question with zero records.
 *
 * Normalising means dropping trailing punctuation from each term. It only ever widens what can
 * match -- `next` matches both `next:` and `next?` -- and it is applied to the terms sent to the
 * provider, never to the query the reference is digested over, so the contract digest a consumer
 * verifies still covers the question the caller actually asked.
 *
 * A query containing a double quote is left exactly as written: quoted phrases are the provider's
 * own query syntax, and a caller using it is speaking that language deliberately.
 */
const TRAILING = new Set([...".,;:!?…·•'’”)]}»›。，！？"]);

/** The same terms, in the same order, without the punctuation a provider would match literally. */
export function normalizeMemoryLexicalQuery(query: string): string {
  if (typeof query !== "string" || query.includes("\"")) return query;
  const terms: string[] = [];
  for (const term of query.split(/\s+/u)) {
    let end = term.length;
    while (end > 0 && TRAILING.has(term.charAt(end - 1))) end -= 1;
    const trimmed = term.slice(0, end);
    if (trimmed.length > 0) terms.push(trimmed);
  }
  // A query that is nothing but punctuation stays as written, so the adapter reports it rather than
  // this turning into a silently empty search.
  return terms.length === 0 ? query : terms.join(" ");
}
