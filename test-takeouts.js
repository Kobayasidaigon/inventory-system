/**
 * 出庫記録（誰が何個出したか）と、補充が早すぎる商品の見張りのテスト。
 *
 * 1. 計算: 早すぎる補充の判定（データベースに触らない部分）
 * 2. 名簿と登録: 出す人は店の名簿から選ぶ。名簿にない名前（2 人をまとめた名前など）は弾く。
 *    名簿ができたときに 1 回だけ、それまでの記録の名前で名簿を作る
 * 3. 出庫記録 API（管理者だけ）: 人ごとの集計・絞り込み・早すぎる補充と、その間に出した人。
 *    店の利用者からは見られない
 * 4. CSV（管理者だけ）: 条件どおりの行を全件、出した人・補充が早い期間の列、ファイル名
 * 5. 名前の候補: 今日の勤務予定・最近使った名前、入場リンクの名前
 * 6. 画面（jsdom）: 店の画面は -1 のダイアログから登録でき、出庫記録タブは無い。
 *    管理画面の出庫記録タブが描ける
 *
 * 使い方: node test-takeouts.js
 * 一時ディレクトリに専用のデータベースを作り、サーバーを別プロセスで起動する。
 */

// 店の端末と同じ日本時間で動かす（CSV の時刻を日本時間で出しているかを見るため）
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser,
    openUserScreen,
    openAdminScreen,
    waitFor
} = require('./test-helpers');
const { detectQuickRestocks, parseTakerName } = require('./server/services/takeouts');
const { sign, canonicalString } = require('./server/services/entry-link');

const PORT = 3986;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-takeouts-test');
const IMPORT_SECRET = 'test-import-secret-takeouts';
const LINK_SECRET = 'test-link-secret-takeouts-0123';

const { results, addResult, printSummary } = createResults();

// 店の利用者（出庫を登録する側）と、管理者（出庫記録を見る側）
const client = createClient(BASE_URL);
const { request } = client;
const admin = createClient(BASE_URL);
let locationId = null;

// 取引日は 2025 年にそろえる。商品登録の初期在庫は「今日」の調整履歴で入るので、
// 2025 年で絞ればテストを流す日に左右されない
const YEAR_2025 = { startDate: '2025-01-01', endDate: '2025-12-31' };
// 出す人の名簿。出庫はこの人たちしかできない。
// 手で足す人（MANUAL）と、ジョブカンのシフトから自動で載る人（SHIFT）と、
// 店のユーザー（setupLocationUser が作る「テスト担当」）から自動で載る人（USERS）を合わせたもの
const MANUAL = ['田中 花子', '佐藤', '鈴木', '山田'];
const SHIFT = ['早番 一郎', '遅番 二郎', '中番 三郎'];
const USERS = ['テスト担当'];
const ROSTER = [...MANUAL, ...SHIFT, ...USERS];
const products = {};

/** 日本時間の今日（YYYY-MM-DD） */
function tokyoToday() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

async function createProduct(key, name, category, stock) {
    const res = await request('POST', '/api/products', {
        name,
        category,
        reorder_point: 0,
        current_stock: stock
    });

    if (res.status !== 200 || !res.body.productId) {
        throw new Error(`商品の登録に失敗しました: ${name} / ${JSON.stringify(res.body)}`);
    }

    products[key] = res.body.productId;
}

async function out(key, date, quantity, takenBy) {
    const body = { productId: products[key], quantity, date };
    if (takenBy !== undefined) body.takenBy = takenBy;

    const res = await request('POST', '/api/inventory/out', body);
    if (res.status !== 200) {
        throw new Error(`出庫に失敗しました: ${key} ${date} / ${JSON.stringify(res.body)}`);
    }
}

async function restock(key, date, quantity, note = '発注依頼による入荷') {
    const res = await request('POST', '/api/inventory/in', { productId: products[key], quantity, date, note });
    if (res.status !== 200) {
        throw new Error(`入庫に失敗しました: ${key} ${date} / ${JSON.stringify(res.body)}`);
    }
}

/**
 * 商品の履歴から 1 行を探す。登録時刻は秒単位なので、同じ秒の行（商品登録の初期在庫など）と
 * 並びが入れ替わることがある。先頭の行ではなく、種別と取引日で探す
 */
async function findHistory(key, type, date) {
    const res = await request('GET', `/api/inventory/history?productId=${products[key]}&limit=1000`);
    return res.body.find(row => row.type === type && row.transaction_date === date);
}

/** 管理者として、テスト店の出庫記録を取る */
async function takeouts(query) {
    return admin.request('GET', `/api/auth/admin/locations/${locationId}/takeouts?${new URLSearchParams(query)}`);
}

/** 管理者用の出庫記録 CSV の URL */
function takeoutsCsvUrl(query) {
    return `/api/auth/admin/locations/${locationId}/takeouts/export?${new URLSearchParams(query)}`;
}

function rosterUrl(suffix = '') {
    return `/api/auth/admin/locations/${locationId}/roster${suffix}`;
}

/** 管理者として、出す人の名簿に入れる（出庫は名簿にある人しかできない） */
async function seedRoster(names) {
    for (const name of names) {
        const res = await admin.request('POST', rosterUrl(), { name });
        if (res.status !== 200) {
            throw new Error(`名簿に入れられませんでした: ${name} / ${JSON.stringify(res.body)}`);
        }
    }
}

/**
 * ジョブカンから勤務予定を取り込む（拠点名「テスト店」で結びつく）。早番・遅番は今日、
 * 中番は同じ月の 3 日ずれた日。遅番の名前は全角の空白にしておく（名簿では半角にそろう）
 */
async function importShifts() {
    const [year, month, day] = tokyoToday().split('-');
    const otherDay = Number(day) >= 4 ? Number(day) - 3 : Number(day) + 3;
    const res = await request('POST', '/api/staff/import-schedules', {
        secret: IMPORT_SECRET,
        targetMonth: `${year}-${month}`,
        schedules: [
            { staffName: '早番 一郎', day: Number(day), startTime: '09:00', endTime: '14:00', groupId: '3', groupName: 'テスト店' },
            { staffName: '遅番　二郎', day: Number(day), startTime: '17:00', endTime: '22:00', groupId: '3', groupName: 'テスト店' },
            { staffName: '中番 三郎', day: otherDay, startTime: '12:00', endTime: '18:00', groupId: '3', groupName: 'テスト店' }
        ]
    });

    if (res.status !== 200) {
        throw new Error(`勤務予定を取り込めませんでした: ${JSON.stringify(res.body)}`);
    }
}

async function loginAdmin() {
    await admin.refreshCsrfToken();
    const res = await admin.request('POST', '/api/auth/admin/login', {
        username: 'admin', password: 'test-password-1234'
    });
    await admin.refreshCsrfToken();

    if (res.status !== 200) {
        throw new Error(`管理者のログインに失敗しました: ${JSON.stringify(res.body)}`);
    }
}

