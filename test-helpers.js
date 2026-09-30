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
    // ログインは connect.sid と remember_token の 2 つを返す。
    // 1 個だけ持つと片方を取りこぼすので、名前ごとに持つ。
    const jar = new Map();
    const state = {
        csrfToken: '',
        get cookie() {
            return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
        }
    };

    /**
     * @param {object} [options]
     * @param {'follow'|'manual'} [options.redirect='follow'] - リダイレクトを追うか。
     *   fetch が追うと、途中の応答に付いた Set-Cookie を取りこぼす（最後の応答の
     *   ヘッダーしか読めないため）。ブラウザは途中のクッキーも保存するので、
     *   リダイレクトしながらログインさせる経路を試すときは 'manual' にする。
     */
    async function request(method, urlPath, body, options = {}) {
        const headers = {};
        if (state.cookie) headers['Cookie'] = state.cookie;
        if (method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken;

        let payload;
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            // 商品 API は multer を通るためヘッダーではなくボディの _csrf を見る
            payload = JSON.stringify({ ...body, _csrf: state.csrfToken });
        }

        const res = await fetch(`${baseUrl}${urlPath}`, {
            method,
            headers,
            body: payload,
            redirect: options.redirect || 'follow'
        });

        const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        for (const raw of setCookie) {
            const [name, ...rest] = raw.split(';')[0].split('=');
            jar.set(name, rest.join('='));
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
        jar.clear();
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
        password,
        // 画面のチェックボックスは既定で入っているので、それに合わせる
        rememberMe: true
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

/**
 * 利用者画面（index.html + app.js）を jsdom で開く。
 *
 * CI にはブラウザが無いので、実物の HTML と JS を jsdom で動かして画面の配線を確かめる。
 * HTML 内の <script src> は jsdom が読みに行かない（外部リソースを読まない設定のため）。
 * そこで csrf.js と app.js を順に流し込む。グラフ用の Chart.js は読まない。
 *
 * jsdom は作った直後はまだ読み込み中で、DOMContentLoaded はあとで自分から出す。
 * その前にスクリプトを入れておけば、ブラウザと同じく初期化は 1 回だけ走る。
 * ここで合図を自分でも出すと初期化が 2 回走り、一覧の読み込みが二重に飛んで
 * 後から届いた結果で画面が上書きされる。
 *
 * fetch は jsdom に無いので、ログイン済みのテスト用クライアントと同じクッキーで
 * 実サーバーへ送る。alert / confirm / prompt は記録して、confirm は常に OK を返す。
 *
 * @param {object} client - createClient() で作り、ログイン済みのもの
 * @param {string} baseUrl - テスト用サーバーの URL
 * @returns {{window: object, errors: string[], dialogs: string[], state: {promptAnswer: string|null}}}
 */
function openUserScreen(client, baseUrl) {
    // jsdom は画面のテストでしか使わないので、ここで読み込む
    const { JSDOM, VirtualConsole } = require('jsdom');
    const errors = [];
    const dialogs = [];
    const state = { promptAnswer: null };

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', err => errors.push(err.message));
    virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')));

    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const dom = new JSDOM(html, { url: `${baseUrl}/`, runScripts: 'dangerously', virtualConsole });
    const { window } = dom;

    window.fetch = (url, options = {}) => fetch(new URL(url, baseUrl), {
        ...options,
        headers: { ...(options.headers || {}), Cookie: client.state.cookie }
    });
    window.alert = message => dialogs.push(`alert: ${message}`);
    window.confirm = message => {
        dialogs.push(`confirm: ${message}`);
        return true;
    };
    window.prompt = message => {
        dialogs.push(`prompt: ${message}`);
        return state.promptAnswer;
    };

    if (window.document.readyState !== 'loading') {
        throw new Error('jsdom の読み込みが先に終わってしまい、画面の初期化を走らせられません');
    }

    for (const file of ['csrf.js', 'app.js']) {
        const script = window.document.createElement('script');
        script.textContent = fs.readFileSync(path.join(__dirname, 'public', 'js', file), 'utf8');
        window.document.body.appendChild(script);
    }

    return { window, errors, dialogs, state };
}

/** 条件が満たされるまで待つ（画面の処理は非同期で進むため） */
async function waitFor(check, label, timeout = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        if (check()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`画面が期待した状態になりませんでした: ${label}`);
}

module.exports = {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser,
    openUserScreen,
    waitFor
};
