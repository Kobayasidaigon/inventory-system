const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'inventory.db');
const db = new sqlite3.Database(dbPath);

console.log('データベースマイグレーションを開始します...');

db.serialize(() => {
    // inventory_historyテーブルにdateカラムを追加
    db.run(`ALTER TABLE inventory_history ADD COLUMN date DATE`, (err) => {
        if (err) {
            if (err.message.includes('duplicate column name')) {
                console.log('✓ dateカラムは既に存在します');
            } else {
                console.error('❌ dateカラムの追加に失敗:', err.message);
            }
        } else {
            console.log('✓ inventory_historyテーブルにdateカラムを追加しました');
        }
    });

    // order_requestsテーブルを作成（存在しない場合）
    db.run(`CREATE TABLE IF NOT EXISTS order_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        requested_quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ordered', 'received', 'cancelled')),
        user_id INTEGER NOT NULL,
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`, (err) => {
        if (err) {
            console.error('❌ order_requestsテーブルの作成に失敗:', err.message);
        } else {
            console.log('✓ order_requestsテーブルを作成しました');
        }
    });

    console.log('\nマイグレーション完了！サーバーを再起動してください。');
    db.close();
});