/** CSV を取ってくる。ヘッダーも見たいので fetch を直接使う */
async function fetchCsv(pathAndQuery, cookie = client.state.cookie) {
    const res = await fetch(`${BASE_URL}${pathAndQuery}`, { headers: { Cookie: cookie } });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8').replace(/^﻿/, '');
    const disposition = res.headers.get('content-disposition') || '';
    const encodedName = (disposition.match(/filename\*=UTF-8''([^;]+)/) || [])[1];
    const lines = text.split('\n').filter(line => line !== '');

    return {
        status: res.status,
        header: lines[0],
        lines: lines.slice(1),
        fileName: encodedName ? decodeURIComponent(encodedName) : null
    };
}

// ---------------------------------------------------------------------------
// 1. 計算（データベースに触らない）
// ---------------------------------------------------------------------------

function testDetect() {
    // 2 週間おきに 20 個ずつ補充していた商品
    const regular = [
        ['2025-01-01', 20], ['2025-01-15', 20], ['2025-01-29', 20], ['2025-02-12', 20]
    ].map(([date, quantity]) => ({ product_id: 1, date, quantity }));

    const quick = detectQuickRestocks([...regular, { product_id: 1, date: '2025-02-17', quantity: 20 }]);
    addResult(
        '判定: いつも 14 日もつ量が 5 日でなくなったら拾う',
        quick.length === 1 && quick[0].date === '2025-02-17' && quick[0].previousDate === '2025-02-12' &&
            quick[0].days === 5 && quick[0].expectedDays === 14,
        JSON.stringify(quick)
    );

    const slightlyEarly = detectQuickRestocks([...regular, { product_id: 1, date: '2025-02-22', quantity: 20 }]);
    addResult(
        '判定: 少し早い程度（10 日）では拾わない',
        slightlyEarly.length === 0,
        `${slightlyEarly.length} 件`
    );

    // 少しだけ補充したあとは、早く次が来て当然。日数ではなく量あたりで比べる
    const small = detectQuickRestocks([
        ...regular,
        { product_id: 1, date: '2025-02-26', quantity: 5 },
        { product_id: 1, date: '2025-03-01', quantity: 20 }
    ]);
    addResult(
        '判定: 少しだけ補充したあとに早く次が来ても拾わない',
        small.length === 0,
        `${small.length} 件`
    );

    const fewHistory = detectQuickRestocks([
        { product_id: 2, date: '2025-01-01', quantity: 20 },
        { product_id: 2, date: '2025-01-15', quantity: 20 },
        { product_id: 2, date: '2025-01-17', quantity: 20 }
    ]);
    addResult(
        '判定: いつものペースが分かるほど記録が無いうちは拾わない',
        fewHistory.length === 0,
        `${fewHistory.length} 件`
    );

    const otherProduct = detectQuickRestocks([
        ...regular,
        { product_id: 2, date: '2025-02-13', quantity: 20 }
    ]);
    addResult(
        '判定: 別の商品の補充とは混ぜない',
        otherProduct.length === 0,
        `${otherProduct.length} 件`
    );

    addResult(
        '名前: 前後の空白を落とし、途中の空白（全角も）を 1 つにそろえる',
        parseTakerName('  田中　 花子 ') === '田中 花子' && parseTakerName('   ') === null,
        `「${parseTakerName('  田中　 花子 ')}」`
    );
}

// ---------------------------------------------------------------------------
// 2. 名簿と登録
// ---------------------------------------------------------------------------

/** sqlite3 の接続を、アプリと同じ Promise の形（get/all/run）にする */
function promised(raw) {
    const call = method => (sql, params = []) => new Promise((resolve, reject) => {
        raw[method](sql, params, function (err, result) {
            if (err) return reject(err);
            resolve(method === 'run' ? { lastID: this.lastID, changes: this.changes } : result);
        });
    });
    return { get: call('get'), all: call('all'), run: call('run') };
}

/**
 * 今の本番と同じ「名簿のテーブルが無く、記録はある」データベースで、名簿が記録から
 * 作られるか。サーバーは起動せず、データベースの準備の処理を直接呼ぶ。
 */
async function testRosterSeed() {
    // database-admin は読み込むと DB_DIR に main.db を開くので、使い捨ての場所にする
    const seedDir = createTempDbDir('inventory-roster-seed');
    process.env.DB_DIR = seedDir;
    const { prepareLocationDatabase } = require('./server/db/database-admin');
    const sqlite3 = require('sqlite3');
    const raw = new sqlite3.Database(path.join(seedDir, 'location_seed.db'));
    const db = promised(raw);

    try {
        // 前の版のデータベースを作る（テーブルを作ってから、名簿のテーブルだけ消す）
        await prepareLocationDatabase(db);
        await db.run('DROP TABLE taker_roster');

        const history = (operator, takenBy = null, at = "datetime('now')") => db.run(
            `INSERT INTO inventory_history (product_id, type, quantity, user_id, operator_name, taken_by, created_at)
             VALUES (1, 'out', 1, 1, ?, ?, ${at})`,
            [operator, takenBy]
        );
        await history('田中 花子');
        await history('田中・佐藤');
        await history('山本•川口');
        await history('佐藤　健');
        await history(null, '鈴木');
        await history('昔 太郎', null, "datetime('now', '-200 days')");
        await db.run("INSERT INTO order_requests (product_id, requested_quantity, user_id, operator_name) VALUES (1, 1, 1, '発注 さん')");
        await db.run("INSERT INTO inventory_counts (count_date, user_id, operator_name) VALUES ('2026-10-01', 1, '棚卸 さん')");

        // 新しい版で開く
        await prepareLocationDatabase(db);
        const seeded = await db.all('SELECT name, source FROM taker_roster ORDER BY name');
        const names = seeded.map(row => row.name);
        addResult(
            '名簿の作成: 名簿ができたとき、それまでの記録（清掃管理表の担当者・出した人・発注・棚卸）から名前を入れる',
            JSON.stringify(names) === JSON.stringify(['佐藤 健', '棚卸 さん', '田中 花子', '発注 さん', '鈴木'].sort()) &&
                seeded.every(row => row.source === 'history'),
            JSON.stringify(seeded)
        );
        addResult(
            '名簿の作成: 2 人をまとめた名前（・ •）と、180 日より前の名前は入れない',
            !names.includes('田中・佐藤') && !names.includes('山本•川口') && !names.includes('昔 太郎'),
            names.join(' , ')
        );

        // 2 回目からは作らない（管理者が外した人を、再起動のたびに戻さない）
        await db.run("DELETE FROM taker_roster WHERE name = '発注 さん'");
        await prepareLocationDatabase(db);
        const again = await db.all('SELECT name FROM taker_roster');
        addResult(
            '名簿の作成: 1 回だけ。外した人が、次に起動したときに戻ってこない',
            again.length === 4 && !again.some(row => row.name === '発注 さん'),
            again.map(row => row.name).join(' , ')
        );
    } finally {
        raw.close();
        fs.rmSync(seedDir, { recursive: true, force: true });
    }
}

