// シフトの区切りごとに、在庫の登録が確認されたかを見張る。
//
// 登録が 0 件のとき、それが「本当に何も動かなかった」のか「登録を忘れた」のかは
// 記録がないと区別できない。区切りごとに担当者が確認を残す運用にして、
// 確認がないまま区切りの時刻を過ぎたら LINE に知らせる。

const { mainDb, getLocationDatabase } = require('../db/database-admin');
const { sendShiftReminder } = require('./line-notify');

// 区切りの時刻を過ぎてから通知するまでの猶予。
// 締めの作業をしている最中に鳴らされると、通知そのものが煩わしくなる。
const GRACE_MINUTES = 15;

// 区切りからこれ以上経っていたら通知しない。
// マシンが止まっていて復帰したときに、深夜へまとめて鳴らさないため。
const STALE_HOURS = 6;

// 見張りの間隔（分）
const CHECK_INTERVAL_MINUTES = 5;

/**
 * Date をローカル時刻のまま YYYY-MM-DD にする。
 */
function toDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 'HH:MM' を 0 時からの分数にする。時刻どうしの比較に使う。
 */
function toMinutes(timeText) {
    const [hour, minute] = String(timeText).split(':');
    return (parseInt(hour, 10) || 0) * 60 + (parseInt(minute, 10) || 0);
}

/**
 * その曜日にこの区切りを使うか。active_days は日曜始まりの 7 文字（例 '1111100'）。
 */
function isActiveOn(shift, date) {
    const days = String(shift.active_days || '1111111');
    return days[date.getDay()] === '1';
}

/**
 * 指定日に有効なシフトを、区切りの早い順に返す。
 */
async function listShiftsForDate(db, date) {
    const shifts = await db.all(
        'SELECT * FROM shifts WHERE enabled = 1 ORDER BY sort_order, end_time'
    );

    return shifts
        .filter(shift => isActiveOn(shift, date))
        .sort((a, b) => toMinutes(a.end_time) - toMinutes(b.end_time));
}

/**
 * ある区切りの担当時間帯に登録された在庫の件数を数える。
 *
 * 「その日の 0 時から最初の区切りまで」「前の区切りから次の区切りまで」を
 * その区切りの担当時間帯とする。
 *
 * inventory_history.created_at は SQLite の CURRENT_TIMESTAMP なので UTC。
 * 区切りの時刻はその土地の時計なので、localtime に直してから比べる。
 */
async function countMovements(db, dateText, fromTime, toTime) {
    const row = await db.get(
        `SELECT COUNT(*) as count
         FROM inventory_history
         WHERE datetime(created_at, 'localtime') >= ?
           AND datetime(created_at, 'localtime') < ?`,
        [`${dateText} ${fromTime}:00`, `${dateText} ${toTime}:00`]
    );

    return row ? row.count : 0;
}

/**
 * 指定日のシフト一覧に、確認状況と登録件数を付けて返す。
 *
 * 画面のカードと、未確認の見張りの両方から使う。
 *
 * @returns {Promise<Array>} 区切りごとの状況
 */
async function buildShiftStatus(db, date) {
    const dateText = toDateString(date);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();

    const shifts = await listShiftsForDate(db, date);
    const reports = await db.all(
        'SELECT * FROM shift_reports WHERE report_date = ?',
        [dateText]
    );

    const statuses = [];
    let previousEnd = '00:00';
    // 今いる区切りは「まだ終わっていない最初の区切り」1 つだけ
    let currentFound = false;

    for (const shift of shifts) {
        const report = reports.find(r => r.shift_id === shift.id) || null;
        const movements = await countMovements(db, dateText, previousEnd, shift.end_time);
        const endMinutes = toMinutes(shift.end_time);
        const isPast = nowMinutes >= endMinutes;
        const isCurrent = !isPast && !currentFound;

        if (isCurrent) {
            currentFound = true;
        }

        statuses.push({
            id: shift.id,
            name: shift.name,
            startTime: previousEnd,
            endTime: shift.end_time,
            isCurrent,
            isPast,
            movementCount: movements,
            confirmed: report !== null,
            confirmedStatus: report ? report.status : null,
            confirmedAt: report ? report.created_at : null
        });

        previousEnd = shift.end_time;
    }

    return statuses;
}

/**
 * 未確認のまま区切りを過ぎたシフトを探して LINE に通知する。
 *
 * 同じ区切りについて二度鳴らさないよう、送信したら shift_alerts に残す。
 */
async function checkUnconfirmedShifts(now = new Date()) {
    let notified = 0;

    try {
        const locations = await mainDb.all('SELECT * FROM locations');
        const groupSetting = await mainDb.get(
            "SELECT value FROM settings WHERE key = 'line_group_id'"
        );
        const groupId = groupSetting ? groupSetting.value : null;

        const dateText = toDateString(now);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        for (const location of locations) {
            const db = getLocationDatabase(location.location_code);
            if (db.ready) {
                await db.ready;
            }

            const shifts = await listShiftsForDate(db, now);

            for (const shift of shifts) {
                const endMinutes = toMinutes(shift.end_time);
                const elapsed = nowMinutes - endMinutes;

                // まだ区切り前、猶予の中、または遅すぎるものは対象外
                if (elapsed < GRACE_MINUTES || elapsed > STALE_HOURS * 60) {
                    continue;
                }

                const report = await db.get(
                    'SELECT id FROM shift_reports WHERE shift_id = ? AND report_date = ?',
                    [shift.id, dateText]
                );
                if (report) {
                    continue;
                }

                const alerted = await db.get(
                    'SELECT id FROM shift_alerts WHERE shift_id = ? AND report_date = ?',
                    [shift.id, dateText]
                );
                if (alerted) {
                    continue;
                }

                // 通知済みの記録を先に残す。LINE が失敗したときに何度も
                // 鳴らし直すより、1 回落ちる方が実害が小さい。
                await db.run(
                    'INSERT INTO shift_alerts (shift_id, report_date) VALUES (?, ?)',
                    [shift.id, dateText]
                );

                if (groupId) {
                    await sendShiftReminder(groupId, {
                        locationName: location.location_name,
                        shiftName: shift.name,
                        endTime: shift.end_time
                    });
                }

                notified++;
                console.log(
                    `シフト未確認を通知しました: ${location.location_name} / ${shift.name}（${shift.end_time}）`
                );
            }
        }
    } catch (err) {
        console.error('シフト確認の点検でエラーが発生しました:', err);
    }

    return notified;
}

let timer = null;

/**
 * 見張りを開始する。
 *
 * 注意: Fly.io の auto_stop_machines が有効でアクセスが途切れるとマシンが止まり、
 * このタイマーも止まる。通知を確実に出すには min_machines_running = 1 が要る。
 */
function startShiftMonitor(intervalMinutes = CHECK_INTERVAL_MINUTES) {
    if (timer) {
        return timer;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    timer = setInterval(() => {
        checkUnconfirmedShifts().catch(err => {
            console.error('シフト確認の点検に失敗しました:', err);
        });
    }, intervalMs);

    // プロセスの終了を妨げない
    if (timer.unref) {
        timer.unref();
    }

    console.log(`シフト未確認の見張りを開始しました（${intervalMinutes}分ごと）`);
    return timer;
}

function stopShiftMonitor() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

module.exports = {
    GRACE_MINUTES,
    STALE_HOURS,
    toDateString,
    toMinutes,
    listShiftsForDate,
    buildShiftStatus,
    checkUnconfirmedShifts,
    startShiftMonitor,
    stopShiftMonitor
};
