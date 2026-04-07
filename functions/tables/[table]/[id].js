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
      const row = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      if (!row) {
        return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
      }
      return corsResponse(JSON.stringify(row));

    } else if (method === 'PUT' || method === 'PATCH') {
      const body = await request.json();
      const now = new Date().toISOString();

      // Get column info
      const colInfo = await DB.prepare(`PRAGMA table_info(${table})`).all();
      const columns = (colInfo.results || []).map(c => c.name);

      // Build update data (exclude id, created_at)
      const updateData = { ...body };
      delete updateData.id;
      delete updateData.created_at;
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

      const updated = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      return corsResponse(JSON.stringify(updated || { id, ...body, updated_at: now }));

    } else if (method === 'DELETE') {
      const existing = await DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
      if (!existing) {
        return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
      }

      await DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
      return corsResponse(JSON.stringify({ message: 'Record deleted successfully', id }));

    } else {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }
  } catch (err) {
    console.error('[DB ERROR]', err);
    return corsResponse(JSON.stringify({ error: err.message }), 500);
  }
}
