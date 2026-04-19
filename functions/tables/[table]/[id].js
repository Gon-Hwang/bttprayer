// Cloudflare Pages Function: /tables/:table/:id
// Handles GET (single), PUT/PATCH (update), DELETE for D1 tables

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// gallery_like_counts 테이블 초기화
async function ensureGalleryLikeCounts(DB) {
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS gallery_like_counts (
      post_id TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0
    )`
  ).run();
}

async function galleryPostsSelectColumnList(DB) {
  const colInfo = await DB.prepare(`PRAGMA table_info(gallery_posts)`).all();
  const names = (colInfo.results || []).map((c) => c.name);
  return names.filter((n) => n !== 'likes' && n !== 'likeCount');
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const table = params.table;
  const id = params.id;
  const method = request.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  // Only allow known tables
  const ALLOWED_TABLES = ['prayers', 'testimonies', 'members', 'notices', 'gallery_posts', 'schedules', 'dns_records'];
  if (!ALLOWED_TABLES.includes(table)) {
    return corsResponse(JSON.stringify({ error: 'Table not found' }), 404);
  }

  const DB = env.DB;
  if (!DB) {
    return corsResponse(JSON.stringify({ error: 'Database not configured' }), 500);
  }

  try {
    if (method === 'GET') {
      if (table === 'gallery_posts') {
        await ensureGalleryLikeCounts(DB);
        const gpCols = await galleryPostsSelectColumnList(DB);
        const gpSelectList = gpCols.map((c) => `gp.${c}`).join(', ');
        const row = await DB.prepare(
          `SELECT ${gpSelectList},
            COALESCE(glc.count, 0) AS likes,
            COALESCE(glc.count, 0) AS likeCount
           FROM gallery_posts gp
           LEFT JOIN gallery_like_counts glc ON gp.id = glc.post_id
           WHERE gp.id = ?`
        ).bind(id).first();
        if (!row) return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
        return corsResponse(JSON.stringify(row));
      }

      const row = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      if (!row) {
        return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
      }
      return corsResponse(JSON.stringify(row));

    } else if (method === 'PUT' || method === 'PATCH') {
      const body = await request.json();
      const now = new Date().toISOString();

      // gallery_posts 좋아요 수 업데이트: gallery_like_counts 전용 테이블에 저장
      if (table === 'gallery_posts' && (body.likes !== undefined || body.likeCount !== undefined)) {
        const newCount = Math.max(0, Number(body.likes ?? body.likeCount ?? 0));
        await ensureGalleryLikeCounts(DB);

        // INSERT OR REPLACE — 항상 안전하게 저장
        await DB.prepare(
          `INSERT OR REPLACE INTO gallery_like_counts (post_id, count) VALUES (?, ?)`
        ).bind(id, newCount).run();

        // 업데이트된 포스트와 좋아요 수를 함께 반환
        const gpCols = await galleryPostsSelectColumnList(DB);
        const gpSelectList = gpCols.map((c) => `gp.${c}`).join(', ');
        const updated = await DB.prepare(
          `SELECT ${gpSelectList},
            COALESCE(glc.count, 0) AS likes,
            COALESCE(glc.count, 0) AS likeCount
           FROM gallery_posts gp
           LEFT JOIN gallery_like_counts glc ON gp.id = glc.post_id
           WHERE gp.id = ?`
        ).bind(id).first();
        return corsResponse(JSON.stringify(updated || { id, likes: newCount, likeCount: newCount }));
      }

      // 일반 필드 업데이트 (설명 수정 등)
      const colInfo = await DB.prepare(`PRAGMA table_info(${table})`).all();
      const columns = (colInfo.results || []).map(c => c.name);

      const updateData = { ...body };
      delete updateData.id;
      delete updateData.created_at;
      // gallery_posts 좋아요 필드는 위에서 처리했으므로 제외
      if (table === 'gallery_posts') {
        delete updateData.likes;
        delete updateData.likeCount;
      }
      if (columns.includes('updated_at')) updateData.updated_at = now;

      const validCols = Object.keys(updateData).filter(k => columns.includes(k));
      if (validCols.length === 0) {
        return corsResponse(JSON.stringify({ error: 'No valid fields to update' }), 400);
      }

      const setClauses = validCols.map(k => `${k} = ?`).join(', ');
      const values = [...validCols.map(k => updateData[k]), id];

      await DB.prepare(
        `UPDATE ${table} SET ${setClauses} WHERE id = ?`
      ).bind(...values).run();

      if (table === 'gallery_posts') {
        await ensureGalleryLikeCounts(DB);
        const gpCols = await galleryPostsSelectColumnList(DB);
        const gpSelectList = gpCols.map((c) => `gp.${c}`).join(', ');
        const updated = await DB.prepare(
          `SELECT ${gpSelectList},
            COALESCE(glc.count, 0) AS likes,
            COALESCE(glc.count, 0) AS likeCount
           FROM gallery_posts gp
           LEFT JOIN gallery_like_counts glc ON gp.id = glc.post_id
           WHERE gp.id = ?`
        ).bind(id).first();
        return corsResponse(JSON.stringify(updated || { id, ...body, updated_at: now }));
      }

      const updated = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      return corsResponse(JSON.stringify(updated || { id, ...body, updated_at: now }));

    } else if (method === 'DELETE') {
      const existing = await DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
      if (!existing) {
        return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
      }

      await DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();

      // gallery_like_counts에서도 삭제
      if (table === 'gallery_posts') {
        try {
          await DB.prepare(`DELETE FROM gallery_like_counts WHERE post_id = ?`).bind(id).run();
        } catch (_) {}
      }

      return corsResponse(JSON.stringify({ message: 'Record deleted successfully', id }));

    } else {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }
  } catch (err) {
    console.error('[DB ERROR]', err);
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}
