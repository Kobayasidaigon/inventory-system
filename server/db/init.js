const bcrypt = require('bcryptjs');
const db = require('./database');

async function initDatabase() {
    try {
        // デフォルトユーザーを作成
        const defaultUser = 'admin';
        const defaultPassword = bcrypt.hashSync('admin123', 10);

        const row = await db.get("SELECT * FROM users WHERE username = ?", [defaultUser]);

        if (!row) {
            await db.run("INSERT INTO users (username, password) VALUES (?, ?)",
                [defaultUser, defaultPassword]
            );
            console.log('Default user created: admin / admin123');
        } else {
            console.log('Database initialized');
        }
    } catch (err) {
        console.error('Error initializing database:', err);
        throw err;
    }
}

module.exports = initDatabase;