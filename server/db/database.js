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
        role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
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
    )`);
});

module.exports = db;