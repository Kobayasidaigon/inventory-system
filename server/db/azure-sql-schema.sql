-- Azure SQL Database用スキーマ定義

-- ユーザーテーブル
CREATE TABLE users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    username NVARCHAR(255) UNIQUE NOT NULL,
    password NVARCHAR(255) NOT NULL,
    created_at DATETIME2 DEFAULT GETDATE()
);

-- 商品マスターテーブル
CREATE TABLE products (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    category NVARCHAR(100),
    reorder_point INT DEFAULT 0,
    current_stock INT DEFAULT 0,
    image_url NVARCHAR(500),
    created_at DATETIME2 DEFAULT GETDATE(),
    updated_at DATETIME2 DEFAULT GETDATE()
);

-- 在庫履歴テーブル
CREATE TABLE inventory_history (
    id INT IDENTITY(1,1) PRIMARY KEY,
    product_id INT NOT NULL,
    type NVARCHAR(10) NOT NULL CHECK(type IN ('in', 'out', 'adjust')),
    quantity INT NOT NULL,
    date DATE,
    note NVARCHAR(500),
    user_id INT NOT NULL,
    created_at DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 週次入力記録テーブル
CREATE TABLE weekly_entries (
    id INT IDENTITY(1,1) PRIMARY KEY,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    user_id INT NOT NULL,
    created_at DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 発注依頼テーブル
CREATE TABLE order_requests (
    id INT IDENTITY(1,1) PRIMARY KEY,
    product_id INT NOT NULL,
    requested_quantity INT NOT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ordered', 'received', 'cancelled')),
    user_id INT NOT NULL,
    requested_at DATETIME2 DEFAULT GETDATE(),
    note NVARCHAR(500),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- インデックスの作成（パフォーマンス向上用）
CREATE INDEX idx_inventory_history_product_id ON inventory_history(product_id);
CREATE INDEX idx_inventory_history_date ON inventory_history(date);
CREATE INDEX idx_order_requests_status ON order_requests(status);
CREATE INDEX idx_weekly_entries_dates ON weekly_entries(week_start, week_end);
