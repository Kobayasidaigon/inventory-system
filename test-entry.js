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
 *   - 操作者名（by）を書き換える / 剥がす / 後から足す
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
    MAX_LINK_LIFETIME_SECONDS,
    BY_MAX_LENGTH
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

    // --- 操作者名（by） ---
    //
    // by は「誰が触っているか」を渡すだけで、入れるかどうかには効かない。
    // ただし署名の対象なので、URL をいじって別人の名前にはできない。
    const withBy = validParams({ by: '山田' });
    const withByQuery = { ...withBy, sig: sign(withBy, LINK_SECRET) };

    addResult(
        '検証: 操作者名が付いたリンクは通り、その名前が読める',
        verifyEntryParams(withByQuery).by === '山田',
        '山田 として読めた'
    );

    addResult(
        '検証: 操作者名が無いリンクは今まで通り通る（by は空）',
        verifyEntryParams(goodQuery).by === '',
        'by は空文字'
    );

    rejects('検証: 操作者名を書き換えたら拒否', { ...withByQuery, by: '鈴木' }, 401);

    const stripped = { ...withByQuery };
    delete stripped.by;
    rejects('検証: 操作者名を剥がしたら拒否', stripped, 401);

    rejects('検証: 操作者名を後から足したら拒否', { ...goodQuery, by: '鈴木' }, 401);

    // 名前を入れるところなので、長いものと HTML として読める文字は受け取らない。
    // 履歴の表はテンプレート文字列で組み立てているため、ここで止める。
    const longBy = validParams({ by: 'あ'.repeat(BY_MAX_LENGTH + 1) });
    rejects(
        '検証: 操作者名が長すぎたら拒否',
        { ...longBy, sig: sign(longBy, LINK_SECRET) },
        400
    );

    for (const bad of ['<img src=x>', '&#60;script&#62;', '"onload"', "it's"]) {
        const badBy = validParams({ by: bad });
        rejects(
            `検証: 操作者名に ${bad} は受け取らない`,
            { ...badBy, sig: sign(badBy, LINK_SECRET) },
            400
        );
    }

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

    // --- 操作者名（by）---
    //
    // 拠点のアカウントは店舗で共用する。それだけだと画面も履歴も全部同じ名前に
    // なってしまうので、リンクで受け取った名前を使う。
    const named = await enterWith(visitor(), validParams({ loc: locationCode, by: '山田' }));
    addResult(
        '入場: 操作者名が付いていれば、その名前で入る',
        named.loggedIn === true && named.userName === '山田',
        `${named.userName} として入った`
    );

    const unnamed = await enterWith(visitor(), validParams({ loc: locationCode }));
    addResult(
        '入場: 操作者名が無ければ、これまで通りアカウント名で入る',
        unnamed.loggedIn === true && unnamed.userName === 'テスト担当',
        `${unnamed.userName} として入った`
    );

    // --- 操作者名が記録にも残るか ---
    //
    // 画面の名前だけ変えても、履歴が共用アカウント名のままでは誰が入力したか
    // 後から分からない。実際に出庫を登録して、履歴に出る名前まで見る。
    await setupClient.refreshCsrfToken();
    const product = await setupClient.request('POST', '/api/products', {
        name: '操作者名テスト用',
        category: '消耗品',
        current_stock: 100,
        // 発注点を 0 にして、このテストの出庫で自動発注が動かないようにする
        reorder_point: 0
    });

    if (product.status !== 200 || !product.body.productId) {
        throw new Error(`商品の登録に失敗しました: ${JSON.stringify(product.body)}`);
    }
    const productId = product.body.productId;

    /**
     * 履歴から、備考で 1 行を探す。
     *
     * 並び順は created_at なので、テストのように同じ秒に何件も入れると
     * どれが先頭に来るか決まらない。狙った行を備考で選ぶ。
     */
    async function historyRowByNote(client, note) {
        const history = await client.request(
            'GET',
            `/api/inventory/history?productId=${productId}&limit=1000`
        );
        return history.body.find(row => row.note === note);
    }

    /** リンクで入ってから出庫を 1 件登録し、履歴に出る名前を返す */
    async function recordAs(params, note) {
        const client = visitor();
        await client.request('GET', `/enter?${buildQuery(params)}`, undefined, { redirect: 'manual' });
        await client.refreshCsrfToken();

        const posted = await client.request('POST', '/api/inventory/out', {
            productId,
            quantity: 1,
            note
        });

        if (posted.status !== 200) {
            throw new Error(`出庫の登録に失敗しました: ${JSON.stringify(posted.body)}`);
        }

        return historyRowByNote(client, note);
    }

    const byRow = await recordAs(validParams({ loc: locationCode, by: '山田' }), '操作者名あり');
    addResult(
        '記録: 操作者名がそのまま履歴に残る',
        byRow && byRow.username === '山田',
        `履歴の担当: ${byRow && byRow.username}`
    );

    const plainRow = await recordAs(validParams({ loc: locationCode }), '操作者名なし');
    addResult(
        '記録: 操作者名が無ければ履歴はアカウント名のまま',
        plainRow && plainRow.username === 'テスト担当',
        `履歴の担当: ${plainRow && plainRow.username}`
    );

    // 普通にログインした人の記録も、これまで通りアカウント名で出る。
    // 入場リンクの仕組みを足したことで、既存の経路が変わっていないことの確認。
    await setupClient.request('POST', '/api/inventory/out', {
        productId,
        quantity: 1,
        note: '普通のログインから'
    });
    const loggedInRow = await historyRowByNote(setupClient, '普通のログインから');
    addResult(
        '記録: 普通にログインした人はアカウント名で残る',
        loggedInRow && loggedInRow.username === 'テスト担当',
        `履歴の担当: ${loggedInRow && loggedInRow.username}`
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
