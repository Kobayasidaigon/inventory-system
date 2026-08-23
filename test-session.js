/**
 * セッション設定テストスクリプト
 *
 * 本番では Cookie に secure を付ける。ただし Fly.io は TLS を手前で終端して
 * アプリには HTTP で渡すため、trust proxy を設定していないと Cookie が
 * 一切発行されず、誰もログインできなくなる。ここが壊れると業務が止まるので、
 * 本番と同じ形（X-Forwarded-Proto: https 付きの HTTP）で確かめる。
 *
 * 使い方: node test-session.js
 */

const fs = require('fs');
const { createResults, createTempDbDir, startServer } = require('./test-helpers');

const PORT = 3991;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-session');
const SESSION_SECRET = 'test-secret-from-environment';
const PASSWORD = 'test-password-1234';

const { results, addResult, printSummary } = createResults();

// 本番では TLS が手前で終端されるので、その形を再現する
const PROXY_HEADERS = { 'X-Forwarded-Proto': 'https' };

/** Set-Cookie の生の文字列を保持したまま叩くクライアント */
function createRawClient() {
    const state = { cookie: '', csrfToken: '', lastSetCookie: [] };

    async function request(method, path, body) {
        const headers = { ...PROXY_HEADERS };
        if (state.cookie) headers['Cookie'] = state.cookie;
        if (method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken;

        let payload;
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify({ ...body, _csrf: state.csrfToken });
        }

        const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });

        state.lastSetCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        for (const raw of state.lastSetCookie) {
            state.cookie = raw.split(';')[0];
        }

        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (err) {
            json = { raw: text };
        }

        return { status: res.status, body: json };
    }

    async function refreshCsrfToken() {
        const res = await request('GET', '/api/csrf-token');
        state.csrfToken = res.body.csrfToken;
    }

    return { request, refreshCsrfToken, state };
}

async function run() {
    const client = createRawClient();
    const { request, refreshCsrfToken, state } = client;

    await refreshCsrfToken();

    // --- Cookie に secure と httpOnly が付いているか ---
    const cookieHeader = state.lastSetCookie.join('; ');
    addResult(
        'Cookie: 本番では Secure が付く',
        /Secure/i.test(cookieHeader),
        cookieHeader || '(Set-Cookie なし)'
    );
    addResult(
        'Cookie: HttpOnly が付く',
        /HttpOnly/i.test(cookieHeader),
        cookieHeader || '(Set-Cookie なし)'
    );

    // --- TLS を手前で終端する構成でログインできるか ---
    const init = await request('POST', '/api/auth/admin/init', {
        username: 'admin',
        password: PASSWORD
    });
    addResult(
        '本番構成: 管理者を作成できる',
        init.status === 200,
        `status ${init.status} / ${init.body.error || init.body.message || ''}`
    );

    await refreshCsrfToken();
    const login = await request('POST', '/api/auth/admin/login', {
        username: 'admin',
        password: PASSWORD
    });
    addResult(
        '本番構成: プロキシ越しでログインできる',
        login.status === 200,
        `status ${login.status} / ${login.body.error || ''}`
    );

    // --- ログイン状態が次のリクエストへ引き継がれるか ---
    const check = await request('GET', '/api/auth/check');
    addResult(
        '本番構成: ログイン状態が保持される',
        check.body.loggedIn === true && check.body.isAdmin === true,
        `loggedIn=${check.body.loggedIn} isAdmin=${check.body.isAdmin}`
    );

    // --- 署名鍵が環境変数から読まれているか ---
    // 別の鍵で署名された Cookie は受け付けられないはず。
    // 署名部分を書き換えた Cookie を送って、ログイン状態にならないことを見る。
    const forged = state.cookie.replace(/\.[^.]+$/, '.forged-signature');
    const forgedRes = await fetch(`${BASE_URL}/api/auth/check`, {
        headers: { ...PROXY_HEADERS, Cookie: forged }
    });
    const forgedBody = await forgedRes.json();
    addResult(
        '署名: 署名を書き換えた Cookie は通らない',
        forgedBody.loggedIn !== true,
        `loggedIn=${forgedBody.loggedIn}`
    );
}

(async () => {
    console.log('========================================');
    console.log('セッション設定テスト開始');
    console.log('========================================\n');

    const { server, waitUntilReady, context } = startServer({
        port: PORT,
        dbDir: DB_DIR,
        env: {
            NODE_ENV: 'production',
            SESSION_SECRET,
            // 本番判定で /data/uploads を使うため、書ける場所に向ける
            UPLOADS_DIR: DB_DIR
        }
    });

    try {
        await waitUntilReady(BASE_URL);
        await run();

        addResult(
            '起動: SESSION_SECRET 設定時は警告が出ない',
            !context.stderr.includes('SESSION_SECRET が設定されていません'),
            context.stderr.trim() ? `stderr: ${context.stderr.trim().slice(0, 120)}` : '警告なし'
        );
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.message);
    } finally {
        server.kill();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
})();
