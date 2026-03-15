// POST /api/auth — パスワード認証 + セッショントークン発行
// 環境変数: APP_PASSWORD, RATE_LIMIT (KV binding)
// TEST_MODE=true でパスワード試行制限をスキップ

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const isTestMode = env.TEST_MODE === 'true';

  // --- パスワード試行制限（TEST_MODE時はスキップ）---
  if (!isTestMode && env.RATE_LIMIT) {
    const authKey = `auth:${ip}`;
    const record = await env.RATE_LIMIT.get(authKey, { type: 'json' });

    if (record && record.blocked_until) {
      const now = Date.now();
      if (now < record.blocked_until) {
        const waitMin = Math.ceil((record.blocked_until - now) / 60000);
        return jsonRes({ error: `試行回数の上限に達しました。${waitMin}分後に再試行してください。` }, 429);
      }
    }
  }

  // --- リクエスト解析 ---
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: '不正なリクエストです' }, 400);
  }

  if (!body.password) {
    return jsonRes({ error: 'パスワードを入力してください' }, 400);
  }

  // --- パスワード照合 ---
  const correctPassword = env.APP_PASSWORD;
  if (!correctPassword) {
    return jsonRes({ error: 'サーバー設定エラー: パスワード未設定' }, 500);
  }

  if (body.password !== correctPassword) {
    // 失敗カウント
    if (!isTestMode && env.RATE_LIMIT) {
      const authKey = `auth:${ip}`;
      const record = await env.RATE_LIMIT.get(authKey, { type: 'json' }) || { fail_count: 0 };
      record.fail_count = (record.fail_count || 0) + 1;

      if (record.fail_count >= 5) {
        record.blocked_until = Date.now() + 30 * 60 * 1000; // 30分ブロック
        record.fail_count = 0;
      }

      await env.RATE_LIMIT.put(authKey, JSON.stringify(record), { expirationTtl: 1800 });
    }

    return jsonRes({ error: 'パスワードが正しくありません' }, 401);
  }

  // --- 認証成功: セッショントークン発行 ---
  const token = generateToken();
  const session = {
    created: Date.now(),
    expires: Date.now() + 24 * 60 * 60 * 1000, // 24時間
    ip: ip
  };

  if (env.RATE_LIMIT) {
    await env.RATE_LIMIT.put(`session:${token}`, JSON.stringify(session), { expirationTtl: 86400 });

    // 認証失敗カウントをリセット
    const authKey = `auth:${ip}`;
    await env.RATE_LIMIT.delete(authKey);
  }

  return jsonRes({ token, expires_in: 86400 });
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
