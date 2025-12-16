const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'inventory.db');
const db = new sqlite3.Database(dbPath);

// 元のメソッドを保存
const originalGet = db.get.bind(db);
const originalAll = db.all.bind(db);
const originalRun = db.run.bind(db);

// Promiseベースのメソッドを定義
db.get = function(query, params = []) {
    return new Promise((resolve, reject) => {
        originalGet(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

db.all = function(query, params = []) {
    return new Promise((resolve, reject) => {
        originalAll(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

db.run = function(query, params = []) {
    return new Promise((resolve, reject) => {
        originalRun(query, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
};

// テーブル作成（元のメソッドを使用）
db.serialize(() => {
    // ユーザーテーブル
    originalRun(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 商品マスターテーブル
    originalRun(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        reorder_point INTEGER DEFAULT 0,
        current_stock INTEGER DEFAULT 0,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 在庫履歴テーブル（日付フィールドを追加）
    originalRun(`CREATE TABLE IF NOT EXISTS inventory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('in', 'out', 'adjust')),
        quantity INTEGER NOT NULL,
        date DATE,
        note TEXT,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // 週次入力記録テーブル
    originalRun(`CREATE TABLE IF NOT EXISTS weekly_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start DATE NOT NULL,
        week_end DATE NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // 発注依頼テーブル
    originalRun(`CREATE TABLE IF NOT EXISTS order_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        requested_quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ordered', 'received', 'cancelled')),
        user_id INTEGER NOT NULL,
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // 棚卸テーブル
    originalRun(`CREATE TABLE IF NOT EXISTS inventory_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'approved')),
        user_id INTEGER NOT NULL,
        approved_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        approved_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (approved_by) REFERENCES users(id)
    )`);

    // 棚卸明細テーブル
    originalRun(`CREATE TABLE IF NOT EXISTS inventory_count_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        system_quantity INTEGER NOT NULL,
        actual_quantity INTEGER,
        difference INTEGER,
        reason TEXT,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (count_id) REFERENCES inventory_counts(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
    )`);
});

module.exports = db;