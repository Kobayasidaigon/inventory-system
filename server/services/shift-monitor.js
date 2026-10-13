// シフトの区切りごとに、在庫の登録が確認されたかを見張る。
//
// 登録が 0 件のとき、それが「本当に何も動かなかった」のか「登録を忘れた」のかは
// 記録がないと区別できない。区切りごとに担当者が確認を残す運用にして、
// 確認がないまま区切りの時刻を過ぎたら LINE に知らせる。

const { mainDb, getLocationDatabase } = require('../db/database-admin');
const { sendShiftReminder, sendShiftMemberReminder } = require('./line-notify');

// 区切りの時刻から締め切りまでの猶予（分）。
//
// 上がりの片付けを終えてから登録するので、区切りの時刻ちょうどで切ると、
// その区切りぶんの登録が次の区切りに落ちてしまう。猶予の中の登録は、
// 区切りの時刻を過ぎていても手前の区切りのものとして数える。
//
// 猶予を過ぎたら締め切る。締め切った区切りは確認を受け付けず、以降の
// 登録も数えない。後から取り繕えると、区切りごとに確認を残す意味がなくなる。
//
// 0 も指定できる（猶予なし＝区切りの時刻ちょうどで締め切る）ため、
// || ではなく数値として妥当かで見る。
const GRACE_MINUTES = (() => {
    const parsed = parseInt(process.env.SHIFT_GRACE_MINUTES, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
})();

// 区切りからこれ以上経っていたら通知しない。
// マシンが止まっていて復帰したときに、深夜へまとめて鳴らさないため。
const STALE_HOURS = 6;

// 見張りの間隔（分）。
// 通知を区切りの時刻ちょうどに近づけたいので毎分見る。
// 1 回の点検は拠点ごとに数クエリなので負荷は小さい。
const CHECK_INTERVAL_MINUTES = 1;

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
 * 0 時からの分数を 'HH:MM' に戻す。
 *
 * 猶予を足すと日をまたぐことがある（23:55 + 10 分）。その先に区切りは無いので
 * 24:00 で頭打ちにする。集計の上限としてはこれで足りる。
 */
function toTimeText(minutes) {
    const capped = Math.min(Math.max(minutes, 0), 24 * 60);
    const hour = Math.floor(capped / 60);
    const minute = capped % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
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
 * その人が、区切りの担当時間帯に自分の名前（出した人）で出庫を登録した件数。
 */
async function countMemberTakeouts(db, dateText, fromTime, toTime, name) {
    const row = await db.get(
        `SELECT COUNT(*) as count
         FROM inventory_history
         WHERE type = 'out' AND taken_by = ?
           AND datetime(created_at, 'localtime') >= ?
           AND datetime(created_at, 'localtime') < ?`,
        [name, `${dateText} ${fromTime}:00`, `${dateText} ${toTime}:00`]
    );

    return row ? row.count : 0;
}

/**
 * 2 人以上で入っている区切りか。この区切りは 1 人ずつ確認する（まとめての確定はしない）。
 */
function isPerMemberShift(shift) {
    return shift.members.length >= 2;
}

/**
 * 指定日のシフト一覧に、確認状況と登録件数を付けて返す。
 *
 * 画面のカードと、未確認の見張りの両方から使う。
 *
 * @returns {Promise<Array>} 区切りごとの状況
 */
async function buildShiftStatus(db, date, options = {}) {
    const graceMinutes = options.graceMinutes === undefined ? GRACE_MINUTES : options.graceMinutes;
    const dateText = toDateString(date);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();

    const shifts = await listShiftsForDate(db, date);
    const reports = await db.all(
        'SELECT * FROM shift_reports WHERE report_date = ?',
        [dateText]
    );
    const memberRows = await db.all(
        'SELECT * FROM shift_members WHERE report_date = ? ORDER BY id',
        [dateText]
    );

    const statuses = [];
    // 区切りの境目は「区切りの時刻」ではなく「締め切り」。猶予の中の登録は
    // 手前の区切りのものとして数えるので、次の区切りもそこから始まる。
    let previousClose = '00:00';
    // 今いる区切りは「まだ締め切っていない最初の区切り」1 つだけ
    let currentFound = false;

    for (const [index, shift] of shifts.entries()) {
        const report = reports.find(r => r.shift_id === shift.id) || null;
        const endMinutes = toMinutes(shift.end_time);

        // その日の最後の区切りは締め切らない。
        //
        // 締め切りは「その区切りぶんを次の区切りに渡す」ための線なので、次が
        // 無いところに引く意味がない。閉店の片付けを終えてから登録することも
        // あり、そこで締め切ると間に合わず、直しようもなく未確認だけが残る。
        // 日付が変わればどのみち翌日の区切りに切り替わる。
        const hasDeadline = index < shifts.length - 1;
        const closeMinutes = hasDeadline ? endMinutes + graceMinutes : 24 * 60;
        const closeTime = toTimeText(closeMinutes);

        const movements = await countMovements(db, dateText, previousClose, closeTime);

        // 区切りの時刻は過ぎた（猶予の中かもしれない）
        const isPast = nowMinutes >= endMinutes;
        // 締め切った。ここから先は確認も登録も受け付けない
        const isClosed = hasDeadline && nowMinutes >= closeMinutes;
        // 区切りの時刻を過ぎていても、猶予の中ならまだこの区切りにいる
        const isCurrent = !isClosed && !currentFound;

        if (isCurrent) {
            currentFound = true;
        }

        // 区切りに入っている人と、それぞれの確認。自分の名前で出庫を登録していれば
        // registered、「出していない」を押していれば no_change、どちらも無ければ null
        const members = [];
        for (const row of memberRows.filter(r => r.shift_id === shift.id)) {
            const takeoutCount = await countMemberTakeouts(db, dateText, previousClose, closeTime, row.name);
            members.push({
                name: row.name,
                takeoutCount,
                status: takeoutCount > 0 ? 'registered' : row.no_change_at ? 'no_change' : null,
                alerted: Boolean(row.alerted_at)
            });
        }

        // 2 人以上で入っている区切りは、全員が確認したら確認済み。まとめての確定は見ない
        // （1 人が押すと、もう 1 人の登録忘れが分からなくなるため）
        const perMember = members.length >= 2;
        const confirmed = perMember ? members.every(m => m.status) : report !== null;
        const confirmedStatus = !confirmed ? null
            : perMember ? (movements > 0 ? 'registered' : 'no_change')
            : report.status;

        statuses.push({
            id: shift.id,
            name: shift.name,
            startTime: previousClose,
            endTime: shift.end_time,
            closeTime,
            hasDeadline,
            isCurrent,
            isPast,
            isClosed,
            movementCount: movements,
            confirmed,
            confirmedStatus,
            confirmedAt: !perMember && report ? report.created_at : null,
            members,
            perMember
        });

        previousClose = closeTime;
    }

    return statuses;
}

/**
 * 未確認のまま区切りを過ぎたシフトを探して LINE に通知する。
 *
 * 同じ区切りについて二度鳴らさないよう、送信したら shift_alerts に残す。
 */
async function checkUnconfirmedShifts(now = new Date(), options = {}) {
    const graceMinutes = options.graceMinutes === undefined ? GRACE_MINUTES : options.graceMinutes;
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

            const statuses = await buildShiftStatus(db, now, { graceMinutes });

            for (const shift of statuses) {
                const endMinutes = toMinutes(shift.endTime);
                const elapsed = nowMinutes - endMinutes;

                // まだ区切り前、猶予の中、または遅すぎるものは対象外
                if (elapsed < graceMinutes || elapsed > STALE_HOURS * 60) {
                    continue;
                }

                // 2 人以上で入っている区切りは、まだ確認していない人を名前付きで知らせる。
                // 区切り全体の「確認がまだです」は出さない（誰がまだかの方が動きやすい）
                if (isPerMemberShift(shift)) {
                    const missing = shift.members.filter(m => !m.status && !m.alerted).map(m => m.name);
                    if (missing.length === 0) {
                        continue;
                    }

                    // 通知済みの記録を先に残す（LINE が失敗しても鳴らし直さない。下と同じ考え）
                    for (const name of missing) {
                        await db.run(
                            `UPDATE shift_members SET alerted_at = CURRENT_TIMESTAMP
                             WHERE shift_id = ? AND report_date = ? AND name = ?`,
                            [shift.id, dateText, name]
                        );
                    }

                    if (groupId) {
                        await sendShiftMemberReminder(groupId, {
                            locationName: location.location_name,
                            shiftName: shift.name,
                            endTime: shift.endTime,
                            names: missing
                        });
                    }

                    notified++;
                    console.log(
                        `区切りの未登録を通知しました: ${location.location_name} / ${shift.name}（${shift.endTime}）/ ${missing.join('・')}`
                    );
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
                        endTime: shift.endTime
                    });
                }

                notified++;
                console.log(
                    `シフト未確認を通知しました: ${location.location_name} / ${shift.name}（${shift.endTime}）`
                );
            }
        }
    } catch (err) {
        console.error('シフト確認の点検でエラーが発生しました:', err);
    }

    return notified;
}

/**
 * 入場リンクで入った人を、今の区切りに入っている人として記録する。
 *
 * 2 人のシフトは「田中・佐藤」のように来るので、名簿の人に合わせて 1 人ずつにしたもの
 * （names）を受け取る。すでに記録してある人はそのまま。
 *
 * @returns {Promise<object|null>} 記録した区切り。区切りが無い日は null
 */
async function recordShiftMembers(db, now, names) {
    if (!names || names.length === 0) {
        return null;
    }

    const statuses = await buildShiftStatus(db, now);
    const current = statuses.find(shift => shift.isCurrent);
    if (!current) {
        return null;
    }

    const dateText = toDateString(now);
    for (const name of names) {
        await db.run(
            'INSERT OR IGNORE INTO shift_members (shift_id, report_date, name) VALUES (?, ?, ?)',
            [current.id, dateText, name]
        );
    }

    return current;
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
    toTimeText,
    listShiftsForDate,
    buildShiftStatus,
    isPerMemberShift,
    recordShiftMembers,
    checkUnconfirmedShifts,
    startShiftMonitor,
    stopShiftMonitor
};
