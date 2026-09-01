/**
 * 入場リンク（信頼している別サイトからの、ログインなしの入場）のテスト。
 *
 * ここはログイン画面を迂回する経路なので、通ってほしい 1 つの場合より、
 * 通ってはいけない場合の方を厚く確かめる。
 *
 *   - 署名が合わない
 *   - 期限が切れている / 期限が先すぎる
 *   - 同じリンクの 2 回目
 *   - 合言葉が未設定
 *   - 管理者として入ろうとする
 *
 * 使い方: node test-entry.js
 */

const path = require('path');
const sqlite3 = require('sqlite3');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser
} = require('./test-helpers');
const {
    sign,
    canonicalString,
    buildEntryUrl,
    verifyEntryParams,
    MAX_LINK_LIFETIME_SECONDS
} = require('./server/services/entry-link');

const PORT = 3993;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-entry');
const LINK_SECRET = 'test-link-secret-0123456789';

const { results, addResult, printSummary } = createResults();

/** 署名付きリンクのクエリ部分を組み立てる */
function buildQuery(params, secret = LINK_SECRET) {
    return canonicalString(params) + `&sig=${sign(params, secret)}`;
}

/** 有効なパラメータ一式を作る */
function validParams(overrides = {}) {
    return {
        loc: 'LOC1',
        user: 'tester',
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: `nonce-${Math.random().toString(16).slice(2)}-${Date.now()}`,
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// 1. 署名の検証（サーバーを起動せず、関数を直接呼ぶ）
// ---------------------------------------------------------------------------

function testVerify() {
    process.env.LINK_SECRET = LINK_SECRET;

    const good = validParams();
    const goodQuery = { ...good, sig: sign(good, LINK_SECRET) };

    addResult(
        '検証: 正しいリンクは通る',
        verifyEntryParams(goodQuery).user === 'tester',
        'tester として通った'
    );

    const rejects = (name, query, expectedStatus) => {
        try {
            verifyEntryParams(query);
            addResult(name, false, '通ってしまった');
        } catch (err) {
            addResult(
                name,
                err.status === expectedStatus,
                `status ${err.status} / ${err.message}`
            );
        }
    };

    // --- 中身を書き換える ---
    rejects('検証: 拠点を書き換えたら拒否', { ...goodQuery, loc: 'LOC2' }, 401);
    rejects('検証: 利用者を書き換えたら拒否', { ...goodQuery, user: 'somebody' }, 401);
    rejects('検証: 期限を伸ばしたら拒否', { ...goodQuery, exp: good.exp + 60 }, 401);
    rejects('検証: nonce を書き換えたら拒否', { ...goodQuery, nonce: good.nonce + 'x' }, 401);
    rejects('検証: 署名を書き換えたら拒否', { ...goodQuery, sig: 'a'.repeat(64) }, 401);

    // 長さの違う署名で timingSafeEqual が例外を投げないこと
    rejects('検証: 署名の長さが違っても落ちずに拒否', { ...goodQuery, sig: 'abc' }, 401);

    // --- 別の合言葉で作られたもの ---
    const forged = validParams();
    rejects(
        '検証: 別の合言葉で署名されたものは拒否',
        { ...forged, sig: sign(forged, 'ちがう合言葉') },
        401
    );

    // --- 期限 ---
    const expired = validParams({ exp: Math.floor(Date.now() / 1000) - 1 });
    rejects(
        '検証: 期限が切れていたら拒否',
        { ...expired, sig: sign(expired, LINK_SECRET) },
        401
    );

    // 署名が正しくても、期限が先すぎるものは受け付けない。
    // これを見ないと exp=2099年 のリンク 1 本で永久パスになる。
    const tooLong = validParams({
        exp: Math.floor(Date.now() / 1000) + MAX_LINK_LIFETIME_SECONDS + 60
    });
    rejects(
        '検証: 期限が先すぎたら、署名が正しくても拒否',
        { ...tooLong, sig: sign(tooLong, LINK_SECRET) },
        401
    );

    // --- 形式 ---
    rejects('検証: 項目が足りなければ拒否', { loc: 'LOC1', sig: 'x' }, 400);
    const badExp = validParams({ exp: '１２３' });
    rejects(
        '検証: 期限が数字でなければ拒否',
        { ...badExp, sig: sign(badExp, LINK_SECRET) },
        400
    );
    const shortNonce = validParams({ nonce: 'abc' });
    rejects(
        '検証: nonce が短すぎたら拒否',
        { ...shortNonce, sig: sign(shortNonce, LINK_SECRET) },
        400
    );
    const longNonce = validParams({ nonce: 'a'.repeat(200) });
    rejects(
        '検証: nonce が長すぎたら拒否',
        { ...longNonce, sig: sign(longNonce, LINK_SECRET) },
        400
    );

    // --- 合言葉が未設定 ---
    delete process.env.LINK_SECRET;
    rejects('検証: 合言葉が未設定なら受け付けない', goodQuery, 503);
    process.env.LINK_SECRET = LINK_SECRET;

    // --- 区切り文字の混入で別の入力が同じ署名にならないこと ---
    const a = canonicalString({ loc: 'A&user=X', user: 'B', exp: 1, nonce: 'n' });
    const b = canonicalString({ loc: 'A', user: 'X&user=B', exp: 1, nonce: 'n' });
    addResult(
        '検証: 区切り文字を含む値でも署名の対象が混ざらない',
        a !== b,
        '別の文字列になる'
    );

    // --- リンクの組み立て ---
    const url = buildEntryUrl('https://example.com/', { loc: 'LOC1', user: 'tester' }, LINK_SECRET);
    const parsed = Object.fromEntries(new URL(url).searchParams);
    addResult(
        '検証: 組み立てたリンクは自分で検証を通る',
        url.startsWith('https://example.com/enter?') && verifyEntryParams(parsed).loc === 'LOC1',
        url.slice(0, 60) + '...'
    );
}

// ---------------------------------------------------------------------------
// 2. 実際に入れるか（サーバーを起動して確かめる）
// ---------------------------------------------------------------------------

/** メイン DB を直接いじる。API では作れない状態を作るため。 */
function withMainDb(fn) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(path.join(DB_DIR, 'main.db'), err => {
            if (err) return reject(err);
            fn(db, error => {
                db.close();
                error ? reject(error) : resolve();
            });
        });
    });
}

