/**
 * シフト区切りの在庫確認テストスクリプト
 *
 * 「登録が 0 件」だけでは、何も動かなかったのか登録を忘れたのか分からない。
 * 区切りごとの確認記録がその 2 つを区別できること、確認がないまま区切りを
 * 過ぎたら通知が出ることを確かめる。
 *
 * 使い方: node test-shifts.js
 */

const fs = require('fs');
const path = require('path');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser
} = require('./test-helpers');

const PORT = 3988;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-shift-http');
const MONITOR_DIR = createTempDbDir('inventory-shift-monitor');

const { results, addResult, printSummary } = createResults();

/** 今日の指定時刻の Date を作る */
function todayAt(hours, minutes) {
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
}

// ---------------------------------------------------------------------------
// 0. 通知の大元の切り替え
//
// 通知は既定で止めてある。「止めたつもりが鳴っていた」も「戻したつもりが
// 鳴らない」も困るので、どの値でどちらになるかを固定しておく。
// ---------------------------------------------------------------------------

function testNotificationSwitch() {
    const { notificationsEnabled } = require('./server/services/line-notify');
    const original = process.env.NOTIFICATIONS_ENABLED;

    const check = value => {
        if (value === undefined) {
            delete process.env.NOTIFICATIONS_ENABLED;
        } else {
            process.env.NOTIFICATIONS_ENABLED = value;
        }
        return notificationsEnabled();
    };

    try {
        addResult(
            '通知: 未設定なら送らない',
            check(undefined) === false,
            '既定は停止'
        );
        addResult(
            '通知: 空文字なら送らない',
            check('') === false,
            '停止'
        );
        addResult(
            '通知: true を設定すれば送る',
            check('true') === true,
            '有効'
        );
        addResult(
            '通知: 1 / on でも送る',
            check('1') === true && check('on') === true,
            '有効'
        );
        addResult(
            '通知: 大文字や前後の空白は無視する',
            check('  TRUE  ') === true && check('On') === true,
            '有効'
        );
        addResult(
            '通知: false / off なら送らない',
            check('false') === false && check('off') === false,
            '停止'
        );
        addResult(
            '通知: 意味の分からない値は送らない側に倒す',
            check('yes') === false && check('enabled') === false,
            '停止'
        );
    } finally {
        if (original === undefined) {
            delete process.env.NOTIFICATIONS_ENABLED;
        } else {
            process.env.NOTIFICATIONS_ENABLED = original;
        }
    }
}

// ---------------------------------------------------------------------------
// 1. 未確認の見張り（サーバーを起動せず、関数を直接呼ぶ）
// ---------------------------------------------------------------------------

