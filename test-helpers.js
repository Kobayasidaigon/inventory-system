/**
 * テスト用の共通処理。
 *
 * サーバーを別プロセスで起動し、Cookie と CSRF トークンを持った状態で
 * 実際の HTTP API を叩くための土台。テストごとに書き直さないためにまとめている。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** テスト結果の集計 */
function createResults() {
    const results = { passed: 0, failed: 0 };

    function addResult(name, passed, message) {
        if (passed) {
            results.passed++;
            console.log(`✅ ${name}: ${message}`);
        } else {
            results.failed++;
            console.log(`❌ ${name}: ${message}`);
        }
    }

    function printSummary() {
        console.log('\n========================================');
        console.log(`成功: ${results.passed} 件 / 失敗: ${results.failed} 件`);
        console.log('========================================');
    }

    return { results, addResult, printSummary };
}

/** 使い捨てのデータベースディレクトリを作る */
function createTempDbDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Cookie と CSRF トークンを保持する HTTP クライアント。
 */
function createClient(baseUrl) {
    const state = { cookie: '', csrfToken: '' };

    async function request(method, urlPath, body) {
        const headers = {};
        if (state.cookie) headers['Cookie'] = state.cookie;
        if (method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken;

        let payload;
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            // 商品 API は multer を通るためヘッダーではなくボディの _csrf を見る
            payload = JSON.stringify({ ...body, _csrf: state.csrfToken });
        }

        const res = await fetch(`${baseUrl}${urlPath}`, { method, headers, body: payload });

        const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        for (const raw of setCookie) {
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

    function resetSession() {
        state.cookie = '';
    }

    return { request, refreshCsrfToken, resetSession, state };
}

/**
 * サーバーを別プロセスで起動する。
 *
 * 起動に失敗したときに黙ってタイムアウトしないよう、終了コードと
 * 標準エラー出力を捕まえておく。
 */
function startServer({ port, dbDir, env = {} }) {
    const context = { exit: null, stderr: '' };

    const server = spawn('node', [path.join(__dirname, 'server', 'app.js')], {
        env: {
            ...process.env,
            PORT: String(port),
            DB_DIR: dbDir,
            NODE_ENV: 'test',
            // テスト中に定期処理を走らせない
            BACKUP_INTERVAL_HOURS: '24',
            SHIFT_MONITOR: 'off',
            // テストは短時間に大量のリクエストを投げるのでレート制限を緩める
            API_RATE_LIMIT_MAX: '100000',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stdout.on('data', () => {});
    server.stderr.on('data', chunk => {
        context.stderr += String(chunk);
    });
    server.on('exit', (code, signal) => {
        context.exit = { code, signal };
    });

    async function waitUntilReady(baseUrl) {
        for (let i = 0; i < 60; i++) {
            if (context.exit && context.exit.signal === null) {
                throw new Error(
                    `サーバーが起動直後に終了しました (code ${context.exit.code})\n${context.stderr.trim()}`
                );
            }

            try {
                const res = await fetch(`${baseUrl}/api/csrf-token`);
                if (res.ok) return;
            } catch (err) {
                // まだ起動していない
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }

        throw new Error(`サーバーが起動しませんでした\n${context.stderr.trim()}`);
    }

    return { server, waitUntilReady, context };
}

/**
 * 管理者 → 拠点 → 一般ユーザーを作り、一般ユーザーでログインした状態にする。
 *
 * @returns {Promise<{locationId: number, locationCode: string, credentials: object}>}
 */
async function setupLocationUser(client, { password = 'test-password-1234' } = {}) {
    const { request, refreshCsrfToken, resetSession } = client;

    await refreshCsrfToken();
    await request('POST', '/api/auth/admin/init', { username: 'admin', password });
    await refreshCsrfToken();
    await request('POST', '/api/auth/admin/login', { username: 'admin', password });
    await refreshCsrfToken();

    const location = await request('POST', '/api/auth/admin/locations', { locationName: 'テスト店' });

    if (location.status !== 200) {
        throw new Error(`拠点の作成に失敗しました: ${JSON.stringify(location.body)}`);
    }

    await request('POST', '/api/auth/admin/users', {
        locationId: location.body.locationId,
        userId: 'tester',
        userName: 'テスト担当',
        password
    });

    await request('POST', '/api/auth/logout');
    resetSession();
    await refreshCsrfToken();

    const login = await request('POST', '/api/auth/login', {
        locationCode: location.body.locationCode,
        userId: 'tester',
        password
    });
    await refreshCsrfToken();

    if (login.status !== 200) {
        throw new Error(`ログインに失敗しました: ${JSON.stringify(login.body)}`);
    }

    return {
        locationId: location.body.locationId,
        locationCode: location.body.locationCode,
        credentials: { userId: 'tester', password }
    };
}

module.exports = {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser
};