async function testEntry(setupClient) {
    const { locationCode } = await setupLocationUser(setupClient);

    /** クッキーを持たない、まっさらな利用者 */
    const visitor = () => createClient(BASE_URL);

    /** リンクを踏んでから、ログインできているかを見る */
    async function enterWith(client, params, secret = LINK_SECRET) {
        // リダイレクトは追わない。追うと 302 に付いたセッションのクッキーを
        // 取りこぼす（fetch は最後の応答のヘッダーしか見せない）。
        // ブラウザは途中のクッキーも保存するので、そちらに合わせている。
        await client.request(
            'GET',
            `/enter?${buildQuery(params, secret)}`,
            undefined,
            { redirect: 'manual' }
        );
        const check = await client.request('GET', '/api/auth/check');
        return check.body;
    }

    // --- 通る場合 ---
    const ok = await enterWith(visitor(), validParams({ loc: locationCode }));
    addResult(
        '入場: 正しいリンクならログインなしで入れる',
        ok.loggedIn === true && ok.locationCode === locationCode,
        `${ok.userName} / 拠点 ${ok.locationCode}`
    );
    addResult(
        '入場: 管理者としてではなく、その拠点の利用者として入る',
        ok.isAdmin === false,
        'isAdmin: false'
    );

    // --- 使い捨て ---
    const reused = validParams({ loc: locationCode });
    const first = await enterWith(visitor(), reused);
    const second = await enterWith(visitor(), reused);
    addResult(
        '入場: 同じリンクの 2 回目は入れない',
        first.loggedIn === true && second.loggedIn === false,
        `1回目 ${first.loggedIn} / 2回目 ${second.loggedIn}`
    );

    // --- 弾く場合 ---
    const cases = [
        ['署名が違う', validParams({ loc: locationCode }), 'ちがう合言葉'],
        ['期限切れ', validParams({ loc: locationCode, exp: Math.floor(Date.now() / 1000) - 1 }), LINK_SECRET],
        ['期限が先すぎる', validParams({
            loc: locationCode,
            exp: Math.floor(Date.now() / 1000) + MAX_LINK_LIFETIME_SECONDS + 60
        }), LINK_SECRET],
        ['知らない拠点', validParams({ loc: 'NOPE' }), LINK_SECRET],
        ['知らない利用者', validParams({ loc: locationCode, user: 'nobody' }), LINK_SECRET]
    ];

    for (const [label, params, secret] of cases) {
        const result = await enterWith(visitor(), params, secret);
        addResult(`入場: ${label} なら入れない`, result.loggedIn === false, 'ログインしていない');
    }

    // --- 管理者はこの経路では入れない ---
    await withMainDb((db, done) => {
        db.run('UPDATE users SET is_admin = 1 WHERE user_id = ?', ['tester'], done);
    });
    const asAdmin = await enterWith(visitor(), validParams({ loc: locationCode }));
    addResult(
        '入場: 管理者はリンクからは入れない',
        asAdmin.loggedIn === false,
        'ログインしていない'
    );
    await withMainDb((db, done) => {
        db.run('UPDATE users SET is_admin = 0 WHERE user_id = ?', ['tester'], done);
    });

    // --- 失敗しても、普通のログインは壊れていない ---
    const stillWorks = await enterWith(visitor(), validParams({ loc: locationCode }));
    addResult(
        '入場: 拒否のあとも正しいリンクは通る',
        stillWorks.loggedIn === true,
        '入れた'
    );
}

// ---------------------------------------------------------------------------

async function main() {
    console.log('========================================');
    console.log('入場リンクのテスト開始');
    console.log('========================================\n');

    testVerify();

    const { server, waitUntilReady } = startServer({
        port: PORT,
        dbDir: DB_DIR,
        env: { LINK_SECRET }
    });

    try {
        await waitUntilReady(BASE_URL);
        await testEntry(createClient(BASE_URL));
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.message);
    } finally {
        server.kill();
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
}

main();
