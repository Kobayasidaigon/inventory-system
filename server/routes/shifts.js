// シフトの区切りごとの在庫確認。
//
// 「登録が 0 件」だけでは、何も動かなかったのか登録を忘れたのか分からない。
// 区切りごとに担当者が確認を残すことで、その 2 つを区別できるようにする。

const express = require('express');
const { getLocationDatabase } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const { sanitizeHtml } = require('../utils/xss-protection');
const { StockError, parsePositiveInt, withTransaction, respondWithStockError } = require('../utils/stock');
const { toDateString, buildShiftStatus } = require('../services/shift-monitor');

const router = express.Router();

/**
 * 'HH:MM' 形式の時刻を検証する。
 */
function parseTimeOfDay(value) {
    const text = String(value ?? '').trim();

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
        throw new StockError('区切りの時刻は HH:MM 形式（00:00〜23:59）で指定してください');
    }

    return text;
}

/**
 * 曜日の指定を検証する。日曜始まりの 7 文字（例 '1111100' は平日のみ）。
 */
function parseActiveDays(value) {
    if (value === undefined || value === null || value === '') {
        return '1111111';
    }

    const text = String(value).trim();

    if (!/^[01]{7}$/.test(text)) {
        throw new StockError('曜日の指定は 0 と 1 の 7 文字で指定してください');
    }

    return text;
}

/**
 * 区切りの名前を検証する。
 */
function parseShiftName(value) {
    const name = sanitizeHtml(String(value ?? '')).trim();

    if (!name) {
        throw new StockError('区切りの名前を入力してください');
    }
    if (name.length > 20) {
        throw new StockError('区切りの名前は 20 文字以内で入力してください');
    }

    return name;
}

// 今日の区切りと確認状況を返す
router.get('/today', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const now = new Date();
        const shifts = await buildShiftStatus(db, now);

        res.json({
            date: toDateString(now),
            shifts
        });
    } catch (err) {
        respondWithStockError(res, err, 'シフト状況の取得に失敗しました');
    }
});

// 区切りの確認を登録する
router.post('/:id/confirm', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const shiftId = parsePositiveInt(req.params.id, 'シフトID');
        const now = new Date();
        const dateText = toDateString(now);

        const result = await withTransaction(db, async () => {
            const shifts = await buildShiftStatus(db, now);
            const target = shifts.find(shift => shift.id === shiftId);

            if (!target) {
                throw new StockError('区切りが見つかりません', 404);
            }

            // まだ担当時間帯に入っていない区切りは確認できない。
            // 先に押しておく運用を許すと、確認の意味がなくなる。
            if (!target.isCurrent && !target.isPast) {
                throw new StockError('この区切りはまだ始まっていません');
            }

            // 「変化なし」か「登録あり」かは、その区切りに実際に登録された
            // 件数で決める。利用者に選ばせると、押しやすい方に流れる。
            const status = target.movementCount > 0 ? 'registered' : 'no_change';

            const existing = await db.get(
                'SELECT id FROM shift_reports WHERE shift_id = ? AND report_date = ?',
                [shiftId, dateText]
            );

            if (existing) {
                await db.run(
                    `UPDATE shift_reports
                     SET status = ?, movement_count = ?, user_id = ?, created_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [status, target.movementCount, req.session.userId, existing.id]
                );
            } else {
                await db.run(
                    `INSERT INTO shift_reports (shift_id, report_date, status, movement_count, user_id)
                     VALUES (?, ?, ?, ?, ?)`,
                    [shiftId, dateText, status, target.movementCount, req.session.userId]
                );
            }

            return { status, movementCount: target.movementCount, name: target.name };
        });

        res.json({
            success: true,
            status: result.status,
            movementCount: result.movementCount,
            shifts: await buildShiftStatus(db, now)
        });
    } catch (err) {
        respondWithStockError(res, err, 'シフトの確認登録に失敗しました');
    }
});

// 区切りの設定を取得する
router.get('/settings', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const shifts = await db.all(
            'SELECT * FROM shifts WHERE enabled = 1 ORDER BY sort_order, end_time'
        );
        res.json({ shifts });
    } catch (err) {
        respondWithStockError(res, err, '区切り設定の取得に失敗しました');
    }
});

// 区切りの設定を更新する
router.put('/settings', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        if (!Array.isArray(req.body.shifts) || req.body.shifts.length === 0) {
            throw new StockError('区切りを 1 つ以上指定してください');
        }
        if (req.body.shifts.length > 12) {
            throw new StockError('区切りは 12 個までです');
        }

        // 先に全部検証する。1 つでも不正なら 1 つも変更しない。
        const shifts = req.body.shifts.map((shift, index) => ({
            id: shift.id === undefined || shift.id === null || shift.id === '' ? null : parsePositiveInt(shift.id, 'シフトID'),
            name: parseShiftName(shift.name),
            endTime: parseTimeOfDay(shift.end_time),
            activeDays: parseActiveDays(shift.active_days),
            sortOrder: index + 1
        }));

        await withTransaction(db, async () => {
            const keptIds = [];

            for (const shift of shifts) {
                if (shift.id) {
                    await db.run(
                        `UPDATE shifts
                         SET name = ?, end_time = ?, active_days = ?, sort_order = ?, enabled = 1
                         WHERE id = ?`,
                        [shift.name, shift.endTime, shift.activeDays, shift.sortOrder, shift.id]
                    );
                    keptIds.push(shift.id);
                } else {
                    const result = await db.run(
                        `INSERT INTO shifts (name, end_time, active_days, sort_order)
                         VALUES (?, ?, ?, ?)`,
                        [shift.name, shift.endTime, shift.activeDays, shift.sortOrder]
                    );
                    keptIds.push(result.lastID);
                }
            }

            // 一覧から消えた区切りは削除せず無効にする。
            // 削除すると、その区切りで残した確認記録が参照先を失う。
            const placeholders = keptIds.map(() => '?').join(', ');
            await db.run(
                `UPDATE shifts SET enabled = 0 WHERE id NOT IN (${placeholders})`,
                keptIds
            );
        });

        const updated = await db.all(
            'SELECT * FROM shifts WHERE enabled = 1 ORDER BY sort_order, end_time'
        );
        res.json({ success: true, shifts: updated });
    } catch (err) {
        respondWithStockError(res, err, '区切り設定の更新に失敗しました');
    }
});

// 確認履歴を返す（「変化なし」ばかりの区切りを見つけるため）
router.get('/history', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);

        const rows = await db.all(
            `SELECT
                r.report_date,
                r.status,
                r.movement_count,
                r.created_at,
                s.name as shift_name,
                s.end_time
             FROM shift_reports r
             JOIN shifts s ON r.shift_id = s.id
             WHERE r.report_date >= DATE('now', 'localtime', '-' || ? || ' days')
             ORDER BY r.report_date DESC, s.sort_order ASC`,
            [days]
        );

        // 区切りごとの「変化なし」の割合。押すだけの運用になっていないか見る。
        const summary = {};
        for (const row of rows) {
            if (!summary[row.shift_name]) {
                summary[row.shift_name] = { total: 0, noChange: 0 };
            }
            summary[row.shift_name].total++;
            if (row.status === 'no_change') {
                summary[row.shift_name].noChange++;
            }
        }

        res.json({ days, reports: rows, summary });
    } catch (err) {
        respondWithStockError(res, err, '確認履歴の取得に失敗しました');
    }
});

module.exports = router;
