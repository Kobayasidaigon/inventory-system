const { getUserDatabase } = require('../db/database-multi-tenant');

// ユーザーのデータベースをリクエストに追加するミドルウェア
function attachUserDatabase(req, res, next) {
    if (req.session && req.session.username) {
        req.userDb = getUserDatabase(req.session.username);
    }
    next();
}

module.exports = { attachUserDatabase };
