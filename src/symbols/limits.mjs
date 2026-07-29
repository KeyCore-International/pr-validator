// How much of a symbol an extractor is willing to store.
//
// Every field here comes out of a regex capture on a line written by whoever
// opened the pull request, so its length is theirs to choose, not ours. A name
// then travels to the tokeniser in `src/similarity/name.mjs` and is compared
// against every indexed symbol, so an unbounded name is unbounded work.
//
// `signature` has always been sliced at the point it is stored. `name` is
// sliced at the same ceiling, for the same reason: past 200 characters the
// string is not an identifier anybody wrote, and nothing downstream reads it
// as one.

/** Ceiling on a stored symbol name, in characters. */
export const MAX_NAME_CHARS = 200;
