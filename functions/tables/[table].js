// Cloudflare Pages Function: /tables/:table
// Handles GET (list) and POST (create) for D1 tables

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function generateUUID() {
  return crypto.randomUUID();
}

// gallery_like_counts 테이블 초기화 및 기존 데이터 마이그레이션
async function ensureGalleryLikeCounts(DB) {
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS gallery_like_counts (
      post_id TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0
    )`
  ).run();
  // gallery_posts.likes 컬럼에 저장된 기존 카운트 한 번만 이전
  try {
    await DB.prepare(
      `INSERT OR IGNORE INTO gallery_like_counts (post_id, count)
       SELECT id, COALESCE(likes, 0) FROM gallery_posts WHERE COALESCE(likes, 0) > 0`
    ).run();
  } catch (_) {}
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const table = params.table;
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
      // Parse query params
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 1000);
      const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);
      const sortParam = url.searchParams.get('sort') || '-created_at';
      const offset = (page - 1) * limit;

      // Parse sort
      let orderByCol = 'created_at';
      let orderByDir = 'DESC';
      if (sortParam) {
        const desc = sortParam.startsWith('-');
        const col = desc ? sortParam.slice(1) : sortParam;
        if (/^[a-zA-Z0-9_]+$/.test(col)) {
          orderByCol = col;
          orderByDir = desc ? 'DESC' : 'ASC';
        }
      }

      if (table === 'gallery_posts') {
        // gallery_like_counts 테이블에서 좋아요 수를 JOIN으로 가져옴
        await ensureGalleryLikeCounts(DB);

        const countResult = await DB.prepare(`SELECT COUNT(*) as total FROM gallery_posts`).first();
        const total = countResult ? countResult.total : 0;

        const rows = await DB.prepare(
          `SELECT gp.*, COALESCE(glc.count, 0) as likes, COALESCE(glc.count, 0) as likeCount
           FROM gallery_posts gp
           LEFT JOIN gallery_like_counts glc ON gp.id = glc.post_id
           ORDER BY gp.${orderByCol} ${orderByDir} LIMIT ? OFFSET ?`
        ).bind(limit, offset).all();

        return corsResponse(JSON.stringify({
          data: rows.results || [],
          total,
          page,
          limit,
          table,
        }));
      }

      // 일반 테이블
      const orderBy = `${orderByCol} ${orderByDir}`;
      const countResult = await DB.prepare(`SELECT COUNT(*) as total FROM ${table}`).first();
      const total = countResult ? countResult.total : 0;

      const rows = await DB.prepare(
        `SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();

      return corsResponse(JSON.stringify({
        data: rows.results || [],
        total,
        page,
        limit,
        table,
      }));

    } else if (method === 'POST') {
      const body = await request.json();

      // Generate ID and timestamps
      const id = generateUUID();
      const now = new Date().toISOString();

      // Get column info from the table
      const colInfo = await DB.prepare(`PRAGMA table_info(${table})`).all();
      const columns = (colInfo.results || []).map(c => c.name);

      // Build insert data
      const insertData = { ...body, id };
      if (columns.includes('created_at')) insertData.created_at = now;
      if (columns.includes('updated_at')) insertData.updated_at = now;

      // Only include columns that exist in the table
      const validCols = Object.keys(insertData).filter(k => columns.includes(k));
      const placeholders = validCols.map(() => '?').join(', ');
      const values = validCols.map(k => insertData[k]);

      await DB.prepare(
        `INSERT INTO ${table} (${validCols.join(', ')}) VALUES (${placeholders})`
      ).bind(...values).run();

      // Return the created record
      const created = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();

      // gallery_posts 신규 등록 시 likes/likeCount = 0 보장
      if (table === 'gallery_posts' && created) {
        return corsResponse(JSON.stringify({ ...created, likes: 0, likeCount: 0 }), 201);
      }

      return corsResponse(JSON.stringify(created || insertData), 201);

    } else {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }
  } catch (err) {
    console.error('[DB ERROR]', err);
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}