async function testRoster() {
    const list = await admin.request('GET', rosterUrl());
    const sourceOf = name => (list.body.names.find(n => n.name === name) || {}).source;
    addResult(
        '名簿: 手で足した人と、ジョブカンのシフトの人が名前順に並ぶ',
        list.status === 200 && list.body.locationName === 'テスト店' &&
            JSON.stringify(list.body.names.map(n => n.name)) === JSON.stringify([...ROSTER].sort()) &&
            MANUAL.every(name => sourceOf(name) === 'manual') && SHIFT.every(name => sourceOf(name) === 'shift'),
        JSON.stringify(list.body.names.map(n => `${n.name}(${n.source})`))
    );
    addResult(
        '名簿: ジョブカンの全角の空白の名前は、半角にそろえて載る（落とさない）',
        sourceOf('遅番 二郎') === 'shift',
        `遅番 二郎: ${sourceOf('遅番 二郎')}`
    );

    const fromShift = await admin.request('POST', rosterUrl(), { name: '早番 一郎' });
    addResult(
        '名簿: シフトから載っている人を、手で重ねて足すことはできない',
        fromShift.status === 409,
        `status ${fromShift.status} / ${fromShift.body.error || ''}`
    );

    const duplicate = await admin.request('POST', rosterUrl(), { name: ' 佐藤 ' });
    const bad = await admin.request('POST', rosterUrl(), { name: '<b>佐藤</b>' });
    const empty = await admin.request('POST', rosterUrl(), { name: '   ' });
    addResult(
        '名簿: 同じ名前・使えない文字・空の名前は入れない',
        duplicate.status === 409 && bad.status === 400 && empty.status === 400,
        `重複 ${duplicate.status} / 記号 ${bad.status} / 空 ${empty.status}`
    );

    const added = await admin.request('POST', rosterUrl(), { name: '一時 退職' });
    const removed = await admin.request('DELETE', rosterUrl(`/${added.body.id}`));
    const again = await admin.request('DELETE', rosterUrl(`/${added.body.id}`));
    const afterRemove = await admin.request('GET', rosterUrl());
    addResult(
        '名簿: 外せる（外した人はもう名簿にいない）',
        added.status === 200 && removed.status === 200 && again.status === 404 &&
            !afterRemove.body.names.some(n => n.name === '一時 退職'),
        `追加 ${added.status} / 削除 ${removed.status} / もう一度 ${again.status}`
    );

    const staffRead = await request('GET', rosterUrl());
    const staffWrite = await request('POST', rosterUrl(), { name: '勝手 登録' });
    addResult(
        '名簿: 店の利用者は名簿を見たり変えたりできない（管理者だけ）',
        staffRead.status === 403 && staffWrite.status === 403,
        `見る ${staffRead.status} / 足す ${staffWrite.status}`
    );
}

async function testRegister() {
    await out('paper', '2025-01-05', 2, '  田中　花子 ');
    const row = await findHistory('paper', 'out', '2025-01-05');
    addResult(
        '登録: 出庫に出した人が残る（空白はそろえる）',
        row && row.type === 'out' && row.taken_by === '田中 花子',
        `taken_by: ${row && row.taken_by}`
    );

    const before = (await request('GET', '/api/products')).body.find(p => p.id === products.paper).current_stock;

    const badCases = [
        ['名簿にない名前', '高橋'],
        ['2 人をまとめた名前', '田中・佐藤'],
        ['HTML になる文字', '<b>田中</b>'],
        ['& を含む', '田中&佐藤'],
        ['長すぎる名前', 'あ'.repeat(41)]
    ];
    for (const [label, takenBy] of badCases) {
        const res = await request('POST', '/api/inventory/out', {
            productId: products.paper, quantity: 1, date: '2025-01-05', takenBy
        });
        addResult(`登録: ${label}は拒否する`, res.status === 400, `status ${res.status} / ${res.body.error || ''}`);
    }

    const after = (await request('GET', '/api/products')).body.find(p => p.id === products.paper).current_stock;
    addResult('登録: 拒否したときは在庫が動かない', before === after, `${before} → ${after}`);

    const notOnRoster = await request('POST', '/api/inventory/out', {
        productId: products.paper, quantity: 1, date: '2025-01-05', takenBy: '高橋'
    });
    addResult(
        '登録: 名簿にない名前は、名簿から選ぶよう伝える',
        notOnRoster.body.error && notOnRoster.body.error.includes('名簿にありません'),
        notOnRoster.body.error
    );

    // 開きっぱなしの古い画面は名前を送らない。それでも出庫はできる（未記入として残る）
    await out('paper', '2025-01-06', 1);
    const unnamed = await findHistory('paper', 'out', '2025-01-06');
    addResult(
        '登録: 名前を送らない古い画面からでも出庫でき、出した人は空のまま',
        unnamed && unnamed.taken_by === null,
        `taken_by: ${unnamed && unnamed.taken_by}`
    );

    // 入庫に名前を付けても残さない（出した人は出庫のためのもの）
    await request('POST', '/api/inventory/in', {
        productId: products.joy, quantity: 1, date: '2025-01-06', note: 'テスト', takenBy: '田中 花子'
    });
    const inRow = await findHistory('joy', 'in', '2025-01-06');
    addResult(
        '登録: 入庫には出した人を残さない',
        inRow && inRow.taken_by === null,
        `taken_by: ${inRow && inRow.taken_by}`
    );
}

// ---------------------------------------------------------------------------
// 3. 出庫記録 API
// ---------------------------------------------------------------------------

async function prepareRestocks() {
    // トイレットペーパー: 2 週間おきに 20 個。最後だけ 5 日で次の補充
    for (const date of ['2025-01-01', '2025-01-15', '2025-01-29', '2025-02-12', '2025-02-17']) {
        await restock('paper', date, 20);
    }
    // +5 ボタン（誤操作の修正）は補充として数えない。数えると 2/12 → 2/14 が短い区間になる
    await restock('paper', '2025-02-14', 5, 'クイック操作');

    // 早すぎた区間（2/12〜2/17）に出した人
    await out('paper', '2025-02-13', 7, '田中 花子');
    await out('paper', '2025-02-15', 5, '田中 花子');
    await out('paper', '2025-02-16', 3, '佐藤');

    // ふつうの区間の出庫
    await out('paper', '2025-01-20', 4, '佐藤');

    // ゴム手袋: 少しだけ補充したあとに早く次が来ただけ。拾わない
    for (const [date, quantity] of [['2025-03-01', 20], ['2025-03-15', 20], ['2025-03-29', 20], ['2025-04-12', 5], ['2025-04-15', 20]]) {
        await restock('glove', date, quantity);
    }
    await out('glove', '2025-04-13', 2, '鈴木');

    // 洗剤: 明細の上限（100 件）より多く出す
    for (let i = 0; i < 101; i++) {
        await out('joy', '2025-06-01', 1, '鈴木');
    }
}

