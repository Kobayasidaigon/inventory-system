function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    if (req.session.userRole !== 'admin') {
        return res.status(403).json({ error: '管理者権限が必要です' });
    }
    next();
}

module.exports = { requireAuth, requireAdmin };