// Cloudflare Pages Function: /tables/:table
// Handles GET (list) and POST (create) for D1 tables

import {
  syncSideTableCountsIntoGalleryPosts,
  normalizeGalleryPostRow,
} from '../_utils/galleryLike.js';
import { ensureGalleryCommentsTable } from '../_utils/galleryComments.js';

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
  const ALLOWED_TABLES = ['prayers', 'testimonies', 'members', 'notices', 'gallery_posts', 'gallery_comments', 'schedules', 'dns_records'];
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
        await syncSideTableCountsIntoGalleryPosts(DB);

        const countResult = await DB.prepare(`SELECT COUNT(*) as total FROM gallery_posts`).first();
        const total = countResult ? countResult.total : 0;

        let orderExpr = orderByCol;
        if (orderByCol === 'likes' || orderByCol === 'likeCount') {
          orderExpr = 'COALESCE(likeCount, likes, 0)';
        }

        const rows = await DB.prepare(
          `SELECT * FROM gallery_posts ORDER BY ${orderExpr} ${orderByDir} LIMIT ? OFFSET ?`
        )
          .bind(limit, offset)
          .all();

        const data = (rows.results || []).map((r) => normalizeGalleryPostRow(r));

        return corsResponse(JSON.stringify({
          data,
          total,
          page,
          limit,
          table,
        }));
      }

      if (table === 'gallery_comments') {
        await ensureGalleryCommentsTable(DB);
        const postId = url.searchParams.get('post_id');
        if (!postId) {
          return corsResponse(JSON.stringify({ error: 'post_id query parameter required' }), 400);
        }
        const sortParamComments = url.searchParams.get('sort') || 'created_at';
        let orderByColC = 'created_at';
        let orderByDirC = 'ASC';
        if (sortParamComments) {
          const desc = sortParamComments.startsWith('-');
          const col = desc ? sortParamComments.slice(1) : sortParamComments;
          if (/^[a-zA-Z0-9_]+$/.test(col)) {
            orderByColC = col;
            orderByDirC = desc ? 'DESC' : 'ASC';
          }
        }
        const countResult = await DB.prepare(
          `SELECT COUNT(*) as total FROM gallery_comments WHERE post_id = ?`
        )
          .bind(postId)
          .first();
        const total = countResult ? countResult.total : 0;
        const rows = await DB.prepare(
          `SELECT * FROM gallery_comments WHERE post_id = ? ORDER BY ${orderByColC} ${orderByDirC} LIMIT ? OFFSET ?`
        )
          .bind(postId, limit, offset)
          .all();
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

      if (table === 'gallery_comments') {
        await ensureGalleryCommentsTable(DB);
        const postId = String(body.post_id || body.postId || '').trim();
        const content = String(body.content || '').trim();
        if (!postId || !content) {
          return corsResponse(JSON.stringify({ error: 'post_id and content required' }), 400);
        }
        if (content.length > 2000) {
          return corsResponse(JSON.stringify({ error: 'content too long (max 2000)' }), 400);
        }
        const gp = await DB.prepare(`SELECT id FROM gallery_posts WHERE id = ?`).bind(postId).first();
        if (!gp) {
          return corsResponse(JSON.stringify({ error: 'gallery post not found' }), 404);
        }
        const id = generateUUID();
        const now = new Date().toISOString();
        const authorName = String(body.author_name || body.authorName || '회원').slice(0, 120);
        const authorEmail = String(body.author_email || body.authorEmail || '').slice(0, 200);
        const memberId = body.member_id || body.memberId || null;
        await DB.prepare(
          `INSERT INTO gallery_comments (id, post_id, member_id, author_name, author_email, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(id, postId, memberId, authorName, authorEmail, content, now, now)
          .run();
        const created = await DB.prepare(`SELECT * FROM gallery_comments WHERE id = ?`).bind(id).first();
        return corsResponse(JSON.stringify(created || { id, post_id: postId }), 201);
      }

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
        return corsResponse(JSON.stringify(normalizeGalleryPostRow(created)), 201);
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
