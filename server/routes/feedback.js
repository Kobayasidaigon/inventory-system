const express = require('express');
const router = express.Router();
const { mainDb } = require('../db/database-admin');
const { sanitizeHtml } = require('../utils/xss-protection');

// ご意見を投稿（匿名）
router.post('/feedback', async (req, res) => {
    try {
        const { feedbackText } = req.body;

        if (!feedbackText || feedbackText.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'ご意見を入力してください' });
        }

        // XSS対策: ユーザー入力をサニタイズ
        const sanitizedFeedback = sanitizeHtml(feedbackText.trim());

        // location_idを取得（ログインしていない場合はnull）
        const locationId = req.session.locationId || null;

        await mainDb.run(
            'INSERT INTO feedbacks (location_id, feedback_text, status) VALUES (?, ?, ?)',
            [locationId, sanitizedFeedback, 'new']
        );

        res.json({ success: true, message: 'ご意見を送信しました。ありがとうございます！' });
    } catch (error) {
        console.error('Feedback submission error:', error);
        res.status(500).json({ success: false, error: 'ご意見の送信に失敗しました' });
    }
});

// 管理者用：ご意見一覧取得
router.get('/admin/feedbacks', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ success: false, error: '権限がありません' });
        }

        const feedbacks = await mainDb.all(`
            SELECT
                f.id,
                f.feedback_text,
                f.status,
                f.created_at,
                l.location_name
            FROM feedbacks f
            LEFT JOIN locations l ON f.location_id = l.id
            ORDER BY
                CASE f.status
                    WHEN 'new' THEN 1
                    WHEN 'read' THEN 2
                    WHEN 'resolved' THEN 3
                END,
                f.created_at DESC
        `);

        res.json({ success: true, feedbacks });
    } catch (error) {
        console.error('Get feedbacks error:', error);
        res.status(500).json({ success: false, error: 'ご意見の取得に失敗しました' });
    }
});

// 管理者用：ご意見のステータス更新
router.put('/admin/feedbacks/:id/status', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ success: false, error: '権限がありません' });
        }

        const { id } = req.params;
        const { status } = req.body;

        if (!['new', 'read', 'resolved'].includes(status)) {
            return res.status(400).json({ success: false, error: '無効なステータスです' });
        }

        await mainDb.run(
            'UPDATE feedbacks SET status = ? WHERE id = ?',
            [status, id]
        );

        res.json({ success: true, message: 'ステータスを更新しました' });
    } catch (error) {
        console.error('Update feedback status error:', error);
        res.status(500).json({ success: false, error: 'ステータスの更新に失敗しました' });
    }
});

// 管理者用：ご意見を削除
router.delete('/admin/feedbacks/:id', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ success: false, error: '権限がありません' });
        }

        const { id } = req.params;

        await mainDb.run('DELETE FROM feedbacks WHERE id = ?', [id]);

        res.json({ success: true, message: 'ご意見を削除しました' });
    } catch (error) {
        console.error('Delete feedback error:', error);
        res.status(500).json({ success: false, error: 'ご意見の削除に失敗しました' });
    }
});

module.exports = router;
