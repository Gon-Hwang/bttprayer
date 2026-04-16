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

  // gallery_posts 테이블에 likes 컬럼 자동 추가 (없을 경우)
  if (table === 'gallery_posts') {
    try {
      const colInfo = await DB.prepare('PRAGMA table_info(gallery_posts)').all();
      const cols = (colInfo.results || []).map(c => c.name);
      if (!cols.includes('likes')) {
        await DB.prepare('ALTER TABLE gallery_posts ADD COLUMN likes INTEGER DEFAULT 0').run();
      }
    } catch (_) {}
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
      let orderBy = 'created_at DESC';
      if (sortParam) {
        const desc = sortParam.startsWith('-');
        const col = desc ? sortParam.slice(1) : sortParam;
        // Validate column name (alphanumeric + underscore only)
        if (/^[a-zA-Z0-9_]+$/.test(col)) {
          orderBy = `${col} ${desc ? 'DESC' : 'ASC'}`;
        }
      }

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
      return corsResponse(JSON.stringify(created || insertData), 201);

    } else {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }
  } catch (err) {
    console.error('[DB ERROR]', err);
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}