async function testMonitor() {
    process.env.DB_DIR = MONITOR_DIR;

    const admin = require('./server/db/database-admin');
    const monitor = require('./server/services/shift-monitor');

    await admin.mainDb.ready;

    // 拠点を 1 つ用意する
    await admin.mainDb.run(
        "INSERT INTO locations (location_code, location_name, db_name) VALUES ('1', 'テスト店', 'location_1.db')"
    );

    const db = admin.getLocationDatabase('1');
    await db.ready;

    // 既定の朝昼晩を消して、検証用の区切りに置き換える
    await db.run('DELETE FROM shifts');
    const s1 = await db.run("INSERT INTO shifts (name, end_time, sort_order) VALUES ('検証1', '10:00', 1)");
    const s2 = await db.run("INSERT INTO shifts (name, end_time, sort_order) VALUES ('検証2', '11:00', 2)");
    const s3 = await db.run("INSERT INTO shifts (name, end_time, sort_order) VALUES ('検証3', '12:00', 3)");

    const alertCount = async (shiftId) => {
        const row = await db.get(
            'SELECT COUNT(*) as count FROM shift_alerts WHERE shift_id = ?',
            [shiftId]
        );
        return row.count;
    };

    // --- 猶予の中は通知しない（猶予を明示的に 15 分にして確かめる） ---
    await monitor.checkUnconfirmedShifts(todayAt(10, 5), { graceMinutes: 15 });
    addResult(
        '見張り: 区切り直後（猶予中）は通知しない',
        (await alertCount(s1.lastID)) === 0,
        `通知 ${await alertCount(s1.lastID)} 件（猶予 15 分を指定）`
    );

    // --- 猶予を過ぎたら通知する ---
    await monitor.checkUnconfirmedShifts(todayAt(10, 20), { graceMinutes: 15 });
    addResult(
        '見張り: 猶予を過ぎた未確認を通知する',
        (await alertCount(s1.lastID)) === 1,
        `通知 ${await alertCount(s1.lastID)} 件`
    );

    // --- 同じ区切りを二度通知しない ---
    await monitor.checkUnconfirmedShifts(todayAt(10, 40));
    addResult(
        '見張り: 同じ区切りを二度通知しない',
        (await alertCount(s1.lastID)) === 1,
        `通知 ${await alertCount(s1.lastID)} 件`
    );

    // --- 確認済みの区切りは通知しない ---
    const today = new Date();
    const dateText = monitor.toDateString(today);
    await db.run(
        `INSERT INTO shift_reports (shift_id, report_date, status, movement_count, user_id)
         VALUES (?, ?, 'no_change', 0, 1)`,
        [s2.lastID, dateText]
    );
    await monitor.checkUnconfirmedShifts(todayAt(11, 20));
    addResult(
        '見張り: 確認済みの区切りは通知しない',
        (await alertCount(s2.lastID)) === 0,
        `通知 ${await alertCount(s2.lastID)} 件`
    );

    // --- 時間が経ちすぎたものは通知しない ---
    await monitor.checkUnconfirmedShifts(todayAt(19, 0));
    addResult(
        '見張り: 区切りから離れすぎたものは通知しない',
        (await alertCount(s3.lastID)) === 0,
        `通知 ${await alertCount(s3.lastID)} 件（${monitor.STALE_HOURS} 時間で打ち切り）`
    );

    // --- 既定は区切りの時刻ちょうどに鳴る ---
    addResult(
        '見張り: 既定の猶予は 0 分（区切りの時刻ちょうど）',
        monitor.GRACE_MINUTES === 0,
        `GRACE_MINUTES = ${monitor.GRACE_MINUTES}`
    );

    const s5 = await db.run("INSERT INTO shifts (name, end_time, sort_order) VALUES ('検証5', '14:00', 5)");
    await monitor.checkUnconfirmedShifts(todayAt(14, 0));
    addResult(
        '見張り: 区切りの時刻ちょうどに通知する',
        (await alertCount(s5.lastID)) === 1,
        `通知 ${await alertCount(s5.lastID)} 件（14:00 の区切りを 14:00 に点検）`
    );

    // --- 曜日の指定が効く ---
    await db.run('DELETE FROM shifts');
    const offDay = '0'.repeat(7);
    const s4 = await db.run(
        "INSERT INTO shifts (name, end_time, sort_order, active_days) VALUES ('休業日', '10:00', 1, ?)",
        [offDay]
    );
    await monitor.checkUnconfirmedShifts(todayAt(10, 30));
    addResult(
        '見張り: 対象外の曜日は通知しない',
        (await alertCount(s4.lastID)) === 0,
        `通知 ${await alertCount(s4.lastID)} 件`
    );
}

// ---------------------------------------------------------------------------
// 2. 画面から使う API（サーバーを起動して叩く）
// ---------------------------------------------------------------------------

