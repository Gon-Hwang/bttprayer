// Cloudflare Pages Function: /tables/:table/:id
// Handles GET (single), PUT/PATCH (update), DELETE for D1 tables

import {
  persistGalleryLikeCount,
  normalizeGalleryPostRow,
  ensureGalleryLikeCountsTable,
} from '../../_utils/galleryLike.js';

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
      if (table === 'gallery_posts') {
        await ensureGalleryLikeCountsTable(DB);
        const row = await DB.prepare(`SELECT * FROM gallery_posts WHERE id = ?`).bind(id).first();
        if (!row) return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
        return corsResponse(JSON.stringify(normalizeGalleryPostRow(row)));
      }

      const row = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      if (!row) {
        return corsResponse(JSON.stringify({ error: 'Record not found' }), 404);
      }
      return corsResponse(JSON.stringify(row));

    } else if (method === 'PUT' || method === 'PATCH') {
      const body = await request.json();
      const now = new Date().toISOString();

      // gallery_posts 좋아요: 간증과 같이 행 컬럼 + 기존 side table 동시 반영
      if (table === 'gallery_posts' && (body.likes !== undefined || body.likeCount !== undefined)) {
        const newCount = Math.max(0, Number(body.likes ?? body.likeCount ?? 0));
        await persistGalleryLikeCount(DB, id, newCount);
        const updated = await DB.prepare(`SELECT * FROM gallery_posts WHERE id = ?`).bind(id).first();
        return corsResponse(JSON.stringify(normalizeGalleryPostRow(updated || { id, likes: newCount, likeCount: newCount })));
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
        await ensureGalleryLikeCountsTable(DB);
        const updated = await DB.prepare(`SELECT * FROM gallery_posts WHERE id = ?`).bind(id).first();
        return corsResponse(JSON.stringify(normalizeGalleryPostRow(updated || { id, ...body, updated_at: now })));
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
