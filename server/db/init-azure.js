const bcrypt = require('bcryptjs');
const db = require('./database-azure');

async function initDatabase() {
    try {
        // デフォルトユーザーを作成
        const defaultUser = 'admin';
        const defaultPassword = bcrypt.hashSync('admin123', 10);

        const existingUser = await db.get(
            "SELECT * FROM users WHERE username = @param0",
            [defaultUser]
        );

        if (!existingUser) {
            await db.run(
                "INSERT INTO users (username, password) VALUES (@param0, @param1)",
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
