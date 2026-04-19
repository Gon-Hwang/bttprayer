/** 갤러리 포스트 댓글 (회원 작성) */

export async function ensureGalleryCommentsTable(DB) {
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS gallery_comments (
      id TEXT PRIMARY KEY NOT NULL,
      post_id TEXT NOT NULL,
      member_id TEXT,
      author_name TEXT NOT NULL,
      author_email TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gallery_comments_post_id ON gallery_comments(post_id)`
  ).run();
}
