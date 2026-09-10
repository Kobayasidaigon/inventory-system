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

    // --- 既定の猶予は 10 分。締め切りと同時に鳴る ---
    addResult(
        '見張り: 既定の猶予は 10 分',
        monitor.GRACE_MINUTES === 10,
        `GRACE_MINUTES = ${monitor.GRACE_MINUTES}`
    );

    const s5 = await db.run("INSERT INTO shifts (name, end_time, sort_order) VALUES ('検証5', '14:00', 5)");
    await monitor.checkUnconfirmedShifts(todayAt(14, 0));
    addResult(
        '見張り: 区切りの時刻ちょうどでは、まだ鳴らさない',
        (await alertCount(s5.lastID)) === 0,
        `通知 ${await alertCount(s5.lastID)} 件（14:00 の区切りを 14:00 に点検）`
    );

    await monitor.checkUnconfirmedShifts(todayAt(14, 10));
    addResult(
        '見張り: 締め切り（区切り + 猶予）で鳴る',
        (await alertCount(s5.lastID)) === 1,
        `通知 ${await alertCount(s5.lastID)} 件（14:00 の区切りを 14:10 に点検）`
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

    await testGrace(db, monitor);
}

// ---------------------------------------------------------------------------
// 1b. 猶予と締め切り
//
// 上がりの片付けを終えてから登録するので、区切りの時刻ちょうどで切ると、
// その区切りぶんが次の区切りに落ちる。猶予の中の登録は手前の区切りに数え、
// 猶予を過ぎたら締め切る。ここが今回の変更の中身なので、時刻を作って固定する。
// ---------------------------------------------------------------------------

