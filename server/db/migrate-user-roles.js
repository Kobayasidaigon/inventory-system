const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

/**
 * 既存のデータベースにroleカラムとorder_requestsテーブルの変更を適用するマイグレーションスクリプト
 *
 * 実行方法:
 * node server/db/migrate-user-roles.js
 */

const DB_DIR = process.env.DB_DIR || path.join(__dirname);
const dbPath = path.join(DB_DIR, 'inventory.db');

console.log('データベースマイグレーションを開始します...');
console.log('DB Path:', dbPath);

if (!fs.existsSync(dbPath)) {
    console.error('データベースファイルが見つかりません:', dbPath);
    process.exit(1);
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 1. usersテーブルにroleカラムを追加
    db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user'))`, (err) => {
        if (err) {
            if (err.message.includes('duplicate column name')) {
                console.log('✓ usersテーブルにはすでにroleカラムが存在します');
            } else {
                console.error('✗ usersテーブルへのroleカラム追加エラー:', err.message);
            }
        } else {
            console.log('✓ usersテーブルにroleカラムを追加しました');
        }
    });

    // 2. 既存のadminユーザーにadminロールを付与
    db.run(`UPDATE users SET role = 'admin' WHERE username = 'admin'`, (err) => {
        if (err) {
            console.error('✗ adminユーザーのロール更新エラー:', err.message);
        } else {
            console.log('✓ adminユーザーにadminロールを付与しました');
        }
    });

    // 3. order_requestsテーブルの構造を確認
    db.all(`PRAGMA table_info(order_requests)`, (err, columns) => {
        if (err) {
            console.error('✗ order_requestsテーブル情報取得エラー:', err.message);
            return;
        }

        const columnNames = columns.map(col => col.name);
        const needsMigration = !columnNames.includes('requested_by') ||
                              !columnNames.includes('approved_quantity');

        if (needsMigration) {
            console.log('order_requestsテーブルを再構築します...');

            // 既存データをバックアップ
            db.run(`CREATE TABLE IF NOT EXISTS order_requests_backup AS SELECT * FROM order_requests`, (err) => {
                if (err) {
                    console.error('✗ バックアップテーブル作成エラー:', err.message);
                    return;
                }
                console.log('✓ 既存データをバックアップしました');

                // 既存テーブルを削除
                db.run(`DROP TABLE order_requests`, (err) => {
                    if (err) {
                        console.error('✗ テーブル削除エラー:', err.message);
                        return;
                    }

                    // 新しい構造でテーブルを作成
                    db.run(`CREATE TABLE order_requests (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        product_id INTEGER NOT NULL,
                        requested_quantity INTEGER NOT NULL,
                        requested_by TEXT,
                        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
                        approved_quantity INTEGER,
                        approved_by TEXT,
                        approved_at DATETIME,
                        note TEXT,
                        user_id INTEGER NOT NULL,
                        FOREIGN KEY (product_id) REFERENCES products(id),
                        FOREIGN KEY (user_id) REFERENCES users(id)
                    )`, (err) => {
                        if (err) {
                            console.error('✗ 新しいorder_requestsテーブル作成エラー:', err.message);
                            return;
                        }
                        console.log('✓ 新しいorder_requestsテーブルを作成しました');

                        // 既存データを移行
                        db.run(`INSERT INTO order_requests (id, product_id, requested_quantity, user_id, requested_at, status, note)
                                SELECT id, product_id, requested_quantity, user_id, requested_at,
                                       CASE WHEN status = 'ordered' THEN 'approved' ELSE status END,
                                       note
                                FROM order_requests_backup`, (err) => {
                            if (err) {
                                console.error('✗ データ移行エラー:', err.message);
                            } else {
                                console.log('✓ 既存データを移行しました');
                                console.log('✓ バックアップテーブル(order_requests_backup)は手動で削除してください');
                            }

                            db.close(() => {
                                console.log('\nマイグレーション完了！');
                            });
                        });
                    });
                });
            });
        } else {
            console.log('✓ order_requestsテーブルは最新の構造です');
            db.close(() => {
                console.log('\nマイグレーション完了！');
            });
        }
    });
});
