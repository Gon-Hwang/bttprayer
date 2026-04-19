/** 갤러리 좋아요: 간증(testimonies)과 같이 gallery_posts 행에 수치를 두고 읽는다. (JOIN 전용 테이블만 쓰면 D1 환경에서 0으로만 보이는 사례가 있어 이중 저장) */

export async function getGalleryPostsColumnSet(DB) {
  const colInfo = await DB.prepare(`PRAGMA table_info(gallery_posts)`).all();
  return new Set((colInfo.results || []).map((c) => c.name));
}

export async function ensureGalleryLikeCountsTable(DB) {
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS gallery_like_counts (
      post_id TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0
    )`
  ).run();
  try {
    await DB.prepare(
      `INSERT OR IGNORE INTO gallery_like_counts (post_id, count)
       SELECT id, COALESCE(likes, 0) FROM gallery_posts WHERE COALESCE(likes, 0) > 0`
    ).run();
  } catch (_) {}
}

/** 과거에 side table 에만 있던 카운트를 메인 행으로 한 번에 맞춤 (요청마다 가벼운 UPDATE) */
export async function syncSideTableCountsIntoGalleryPosts(DB) {
  const cols = await getGalleryPostsColumnSet(DB);
  await ensureGalleryLikeCountsTable(DB);
  if (cols.has('likeCount')) {
    try {
      await DB.prepare(
        `UPDATE gallery_posts SET likeCount = (
          SELECT glc.count FROM gallery_like_counts glc WHERE glc.post_id = gallery_posts.id
        )
        WHERE id IN (SELECT post_id FROM gallery_like_counts)`
      ).run();
    } catch (_) {}
  }
  if (cols.has('likes')) {
    try {
      await DB.prepare(
        `UPDATE gallery_posts SET likes = (
          SELECT glc.count FROM gallery_like_counts glc WHERE glc.post_id = gallery_posts.id
        )
        WHERE id IN (SELECT post_id FROM gallery_like_counts)`
      ).run();
    } catch (_) {}
  }
}

/** 좋아요 변경 시: side table + gallery_posts 컬럼(존재하는 것만) 동시 갱신 */
export async function persistGalleryLikeCount(DB, id, newCount) {
  const cols = await getGalleryPostsColumnSet(DB);
  await ensureGalleryLikeCountsTable(DB);
  await DB.prepare(`INSERT OR REPLACE INTO gallery_like_counts (post_id, count) VALUES (?, ?)`)
    .bind(id, newCount)
    .run();
  if (cols.has('likeCount')) {
    await DB.prepare(`UPDATE gallery_posts SET likeCount = ? WHERE id = ?`).bind(newCount, id).run();
  }
  if (cols.has('likes')) {
    await DB.prepare(`UPDATE gallery_posts SET likes = ? WHERE id = ?`).bind(newCount, id).run();
  }
}

export function normalizeGalleryPostRow(row) {
  if (!row) return row;
  const n = Math.max(0, Number(row.likeCount ?? row.likes ?? 0));
  return { ...row, likes: n, likeCount: n };
}