/** ローカル時刻の Date を、created_at にそのまま入れられる UTC の文字列にする */
function toUtcStamp(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function testGrace(db, monitor) {
    const GRACE = 10;

    await db.run('DELETE FROM shifts');
    await db.run('DELETE FROM inventory_history');
    const morning = await db.run(
        "INSERT INTO shifts (name, end_time, sort_order) VALUES ('朝番', '14:00', 1)"
    );
    await db.run("INSERT INTO shifts (name, end_time, sort_order) VALUES ('昼番', '19:00', 2)");

    const addMovement = (hour, minute) => db.run(
        `INSERT INTO inventory_history (product_id, type, quantity, note, user_id, created_at)
         VALUES (1, 'in', 1, 'テスト', 1, ?)`,
        [toUtcStamp(todayAt(hour, minute))]
    );

    const statusAt = async (hour, minute) => {
        const list = await monitor.buildShiftStatus(db, todayAt(hour, minute), { graceMinutes: GRACE });
        return Object.fromEntries(list.map(s => [s.name, s]));
    };

    // 区切りの時刻を 5 分過ぎてからの登録
    await addMovement(14, 5);

    const inGrace = await statusAt(14, 5);
    addResult(
        '猶予: 締め切りが区切り + 猶予になる',
        inGrace['朝番'].closeTime === '14:10',
        `朝番の締め切り ${inGrace['朝番'].closeTime}`
    );
    addResult(
        '猶予: 区切りを過ぎても、猶予の中はまだ朝番',
        inGrace['朝番'].isPast === true &&
            inGrace['朝番'].isClosed === false &&
            inGrace['朝番'].isCurrent === true,
        `isPast=${inGrace['朝番'].isPast} isClosed=${inGrace['朝番'].isClosed} isCurrent=${inGrace['朝番'].isCurrent}`
    );
    addResult(
        '猶予: 14:05 の登録は朝番に数える',
        inGrace['朝番'].movementCount === 1 && inGrace['昼番'].movementCount === 0,
        `朝番 ${inGrace['朝番'].movementCount} 件 / 昼番 ${inGrace['昼番'].movementCount} 件`
    );

    // 締め切りを過ぎた時点
    const afterClose = await statusAt(14, 15);
    addResult(
        '締め切り: 猶予を過ぎたら朝番は締め切る',
        afterClose['朝番'].isClosed === true && afterClose['朝番'].isCurrent === false,
        `isClosed=${afterClose['朝番'].isClosed} isCurrent=${afterClose['朝番'].isCurrent}`
    );
    addResult(
        '締め切り: 締め切ったあとは昼番が今の区切りになる',
        afterClose['昼番'].isCurrent === true,
        `昼番 isCurrent=${afterClose['昼番'].isCurrent}`
    );
    addResult(
        '締め切り: 締め切っても、朝番に数えた分は動かない',
        afterClose['朝番'].movementCount === 1,
        `朝番 ${afterClose['朝番'].movementCount} 件`
    );

    // 締め切り後の登録は次の区切りへ
    await addMovement(14, 15);
    const afterMore = await statusAt(14, 20);
    addResult(
        '締め切り: 締め切ってからの登録は朝番に入らない',
        afterMore['朝番'].movementCount === 1 && afterMore['昼番'].movementCount === 1,
        `朝番 ${afterMore['朝番'].movementCount} 件 / 昼番 ${afterMore['昼番'].movementCount} 件`
    );

    // 猶予を 0 にすれば元の切り方に戻る
    const noGrace = await monitor.buildShiftStatus(db, todayAt(14, 5), { graceMinutes: 0 });
    const morningNoGrace = noGrace.find(s => s.name === '朝番');
    addResult(
        '猶予: 0 分にすれば区切りの時刻ちょうどで切れる',
        morningNoGrace.isClosed === true && morningNoGrace.movementCount === 0,
        `isClosed=${morningNoGrace.isClosed} / 朝番 ${morningNoGrace.movementCount} 件`
    );

    // 日をまたぐ区切りで締め切りが壊れないこと
    addResult(
        '猶予: 日をまたぐ締め切りは 24:00 で止める',
        monitor.toTimeText(23 * 60 + 55 + GRACE) === '24:00' &&
            monitor.toTimeText(14 * 60 + GRACE) === '14:10',
        `23:55+${GRACE} → ${monitor.toTimeText(23 * 60 + 55 + GRACE)}`
    );

    // --- その日の最後の区切りは締め切らない ---
    //
    // 締め切りは「その区切りぶんを次に渡す」線なので、次が無いところには引かない。
    // 閉店の片付けを終えてから登録しても間に合うようにする。
    const lastAfterEnd = await statusAt(19, 30);
    addResult(
        '最後の区切り: 区切りの時刻を過ぎても締め切らない',
        lastAfterEnd['昼番'].hasDeadline === false &&
            lastAfterEnd['昼番'].isClosed === false &&
            lastAfterEnd['昼番'].isPast === true,
        `hasDeadline=${lastAfterEnd['昼番'].hasDeadline} isClosed=${lastAfterEnd['昼番'].isClosed}`
    );
    addResult(
        '最後の区切り: 締め切りは 24:00（日付が変わるまで）',
        lastAfterEnd['昼番'].closeTime === '24:00',
        `締め切り ${lastAfterEnd['昼番'].closeTime}`
    );
    addResult(
        '最後の区切り: 時刻を過ぎても、そこが今の区切りのまま',
        lastAfterEnd['昼番'].isCurrent === true,
        `isCurrent=${lastAfterEnd['昼番'].isCurrent}`
    );
    addResult(
        '最後の区切り: 手前の区切りは今まで通り締め切る',
        lastAfterEnd['朝番'].hasDeadline === true && lastAfterEnd['朝番'].isClosed === true,
        `朝番 hasDeadline=${lastAfterEnd['朝番'].hasDeadline} isClosed=${lastAfterEnd['朝番'].isClosed}`
    );

    // 閉店後の登録も最後の区切りに数える
    await addMovement(23, 30);
    const lateNight = await statusAt(23, 45);
    addResult(
        '最後の区切り: 区切りの時刻を過ぎてからの登録も数える',
        lateNight['昼番'].movementCount === 2,
        `昼番 ${lateNight['昼番'].movementCount} 件（14:15 と 23:30 のぶん）`
    );

    await db.run('DELETE FROM inventory_history');
    void morning;
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

    // --- 締め切った区切りは確認できない ---
    // 早番の区切りは 00:01。猶予を足しても 00:11 には締め切っている。
    // 後から取り繕えると、区切りごとに確認を残す意味がなくなる。
    const late = await request('POST', `/api/shifts/${shiftIds['早番']}/confirm`, {});
    addResult(
        '確認: 締め切った区切りはあとから確認できない',
        late.status === 400 && String(late.body.error || '').includes('締め切'),
        `status ${late.status} / ${late.body.error || ''}`
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
    // 早番は締め切り済みで確認できないので、残るのは中番の 1 件だけ
    addResult(
        '履歴: 確認記録が残っている',
        history.status === 200 && history.body.reports.length === 1,
        `記録 ${history.body.reports ? history.body.reports.length : 0} 件（期待値 1）`
    );
    addResult(
        '履歴: 区切りごとの「変化なし」率が出る',
        history.body.summary && history.body.summary['中番'] &&
            history.body.summary['中番'].total === 1 &&
            history.body.summary['中番'].noChange === 0,
        `中番 ${history.body.summary && history.body.summary['中番'] ? JSON.stringify(history.body.summary['中番']) : '?'}` +
        `（登録ありで確定し直したので変化なしは 0）`
    );

    // --- 区切りを減らしても確認記録が消えない ---
    await request('PUT', '/api/shifts/settings', {
        shifts: [{ id: shiftIds['中番'], name: '中番', end_time: '23:58' }]
    });
    const afterShrink = await request('GET', '/api/shifts/history?days=7');
    addResult(
        '設定: 区切りを減らしても過去の確認記録は残る',
        afterShrink.body.reports.length === 1,
        `記録 ${afterShrink.body.reports.length} 件（期待値 1）`
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