async function testTakeoutsApi() {
    const all = await takeouts(YEAR_2025);
    const people = Object.fromEntries(all.body.people.map(p => [p.name, p]));

    addResult(
        '出庫記録: 出庫だけを数える（入庫・調整は入れない）',
        all.status === 200 && all.body.total === 108 &&
            all.body.rows.every(r => r.type === 'out'),
        `${all.body.total} 件（期待値 108）`
    );
    addResult(
        '出庫記録: 人ごとに回数と合計個数をまとめる',
        people['田中 花子'] && people['田中 花子'].count === 3 && people['田中 花子'].quantity === 14 &&
            people['佐藤'].quantity === 7 && people['鈴木'].quantity === 103 && people.null.quantity === 1,
        all.body.people.map(p => `${p.name}: ${p.count}回 ${p.quantity}個`).join(' / ')
    );
    addResult(
        '出庫記録: 合計個数の多い順に並ぶ',
        all.body.people.map(p => p.name).join(',') === '鈴木,田中 花子,佐藤,',
        all.body.people.map(p => p.name).join(',')
    );
    addResult(
        '出庫記録: 内訳は商品ごとの個数',
        JSON.stringify(people['鈴木'].products) === JSON.stringify([
            { name: 'P&amp;G ジョイ 1&#x2F;2', quantity: 101 },
            { name: 'ニトリルグローブ(Ｍサイズ)', quantity: 2 }
        ]),
        JSON.stringify(people['鈴木'].products)
    );
    addResult(
        '出庫記録: 明細は 100 件まで（件数は全件ぶん返す）',
        all.body.rows.length === 100 && all.body.totalQuantity === 125,
        `明細 ${all.body.rows.length} 件 / 合計 ${all.body.totalQuantity} 個`
    );

    const tanaka = await takeouts({ ...YEAR_2025, takenBy: '田中 花子' });
    addResult(
        '出庫記録: 出した人で絞れる',
        tanaka.body.total === 3 && tanaka.body.rows.every(r => r.taken_by === '田中 花子'),
        `${tanaka.body.total} 件`
    );

    const unrecorded = await takeouts({ ...YEAR_2025, unrecorded: '1' });
    addResult(
        '出庫記録: 出した人が未記入のものだけを出せる',
        unrecorded.body.total === 1 && unrecorded.body.rows[0].taken_by === null,
        `${unrecorded.body.total} 件`
    );

    const badName = await takeouts({ takenBy: '<script>' });
    addResult('出庫記録: 名前の条件がおかしければ拒否する', badName.status === 400, `status ${badName.status}`);

    addResult(
        '出庫記録: 店舗名と、絞り込みに使う出した人の名前（条件に関係なく全員）が付く',
        all.body.locationName === 'テスト店' &&
            JSON.stringify(tanaka.body.names) === JSON.stringify(['佐藤', '田中 花子', '鈴木']),
        `${all.body.locationName} / ${JSON.stringify(tanaka.body.names)}`
    );

    // --- 早すぎる補充 ---
    const quick = all.body.quickRestocks;
    const paper = quick[0];
    addResult(
        '早すぎる補充: 5 日で再補充した商品だけを拾う（少量補充のあとや +5 ボタンは拾わない）',
        quick.length === 1 && paper.productId === products.paper && paper.date === '2025-02-17' &&
            paper.previousDate === '2025-02-12' && paper.days === 5 && paper.expectedDays === 14,
        JSON.stringify(quick.map(q => `${q.productName} ${q.previousDate}→${q.date} ${q.days}日/約${q.expectedDays}日`))
    );
    addResult(
        '早すぎる補充: その間に誰が何個出したかが付く',
        paper && JSON.stringify(paper.takers) === JSON.stringify([
            { name: '田中 花子', quantity: 12, count: 2 },
            { name: '佐藤', quantity: 3, count: 1 }
        ]) && paper.recordedOut === 15,
        JSON.stringify(paper && paper.takers)
    );

    const otherCategory = await takeouts({ ...YEAR_2025, category: '洗剤' });
    const outsidePeriod = await takeouts({ startDate: '2025-03-01', endDate: '2025-12-31' });
    const byPerson = await takeouts({ ...YEAR_2025, takenBy: '鈴木' });
    addResult(
        '早すぎる補充: カテゴリ・期間（補充した日）で絞る。出した人では絞らない',
        otherCategory.body.quickRestocks.length === 0 && outsidePeriod.body.quickRestocks.length === 0 &&
            byPerson.body.quickRestocks.length === 1,
        `洗剤 ${otherCategory.body.quickRestocks.length} / 3月以降 ${outsidePeriod.body.quickRestocks.length} / 鈴木 ${byPerson.body.quickRestocks.length}`
    );
}

/**
 * 人ごとの集計は管理者だけが見る。店の共用アカウントで入る全員に見えると、
 * 確かめる前に人を疑う空気になるため
 */
async function testAccess() {
    const staffReport = await request('GET', `/api/auth/admin/locations/${locationId}/takeouts`);
    const staffCsv = await fetchCsv(takeoutsCsvUrl(YEAR_2025));
    addResult(
        '権限: 店の利用者は出庫記録（人ごとの集計）も CSV も取れない',
        staffReport.status === 403 && staffCsv.status === 403,
        `一覧 ${staffReport.status} / CSV ${staffCsv.status}`
    );

    const oldReport = await request('GET', '/api/inventory/takeouts');
    const oldCsv = await request('GET', '/api/inventory/export?type=takeouts');
    addResult(
        '権限: 店の画面用の出庫記録 API・CSV は無い',
        oldReport.status === 404 && oldCsv.status === 400,
        `一覧 ${oldReport.status} / CSV ${oldCsv.status}`
    );

    const missing = await admin.request('GET', '/api/auth/admin/locations/9999/takeouts');
    addResult('権限: 無い店舗を指定したら 404', missing.status === 404, `status ${missing.status}`);
}

// ---------------------------------------------------------------------------
// 4. CSV
// ---------------------------------------------------------------------------

