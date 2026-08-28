export function modrinthSearchPageInfo(offset: number, consumedHits: number, totalHits: number) {
  const nextOffset = offset + consumedHits;
  return { nextOffset, hasMore: nextOffset < totalHits };
}