async function testApi(client) {
    const { request } = client;

    await setupLocationUser(client);

    // --- 初期値の確認 ---
    const defaults = await request('GET', '/api/shifts/settings');
    const defaultTimes = (defaults.body.shifts || []).map(s => s.end_time).join(', ');
    addResult(
        '初期値: 区切りが 14:00 / 19:00 / 22:00 で作られる',
        defaultTimes === '14:00, 19:00, 22:00',
        `区切り: ${defaultTimes}`
    );

    // 区切りを検証用に置き換える。
    //   00:01 → 常に「過ぎた区切り」
    //   23:58 → 常に「進行中の区切り」
    //   23:59 → 常に「これからの区切り」
    // （23:58〜24:00 のあいだに実行した場合のみ、この前提が崩れる）
    const settings = await request('PUT', '/api/shifts/settings', {
        shifts: [
            { name: '早番', end_time: '00:01' },
            { name: '中番', end_time: '23:58' },
            { name: '遅番', end_time: '23:59' }
        ]
    });
    addResult(
        '設定: 区切りを更新できる',
        settings.status === 200 && settings.body.shifts.length === 3,
        `status ${settings.status} / ${settings.body.shifts ? settings.body.shifts.length : 0} 件`
    );

    const shiftIds = {};
    for (const shift of settings.body.shifts) {
        shiftIds[shift.name] = shift.id;
    }

    // --- 状態の判定 ---
    const today = await request('GET', '/api/shifts/today');
    const byName = {};
    for (const shift of today.body.shifts) {
        byName[shift.name] = shift;
    }

    addResult(
        '状態: 過ぎた区切りが未確認として出る',
        byName['早番'] && byName['早番'].isPast === true && byName['早番'].confirmed === false,
        `早番 isPast=${byName['早番'] && byName['早番'].isPast} confirmed=${byName['早番'] && byName['早番'].confirmed}`
    );
    addResult(
        '状態: 進行中の区切りが 1 つだけ選ばれる',
        today.body.shifts.filter(s => s.isCurrent).length === 1 &&
            byName['中番'] && byName['中番'].isCurrent === true,
        `進行中 ${today.body.shifts.filter(s => s.isCurrent).map(s => s.name).join(', ')}`
    );

    // --- これからの区切りは確認できない ---
    const tooEarly = await request('POST', `/api/shifts/${shiftIds['遅番']}/confirm`, {});
    addResult(
        '確認: これからの区切りは確認できない',
        tooEarly.status === 400,
        `status ${tooEarly.status} / ${tooEarly.body.error || ''}`
    );

    // --- 登録が 0 件なら「変化なし」として記録される ---
    const created = await request('POST', '/api/products', {
        name: 'シフトテスト商品',
        category: 'テスト',
        reorder_point: 0,
        current_stock: 0
    });
    const productId = created.body.productId;

    const noChange = await request('POST', `/api/shifts/${shiftIds['中番']}/confirm`, {});
    addResult(
        '確認: 登録 0 件なら「変化なし」で記録される',
        noChange.status === 200 && noChange.body.status === 'no_change',
        `status ${noChange.status} / ${noChange.body.status}`
    );

    // --- 登録があれば「登録あり」として記録される ---
    await request('POST', '/api/inventory/in', { productId, quantity: 5, note: 'シフトテスト' });

    const afterMovement = await request('GET', '/api/shifts/today');
    const middle = afterMovement.body.shifts.find(s => s.name === '中番');
    addResult(
        '確認: 区切りの担当時間帯の登録件数が数えられる',
        middle.movementCount === 1,
        `登録件数 ${middle.movementCount}（期待値 1）`
    );

    const registered = await request('POST', `/api/shifts/${shiftIds['中番']}/confirm`, {});
    addResult(
        '確認: 登録があれば「登録あり」で記録し直される',
        registered.status === 200 && registered.body.status === 'registered',
        `status ${registered.status} / ${registered.body.status}`
    );

    // --- 過ぎた区切りも確認できる ---
    const late = await request('POST', `/api/shifts/${shiftIds['早番']}/confirm`, {});
    addResult(
        '確認: 過ぎた区切りをあとから確認できる',
        late.status === 200,
        `status ${late.status} / ${late.body.status}`
    );

    // --- 入力の検証 ---
    const badTime = await request('PUT', '/api/shifts/settings', {
        shifts: [{ name: '不正', end_time: '25:00' }]
    });
    addResult(
        '検証: ありえない時刻を拒否する',
        badTime.status === 400,
        `status ${badTime.status} / ${badTime.body.error || ''}`
    );

    const badDays = await request('PUT', '/api/shifts/settings', {
        shifts: [{ name: '不正', end_time: '10:00', active_days: '12345' }]
    });
    addResult(
        '検証: 曜日の指定が不正なら拒否する',
        badDays.status === 400,
        `status ${badDays.status} / ${badDays.body.error || ''}`
    );

    const emptyList = await request('PUT', '/api/shifts/settings', { shifts: [] });
    addResult(
        '検証: 区切りが空なら拒否する',
        emptyList.status === 400,
        `status ${emptyList.status} / ${emptyList.body.error || ''}`
    );

    const stillThere = await request('GET', '/api/shifts/settings');
    addResult(
        '検証: 拒否された更新で設定が壊れていない',
        stillThere.body.shifts.length === 3,
        `区切り ${stillThere.body.shifts.length} 件（期待値 3）`
    );

    // --- 履歴 ---
    const history = await request('GET', '/api/shifts/history?days=7');
    addResult(
        '履歴: 確認記録が残っている',
        history.status === 200 && history.body.reports.length === 2,
        `記録 ${history.body.reports ? history.body.reports.length : 0} 件（期待値 2）`
    );
    addResult(
        '履歴: 区切りごとの「変化なし」率が出る',
        history.body.summary && history.body.summary['早番'] &&
            history.body.summary['早番'].noChange === 1,
        `早番の変化なし ${history.body.summary && history.body.summary['早番'] ? history.body.summary['早番'].noChange : '?'} / ` +
        `中番の変化なし ${history.body.summary && history.body.summary['中番'] ? history.body.summary['中番'].noChange : '?'}`
    );

    // --- 区切りを減らしても確認記録が消えない ---
    await request('PUT', '/api/shifts/settings', {
        shifts: [{ id: shiftIds['中番'], name: '中番', end_time: '23:58' }]
    });
    const afterShrink = await request('GET', '/api/shifts/history?days=7');
    addResult(
        '設定: 区切りを減らしても過去の確認記録は残る',
        afterShrink.body.reports.length === 2,
        `記録 ${afterShrink.body.reports.length} 件（期待値 2）`
    );
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('========================================');
    console.log('シフト確認テスト開始');
    console.log('========================================\n');

    const { server, waitUntilReady } = startServer({ port: PORT, dbDir: DB_DIR });

    try {
        testNotificationSwitch();
        await testMonitor();
        await waitUntilReady(BASE_URL);
        await testApi(createClient(BASE_URL));
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.message);
    } finally {
        server.kill();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
        fs.rmSync(MONITOR_DIR, { recursive: true, force: true });
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
})();