async function testCsv() {
    const all = await fetchCsv(takeoutsCsvUrl(YEAR_2025), admin.state.cookie);
    addResult(
        'CSV: 見出し',
        all.header === 'ID,日時,商品名,カテゴリ,数量,出した人,入力者,備考,補充が早い期間',
        all.header
    );
    addResult(
        'CSV: 条件に合う出庫を全件（画面の 100 件で切らない）',
        all.status === 200 && all.lines.length === 108,
        `${all.lines.length} 行（期待値 108）`
    );

    const cells = line => line.split(',');
    const quickRows = all.lines.filter(line => line.endsWith('（5日で再補充・いつもは約14日）'));
    addResult(
        'CSV: 補充が早すぎた区間の出庫に、その区間が書かれる',
        quickRows.length === 3 &&
            quickRows.every(line => line.includes('2025/02/12〜2025/02/17') && line.includes(',トイレットペーパー,')),
        quickRows.map(line => cells(line).slice(4, 6).join(' ')).join(' / ')
    );

    const unnamed = all.lines.find(line => cells(line)[5] === '（未記入）');
    addResult(
        'CSV: 出した人が無い出庫は「（未記入）」、入力者はアカウント名',
        unnamed && cells(unnamed)[6] === 'テスト担当',
        unnamed
    );

    const joy = all.lines.find(line => line.includes('ジョイ'));
    addResult(
        'CSV: 商品名の記号が「&amp;」「&#x2F;」のまま出ない',
        joy && joy.includes(',P&G ジョイ 1/2,洗剤,1,鈴木,') && !all.lines.some(l => /&amp;|&#x2F;/.test(l)),
        joy
    );

    addResult(
        'CSV: ファイル名で店舗と、何を絞ったかが分かる',
        all.fileName === '出庫記録_テスト店_全商品_20250101-20251231.csv',
        all.fileName
    );

    const tanaka = await fetchCsv(takeoutsCsvUrl({
        ...YEAR_2025, takenBy: '田中 花子', productId: String(products.paper)
    }), admin.state.cookie);
    addResult(
        'CSV: 出した人・商品で絞ると、その行だけ。ファイル名にも出る',
        tanaka.lines.length === 3 && tanaka.lines.every(line => cells(line)[5] === '田中 花子') &&
            tanaka.fileName === '出庫記録_テスト店_田中 花子_トイレットペーパー_20250101-20251231.csv',
        `${tanaka.lines.length} 行 / ${tanaka.fileName}`
    );

    const history = await fetchCsv(`/api/inventory/export?type=history&productId=${products.paper}&startDate=2025-02-13&endDate=2025-02-13`);
    addResult(
        'CSV: 入出庫履歴の CSV にも出した人の列がある',
        history.header.endsWith(',担当者,出した人') && history.lines.length === 1 &&
            history.lines[0].endsWith(',テスト担当,田中 花子'),
        `${history.header} / ${history.lines[0]}`
    );
}

// ---------------------------------------------------------------------------
// 5. 名前の候補
// ---------------------------------------------------------------------------

async function testCandidates(locationCode) {
    const res = await request('GET', '/api/inventory/takers');
    const names = res.body.names;
    addResult(
        '候補: ダイアログには名簿の全員が並ぶ（シフトの人も、手で足した人も）',
        [...names].sort().join(',') === [...ROSTER].sort().join(','),
        JSON.stringify(names)
    );
    addResult(
        '候補: 今日の勤務の人（始業の早い順）→ 最近出庫で使った人 → 残りの順',
        names[0] === '早番 一郎' && names[1] === '遅番 二郎' &&
            ['鈴木', '田中 花子', '佐藤'].every(name => names.indexOf(name) > 1 && names.indexOf(name) < names.indexOf('山田')),
        names.join(' , ')
    );
    addResult(
        '候補: 普通のログインでは、最初から選んでおく名前は無い',
        res.body.operatorName === null,
        `operatorName: ${res.body.operatorName}`
    );

    // 名簿に足す候補（管理画面）: 記録にあって名簿にない人。清掃管理表から入って
    // 補充（入庫）だけした人を作る（出庫の件数を数えるテストに混ざらないよう、入庫にする）
    const visitor = createClient(BASE_URL);
    const params = {
        loc: locationCode,
        user: 'tester',
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: `nonce-takeouts-temp-${Date.now()}`,
        by: '臨時 花子'
    };
    await visitor.request('GET', `/enter?${canonicalString(params)}&sig=${sign(params, LINK_SECRET)}`, undefined, { redirect: 'manual' });
    await visitor.refreshCsrfToken();
    await visitor.request('POST', '/api/inventory/in', { productId: products.joy, quantity: 1, note: 'テスト補充' });

    const roster = await admin.request('GET', rosterUrl());
    const suggested = roster.body.suggestions.map(s => s.name);
    addResult(
        '名簿の候補: 記録にあって名簿にない人が出る（名簿の人・シフトの人は出ない）',
        suggested.includes('臨時 花子') && !suggested.some(name => ROSTER.includes(name)),
        JSON.stringify(roster.body.suggestions)
    );
}

async function testEntryLinkName(locationCode) {
    const visitor = createClient(BASE_URL);
    const params = {
        loc: locationCode,
        user: 'tester',
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: `nonce-takeouts-${Date.now()}`,
        by: '山田'
    };

    await visitor.request('GET', `/enter?${canonicalString(params)}&sig=${sign(params, LINK_SECRET)}`, undefined, { redirect: 'manual' });
    await visitor.refreshCsrfToken();

    const candidates = await visitor.request('GET', '/api/inventory/takers');
    addResult(
        '入場リンク: 名前が分かっていればダイアログに最初から入れる',
        candidates.body.operatorName === '山田',
        `operatorName: ${candidates.body.operatorName}`
    );

    await visitor.request('POST', '/api/inventory/out', { productId: products.joy, quantity: 1, date: '2025-07-01' });
    await visitor.request('POST', '/api/inventory/out', {
        productId: products.joy, quantity: 1, date: '2025-07-02', takenBy: '佐藤'
    });
    // 清掃管理表で 2 人組の担当者（「田中・佐藤」）として入ってきた場合
    const pair = createClient(BASE_URL);
    const pairParams = {
        loc: locationCode,
        user: 'tester',
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: `nonce-takeouts-pair-${Date.now()}`,
        by: '田中・佐藤'
    };
    await pair.request('GET', `/enter?${canonicalString(pairParams)}&sig=${sign(pairParams, LINK_SECRET)}`, undefined, { redirect: 'manual' });
    await pair.refreshCsrfToken();

    const pairCandidates = await pair.request('GET', '/api/inventory/takers');
    const pairTyped = await pair.request('POST', '/api/inventory/out', {
        productId: products.joy, quantity: 1, date: '2025-07-03', takenBy: '田中・佐藤'
    });
    await pair.request('POST', '/api/inventory/out', { productId: products.joy, quantity: 1, date: '2025-07-03' });
    const pairRow = await findHistory('joy', 'out', '2025-07-03');
    addResult(
        '2 人組: 「田中・佐藤」で入っても最初から選ばれず、その名前では出庫できない（送らなければ未記入）',
        pairCandidates.body.operatorName === null && pairTyped.status === 400 &&
            pairRow && pairRow.taken_by === null && pairRow.operator_name === '田中・佐藤',
        `operatorName ${pairCandidates.body.operatorName} / 名前つき ${pairTyped.status} / 名前なし taken_by=${pairRow && pairRow.taken_by}`
    );

    // 比べるために、1 人の名前（名簿にはまだいない）でも入っておく
    const single = createClient(BASE_URL);
    const singleParams = { ...pairParams, nonce: `nonce-takeouts-single-${Date.now()}`, by: '臨時 次郎' };
    await single.request('GET', `/enter?${canonicalString(singleParams)}&sig=${sign(singleParams, LINK_SECRET)}`, undefined, { redirect: 'manual' });
    await single.refreshCsrfToken();
    await single.request('POST', '/api/inventory/out', { productId: products.joy, quantity: 1, date: '2025-07-04' });

    const suggestions = (await admin.request('GET', rosterUrl())).body.suggestions.map(s => s.name);
    addResult(
        '2 人組: 2 人をまとめた名前は名簿の候補に出ない（1 人の名前なら出る）',
        suggestions.includes('臨時 次郎') && !suggestions.includes('田中・佐藤'),
        JSON.stringify(suggestions)
    );

    const rows = (await takeouts({ productId: products.joy, startDate: '2025-07-01', endDate: '2025-07-02' })).body.rows;
    const byDate = Object.fromEntries(rows.map(r => [r.transaction_date, r]));
    addResult(
        '入場リンク: 名前を送らなければリンクの名前、送ればその名前が出した人になる',
        byDate['2025-07-01'] && byDate['2025-07-01'].taken_by === '山田' &&
            byDate['2025-07-02'] && byDate['2025-07-02'].taken_by === '佐藤' &&
            byDate['2025-07-02'].username === '山田',
        rows.map(r => `${r.transaction_date}: 出した人 ${r.taken_by} / 入力 ${r.username}`).join(' , ')
    );
}

// ---------------------------------------------------------------------------
// 6. 画面（jsdom）
// ---------------------------------------------------------------------------

async function testScreen() {
    const { window, errors } = openUserScreen(client, BASE_URL);
    const doc = window.document;

    const paperCard = () => [...doc.querySelectorAll('.stock-card')]
        .find(card => card.querySelector('.stock-card-name').textContent === 'トイレットペーパー');
    const paperStock = async () =>
        (await request('GET', '/api/products')).body.find(p => p.id === products.paper).current_stock;

    try {
        await waitFor(() => paperCard(), 'ダッシュボードが開く');

        // -1 を押すと、すぐには出庫せずにダイアログが開く
        const before = await paperStock();
        paperCard().querySelector('button[title="1個出庫"]').click();
        await waitFor(() => doc.getElementById('takeout-form'), '出庫のダイアログが開く');

        const chips = [...doc.querySelectorAll('#takeout-taker-chips .taker-chip')].map(c => c.textContent);
        addResult(
            '画面: -1 を押すと、何個・誰が出したかを入れるダイアログが開く（まだ誰も選ばれていない）',
            doc.getElementById('modal').classList.contains('show') &&
                doc.getElementById('takeout-quantity').value === '1' &&
                doc.querySelectorAll('.taker-chip.selected').length === 0 &&
                (await paperStock()) === before,
            `個数 ${doc.getElementById('takeout-quantity').value} / 在庫 ${before}`
        );
        addResult(
            '画面: 名前は打てず、名簿の人のボタンだけ（今日の勤務の人が先頭）',
            !doc.querySelector('#takeout-form input[type="text"]') &&
                chips[0] === '早番 一郎' && chips[1] === '遅番 二郎' &&
                [...chips].sort().join(',') === [...ROSTER].sort().join(','),
            chips.join(' , ')
        );

        // 誰も選ばずに押すと止める
        doc.getElementById('takeout-submit').click();
        await waitFor(() => doc.getElementById('takeout-error').style.display === 'block', 'エラーが出る');
        addResult(
            '画面: 出した人を選ばなければ登録しない',
            doc.getElementById('takeout-error').textContent.includes('選んでください') && (await paperStock()) === before,
            doc.getElementById('takeout-error').textContent
        );

        // 候補を押して、個数を 3 にして登録
        [...doc.querySelectorAll('.taker-chip')].find(c => c.textContent === '遅番 二郎').click();
        doc.getElementById('takeout-quantity').value = '3';
        doc.getElementById('takeout-submit').click();
        await waitFor(() => !doc.getElementById('modal').classList.contains('show'), 'ダイアログが閉じる');
        await waitFor(() => paperCard().querySelector('.stock-stat-value').textContent === String(before - 3), 'カードの在庫が減る');

        const latest = await findHistory('paper', 'out', tokyoToday());
        addResult(
            '画面: 選んだ人と個数で出庫が登録される（取引日は今日）',
            latest && latest.quantity === 3 && latest.taken_by === '遅番 二郎' &&
                (await paperStock()) === before - 3,
            `出庫 ${latest && latest.quantity} 個 / 出した人 ${latest && latest.taken_by}`
        );

        // -5 なら 5 が入っている。前のダイアログの中身は閉じても残るので、消してから開く
        doc.getElementById('modal-body').innerHTML = '';
        paperCard().querySelector('button[title="5個出庫"]').click();
        await waitFor(() => doc.getElementById('takeout-form'), '出庫のダイアログが開く（-5）');
        addResult(
            '画面: -5 を押すと個数に 5 が入っている',
            doc.getElementById('takeout-quantity').value === '5',
            doc.getElementById('takeout-quantity').value
        );
        window.closeModal();

        // 名簿が空の店では、選べる人がいないので出庫できない。理由とどうすればよいかを出す
        const realCandidates = window.loadTakerCandidates;
        window.loadTakerCandidates = async () => ({ names: [], operatorName: null });
        doc.getElementById('modal-body').innerHTML = '';
        paperCard().querySelector('button[title="1個出庫"]').click();
        await waitFor(() => doc.getElementById('takeout-form'), '出庫のダイアログが開く（名簿なし）');
        const emptyNote = doc.querySelector('#takeout-taker-chips .taker-empty-note');
        addResult(
            '画面: 名簿が空なら、管理者に登録を頼むよう案内し、出庫ボタンを押せない',
            emptyNote && emptyNote.textContent.includes('名簿がまだありません') &&
                doc.querySelectorAll('.taker-chip').length === 0 &&
                doc.getElementById('takeout-submit').disabled === true,
            emptyNote ? emptyNote.textContent : '案内なし'
        );
        window.closeModal();
        window.loadTakerCandidates = realCandidates;

        // 人ごとの集計は管理画面だけ。店の画面には出庫記録のタブが無い
        addResult(
            '画面: 店の画面には出庫記録（人ごとの集計）のタブが無い',
            !doc.querySelector('.nav-btn[data-page="takeouts"]') && !doc.getElementById('takeout-people-table'),
            'タブなし'
        );

        // --- 履歴確認にも出した人が出る ---
        doc.querySelector('.nav-btn[data-page="history"]').click();
        await waitFor(() => doc.querySelectorAll('#history-table > tbody > tr').length > 0, '履歴が描かれる');
        const historyText = doc.querySelector('#history-table tbody').textContent;
        addResult(
            '画面: 履歴確認の担当者欄に出した人と入力したアカウントが出る',
            historyText.includes('遅番 二郎') && historyText.includes('入力: テスト担当'),
            '遅番 二郎（入力: テスト担当）'
        );

        addResult(
            '画面: 操作中にエラーが出ていない',
            errors.length === 0,
            errors.length === 0 ? 'エラーなし' : errors.join(' / ')
        );
    } finally {
        window.close();
    }
}

async function testAdminScreen() {
    const { window, errors } = openAdminScreen(admin, BASE_URL);
    const doc = window.document;
    let downloaded = null;

    try {
        await waitFor(() => doc.getElementById('admin-name').textContent !== '', '管理画面が開く');

        doc.querySelector('.admin-tab[data-tab="takeouts"]').click();
        // 開いた直後の読み込み（直近 30 日）が終わるのを待つ。読み込み中に条件を変えると、
        // あとから届いた直近 30 日の結果で上書きされることがある
        const total = doc.getElementById('takeout-total');
        await waitFor(() => total.textContent !== '', '出庫記録タブが開く');

        addResult(
            '管理画面: 出庫記録タブは店舗を選んだ状態・直近 30 日で開く',
            doc.getElementById('takeout-location').value === String(locationId) &&
                doc.getElementById('takeout-start-date').value !== '' && doc.getElementById('takeout-end-date').value !== '',
            `店舗 ${doc.getElementById('takeout-location').value} / ` +
                `${doc.getElementById('takeout-start-date').value}〜${doc.getElementById('takeout-end-date').value}`
        );

        doc.getElementById('takeout-start-date').value = '2025-01-01';
        doc.getElementById('takeout-end-date').value = '2025-12-31';
        total.textContent = '';
        doc.getElementById('refresh-takeouts').click();
        await waitFor(() => total.textContent.startsWith('108件'), '2025 年の集計が描かれる');

        const takerOptions = [...doc.querySelectorAll('#takeout-taker-filter option')].map(o => o.textContent);
        addResult(
            '管理画面: 出した人の絞り込みに、これまでの名前と「（未記入）」が並ぶ',
            ['佐藤', '田中 花子', '鈴木', '遅番 二郎', '（未記入）'].every(name => takerOptions.includes(name)),
            takerOptions.join(' , ')
        );

        const quickRows = doc.querySelectorAll('#quick-restock-table tbody tr');
        addResult(
            '管理画面: 補充が早すぎる商品と、その間に出した人が出る',
            doc.getElementById('quick-restock-section').style.display === 'block' && quickRows.length === 1 &&
                quickRows[0].textContent.includes('トイレットペーパー') &&
                quickRows[0].textContent.includes('田中 花子 12個') && quickRows[0].textContent.includes('約14日'),
            quickRows[0] && quickRows[0].textContent.replace(/\s+/g, ' ').trim()
        );

        const peopleRows = [...doc.querySelectorAll('#takeout-people-table tbody tr')]
            .map(tr => tr.textContent.replace(/\s+/g, ' ').trim());
        addResult(
            '管理画面: 人ごとの集計（未記入も 1 行）',
            peopleRows[0].startsWith('鈴木') && peopleRows.some(r => r.startsWith('（未記入）')),
            peopleRows.join(' / ')
        );
        addResult(
            '管理画面: 明細が 100 件を超えるときは、その旨を出す',
            doc.querySelectorAll('#takeout-rows-table tbody tr').length === 100 &&
                doc.getElementById('takeout-rows-note').style.display === 'block',
            doc.getElementById('takeout-rows-note').textContent
        );

        // CSV に画面の店舗と条件がそのまま渡る
        window.downloadFile = url => { downloaded = url; };
        doc.getElementById('takeout-taker-filter').value = '田中 花子';
        doc.getElementById('export-takeouts').click();
        const exported = new URL(downloaded, BASE_URL);
        const tanakaCsv = await fetchCsv(downloaded, admin.state.cookie);
        addResult(
            '管理画面: 「出庫記録CSV出力」に店舗と画面の条件（期間・出した人）が渡る',
            exported.pathname === `/api/auth/admin/locations/${locationId}/takeouts/export` &&
                exported.searchParams.get('startDate') === '2025-01-01' &&
                exported.searchParams.get('endDate') === '2025-12-31' &&
                exported.searchParams.get('takenBy') === '田中 花子' && tanakaCsv.lines.length === 3,
            `${downloaded} / ${tanakaCsv.lines.length} 行`
        );

        doc.getElementById('takeout-taker-filter').value = '__unrecorded__';
        doc.getElementById('export-takeouts').click();
        const unrecordedParams = new URL(downloaded, BASE_URL).searchParams;
        const unrecordedCsv = await fetchCsv(downloaded, admin.state.cookie);
        addResult(
            '管理画面: 「（未記入）」を選ぶと、出した人が無い出庫だけの CSV になる',
            unrecordedParams.get('unrecorded') === '1' && !unrecordedParams.has('takenBy') &&
                unrecordedCsv.lines.length === 1,
            `${downloaded} / ${unrecordedCsv.lines.length} 行`
        );

        // --- 出す人の名簿（ユーザー・拠点管理で、店を選ぶと出る） ---
        doc.querySelector('.admin-tab[data-tab="management"]').click();
        await waitFor(() => doc.querySelector('.location-item .location-info'), '拠点の一覧が出る');
        doc.querySelector('.location-item .location-info').click();
        await waitFor(() => doc.querySelector('#users-list .btn-delete'), '店のユーザーが出る');
        const usersTable = doc.getElementById('users-table');
        addResult(
            '管理画面: 店を選ぶと、店のユーザーが削除ボタン付きで出る（表の display を決め打ちしない）',
            // 'table' と決め打ちすると、スマホ用の表示が効かずに削除ボタンが画面の外に出る
            usersTable.style.display === '' &&
                doc.querySelector('#users-list tr').textContent.includes('tester'),
            `display="${usersTable.style.display}" / ${doc.getElementById('users-list').textContent.replace(/\s+/g, ' ').trim()}`
        );
        const rosterNames =() => [...doc.querySelectorAll('#roster-list .roster-item')].map(item => item.dataset.name);
        const suggestionNames = () => [...doc.querySelectorAll('#roster-suggestions .roster-suggestion')].map(b => b.dataset.name);
        await waitFor(() => rosterNames().length === ROSTER.length, '名簿が出る');
        const shiftItems = [...doc.querySelectorAll('#roster-list .roster-item[data-source="shift"]')];
        addResult(
            '管理画面: 店を選ぶと、出す人の名簿と、足す候補（記録にある人）が出る',
            doc.getElementById('roster-section').style.display === 'block' &&
                [...rosterNames()].sort().join(',') === [...ROSTER].sort().join(',') &&
                suggestionNames().includes('臨時 花子'),
            `名簿 ${rosterNames().join(' , ')} / 候補 ${suggestionNames().join(' , ')}`
        );
        const userItem = doc.querySelector('#roster-list .roster-item[data-name="テスト担当"]');
        addResult(
            '管理画面: 店のユーザーから載っている人は「ユーザー」と出て、× で外せない',
            userItem && userItem.dataset.source === 'user' && userItem.textContent.includes('ユーザー') &&
                !userItem.querySelector('.roster-remove'),
            userItem ? userItem.textContent : '（いない）'
        );
        addResult(
            '管理画面: シフトから載っている人は「シフト」と出て、× で外せない',
            shiftItems.map(item => item.dataset.name).sort().join(',') === [...SHIFT].sort().join(',') &&
                shiftItems.every(item => item.textContent.includes('シフト') && !item.querySelector('.roster-remove')),
            shiftItems.map(item => item.textContent).join(' , ')
        );

        doc.getElementById('roster-name').value = '新人 太郎';
        doc.getElementById('add-roster-btn').click();
        await waitFor(() => rosterNames().includes('新人 太郎'), '打った名前が名簿に入る');
        [...doc.querySelectorAll('#roster-suggestions .roster-suggestion')]
            .find(b => b.dataset.name === '臨時 花子').click();
        await waitFor(() => rosterNames().includes('臨時 花子'), '候補を押すと名簿に入る');
        addResult(
            '管理画面: 名前を打って足せる・候補を押して足せる（足した候補は候補から消える）',
            rosterNames().includes('新人 太郎') && rosterNames().includes('臨時 花子') &&
                !suggestionNames().includes('臨時 花子') && doc.getElementById('roster-name').value === '',
            rosterNames().join(' , ')
        );

        doc.querySelector('#roster-list .roster-item[data-name="新人 太郎"] .roster-remove').click();
        await waitFor(() => !rosterNames().includes('新人 太郎'), '× で名簿から外れる');
        addResult(
            '管理画面: × で名簿から外せる',
            !rosterNames().includes('新人 太郎'),
            rosterNames().join(' , ')
        );

        addResult(
            '管理画面: 操作中にエラーが出ていない',
            errors.length === 0,
            errors.length === 0 ? 'エラーなし' : errors.join(' / ')
        );
    } finally {
        window.close();
    }
}

/**
 * 店のユーザー（管理画面の「ユーザー管理」）は、その店の名簿に自動で載る。
 * 出庫を入れるので、件数を数えるテストのあとに流す
 */
async function testStoreUsersOnRoster() {
    const rosterOf = async () => (await admin.request('GET', rosterUrl())).body.names;
    const sourceIn = (names, name) => (names.find(n => n.name === name) || {}).source;

    const initial = await rosterOf();
    const manualUser = await admin.request('POST', rosterUrl(), { name: 'テスト担当' });
    addResult(
        '名簿(ユーザー): 店のユーザーは「ユーザー」として自動で載り、手で重ねて足すことはできない',
        sourceIn(initial, 'テスト担当') === 'user' && manualUser.status === 409 &&
            String(manualUser.body.error).includes('店のユーザー'),
        `テスト担当: ${sourceIn(initial, 'テスト担当')} / 足す ${manualUser.status} ${manualUser.body.error || ''}`
    );

    // 同じ店に 2 人、別の店に 1 人足す
    const other = await admin.request('POST', '/api/auth/admin/locations', { locationName: '別のテスト店' });
    for (const [location, userId, userName] of [
        [locationId, 'order1', '発注 担当'],
        [locationId, 'pair1', '田中・佐藤'],
        [other.body.locationId, 'other1', '他店 次郎']
    ]) {
        const res = await admin.request('POST', '/api/auth/admin/users', {
            locationId: location, userId, userName, password: 'test-password-1234'
        });
        if (res.status !== 200) {
            throw new Error(`ユーザーを作れませんでした: ${userName} / ${JSON.stringify(res.body)}`);
        }
    }

    const added = await rosterOf();
    addResult(
        '名簿(ユーザー): ユーザーを足すと載る。2 人をまとめた名前と、別の店のユーザーは載らない',
        sourceIn(added, '発注 担当') === 'user' && !sourceIn(added, '田中・佐藤') && !sourceIn(added, '他店 次郎'),
        added.map(n => `${n.name}(${n.source})`).join(' , ')
    );

    const takeout = await request('POST', '/api/inventory/out', {
        productId: products.joy, quantity: 1, date: '2025-12-30', takenBy: '発注 担当'
    });
    const otherStore = await request('POST', '/api/inventory/out', {
        productId: products.joy, quantity: 1, date: '2025-12-30', takenBy: '他店 次郎'
    });
    const row = await findHistory('joy', 'out', '2025-12-30');
    addResult(
        '名簿(ユーザー): 店のユーザーの名前で出庫でき、別の店のユーザーの名前では出庫できない',
        takeout.status === 200 && row && row.taken_by === '発注 担当' && otherStore.status === 400,
        `この店 ${takeout.status} (${row && row.taken_by}) / 別の店 ${otherStore.status}`
    );

    const users = (await admin.request('GET', `/api/auth/admin/locations/${locationId}/users`)).body;
    const orderUser = users.find(user => user.user_id === 'order1');
    await admin.request('PUT', `/api/auth/admin/users/${orderUser.id}`, { userId: 'order1', userName: '発注 係' });
    const renamed = await rosterOf();
    await admin.request('DELETE', `/api/auth/admin/users/${orderUser.id}`);
    const deleted = await rosterOf();
    const afterDelete = await request('POST', '/api/inventory/out', {
        productId: products.joy, quantity: 1, date: '2025-12-31', takenBy: '発注 係'
    });
    addResult(
        '名簿(ユーザー): ユーザー名を直すと名簿も変わり、ユーザーを削除すると名簿から外れて出庫できない',
        sourceIn(renamed, '発注 係') === 'user' && !sourceIn(renamed, '発注 担当') &&
            !sourceIn(deleted, '発注 係') && afterDelete.status === 400 &&
            !(await findHistory('joy', 'out', '2025-12-31')),
        `直した後 ${renamed.map(n => n.name).join(' , ')} / 削除後の出庫 ${afterDelete.status}`
    );
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('========================================');
    console.log('出庫記録（誰が何個出したか）のテスト開始');
    console.log('========================================\n');

    testDetect();
    await testRosterSeed();

    const { server, waitUntilReady } = startServer({
        port: PORT,
        dbDir: DB_DIR,
        env: { IMPORT_SECRET, LINK_SECRET }
    });

    try {
        await waitUntilReady(BASE_URL);
        const location = await setupLocationUser(client);
        locationId = location.locationId;
        await loginAdmin();
        await seedRoster(MANUAL);
        await importShifts();

        await createProduct('paper', 'トイレットペーパー', '衛生用品', 500);
        await createProduct('glove', 'ニトリルグローブ(Ｍサイズ)', '衛生用品', 500);
        await createProduct('joy', 'P&G ジョイ 1/2', '洗剤', 200);

        await testRoster();
        await testRegister();
        await prepareRestocks();
        await testTakeoutsApi();
        await testAccess();
        await testCsv();
        await testCandidates(location.locationCode);
        await testScreen();
        await testAdminScreen();
        // 入場リンクの出庫は最後に入れる（件数を数えるテストに混ざらないように）
        await testEntryLinkName(location.locationCode);
        await testStoreUsersOnRoster();
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.stack || err.message);
    } finally {
        server.kill();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
})();
