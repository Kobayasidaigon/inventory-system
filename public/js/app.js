// グローバル変数
let currentUser = null;
let currentUserRole = 'user'; // 'admin' or 'user'
let products = [];
let chartInstance = null;
let productsSortColumn = 'category';
let productsSortDirection = 'asc';
let productsFilteredData = [];
let pendingOrders = []; // 発注依頼済み商品のリスト

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadProducts();
    setupEventListeners();

    // ロールに応じた初期ページを表示
    if (currentUserRole === 'user') {
        showPage('stock-view');
    } else {
        showPage('dashboard');
    }
});

// 認証チェック
async function checkAuth() {
    try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();

        if (!data.loggedIn) {
            window.location.href = '/';
            return;
        }

        currentUser = data.username;
        currentUserRole = data.role || 'user';

        document.getElementById('username-display').textContent = `ログイン中: ${currentUser}`;

        // ロールに応じてUIを調整
        setupUIForRole();
    } catch (error) {
        console.error('認証チェックエラー:', error);
        window.location.href = '/';
    }
}

// ロールに応じたUI設定
function setupUIForRole() {
    const nav = document.querySelector('.nav');
    nav.innerHTML = ''; // ナビゲーションをクリア

    if (currentUserRole === 'user') {
        // 一般ユーザー: 現在庫・出庫・入庫・発注希望のみ
        nav.innerHTML = `
            <button class="nav-btn active" data-page="stock-view">現在庫</button>
            <button class="nav-btn" data-page="out-stock">出庫</button>
            <button class="nav-btn" data-page="in-stock">入庫</button>
            <button class="nav-btn" data-page="order-request">発注希望</button>
        `;
    } else if (currentUserRole === 'admin') {
        // 管理者: すべての機能
        nav.innerHTML = `
            <button class="nav-btn active" data-page="dashboard">ダッシュボード</button>
            <button class="nav-btn" data-page="order-management">発注管理</button>
            <button class="nav-btn" data-page="products">商品管理</button>
            <button class="nav-btn" data-page="stock-chart">在庫推移</button>
            <button class="nav-btn" data-page="history">履歴確認</button>
            <button class="nav-btn" data-page="out-stock">出庫</button>
            <button class="nav-btn" data-page="in-stock">入庫</button>
            <button class="nav-btn" data-page="weekly-input">週次入力</button>
        `;
    }

    // イベントリスナーを再設定
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const page = btn.dataset.page;
            await showPage(page);

            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}

// ログアウト
document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        console.error('ログアウトエラー:', error);
    }
});

// ページ切り替え
function setupEventListeners() {
    // ナビゲーションボタン
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const page = btn.dataset.page;
            await showPage(page);

            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // モーダル閉じる
    document.querySelector('.close').addEventListener('click', closeModal);

    // 各種ボタンのイベント
    document.getElementById('add-product-btn').addEventListener('click', showAddProductForm);
    document.getElementById('export-current').addEventListener('click', exportCurrentStock);
    document.getElementById('export-history').addEventListener('click', exportHistory);
    document.getElementById('refresh-history').addEventListener('click', loadHistory);
    document.getElementById('load-chart-btn').addEventListener('click', loadStockChart);

    // カテゴリフィルター変更イベント
    document.getElementById('out-category-filter').addEventListener('change', loadOutStockProducts);
    document.getElementById('in-category-filter').addEventListener('change', loadInStockProducts);
    document.getElementById('chart-category-filter').addEventListener('change', onChartCategoryChange);
    document.getElementById('history-category-filter').addEventListener('change', onHistoryCategoryChange);

    // 商品選択時の画像表示
    document.getElementById('out-product').addEventListener('change', showOutStockProductImage);
    document.getElementById('in-product').addEventListener('change', showInStockProductImage);

    // フォーム送信
    document.getElementById('out-stock-form').addEventListener('submit', submitOutStock);
    document.getElementById('in-stock-form').addEventListener('submit', submitInStock);
}

// ページ表示
async function showPage(pageName) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageName).classList.add('active');

    // ページごとの初期化
    switch(pageName) {
        case 'dashboard':
            await showDashboard();
            break;
        case 'products':
            await showProducts();
            break;
        case 'stock-view':
            await loadProducts();
            loadStockViewCategoryFilter();
            await showStockView();
            break;
        case 'order-request':
            await loadProducts();
            await showOrderRequest();
            break;
        case 'order-management':
            await loadProducts();
            await showOrderManagement();
            break;
        case 'out-stock':
            await loadProducts();
            setDefaultOutDate();
            loadOutStockCategoryFilter();
            loadOutStockProducts();
            loadTodayOutHistory();
            break;
        case 'weekly-input':
            await loadProducts();
            setDefaultOutDate();
            loadOutStockCategoryFilter();
            loadOutStockProducts();
            break;
        case 'in-stock':
            await loadProducts();
            setDefaultInDate();
            loadInStockCategoryFilter();
            loadInStockProducts();
            break;
        case 'history':
            await loadProducts();
            loadHistoryCategoryFilter();
            loadHistoryProductFilter();
            loadHistory();
            break;
        case 'stock-chart':
        case 'chart':
            await loadProducts();
            loadChartCategoryFilter();
            loadChartProductList();
            break;
    }
}

// ダッシュボード表示
async function showDashboard() {
    await loadProducts();
    await loadPendingOrders();
    loadDashboardCategoryFilter();

    // カテゴリフィルターのイベントリスナーを設定（重複を避けるため一度削除）
    const categoryFilter = document.getElementById('dashboard-category-filter');
    const newFilter = categoryFilter.cloneNode(true);
    categoryFilter.parentNode.replaceChild(newFilter, categoryFilter);
    newFilter.addEventListener('change', updateDashboardDisplay);

    updateDashboardDisplay();
}

// ダッシュボード用カテゴリフィルター読み込み
function loadDashboardCategoryFilter() {
    const categoryFilter = document.getElementById('dashboard-category-filter');
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];

    const currentValue = categoryFilter.value;
    categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>';
    categories.forEach(category => {
        categoryFilter.innerHTML += `<option value="${category}">${category}</option>`;
    });
    categoryFilter.value = currentValue;
}

// ダッシュボード表示更新
function updateDashboardDisplay() {
    const selectedCategory = document.getElementById('dashboard-category-filter').value;
    const filteredProducts = selectedCategory
        ? products.filter(p => p.category === selectedCategory)
        : products;

    const tbody = document.querySelector('#stock-table tbody');
    const alerts = document.getElementById('stock-alerts');
    const stockCount = document.getElementById('stock-count');
    tbody.innerHTML = '';
    alerts.innerHTML = '';

    let lowStockItems = [];

    filteredProducts.forEach(product => {
        const row = tbody.insertRow();
        const isLow = product.current_stock <= product.reorder_point;

        // この商品が発注依頼済みかチェック
        const isPending = pendingOrders.some(order => order.product_id === product.id);

        if (isLow && !isPending) {
            lowStockItems.push(product.name);
        }

        // 状態の判定
        let statusText = '正常';
        let statusClass = 'stock-ok';
        let actionButton = '-';

        if (isPending) {
            statusText = '発注済';
            statusClass = 'stock-pending';
            actionButton = '-';
        } else if (isLow) {
            statusText = '要発注';
            statusClass = 'stock-low';
            actionButton = `<button class="btn btn-secondary" onclick="showOrderDialog(${product.id})">発注依頼</button>`;
        }

        row.innerHTML = `
            <td>${product.name}</td>
            <td>${product.category || '-'}</td>
            <td>${product.current_stock}</td>
            <td>${product.reorder_point}</td>
            <td class="${statusClass}">
                ${statusText}
            </td>
            <td>
                ${actionButton}
            </td>
        `;
    });

    // 件数バッジを更新
    stockCount.textContent = `${filteredProducts.length}件`;

    if (lowStockItems.length > 0) {
        alerts.className = 'alert-box warning';
        alerts.innerHTML = `<strong>発注が必要な商品:</strong> ${lowStockItems.join(', ')}`;
    }
}

// 発注依頼済み商品一覧表示
async function loadPendingOrders() {
    try {
        const response = await fetch('/api/orders');
        const orders = await response.json();

        // グローバル変数に保存
        pendingOrders = orders.filter(o => o.status === 'pending');
        const pendingSection = document.getElementById('pending-orders-section');
        const pendingCount = document.getElementById('pending-count');

        if (pendingOrders.length > 0) {
            pendingSection.style.display = 'block';

            const tbody = document.querySelector('#pending-orders-table tbody');
            tbody.innerHTML = '';

            pendingOrders.forEach(order => {
                const row = tbody.insertRow();
                const requestedDate = new Date(order.requested_at).toLocaleString('ja-JP');

                row.innerHTML = `
                    <td>${order.product_name}</td>
                    <td>${order.username}</td>
                    <td>${requestedDate}</td>
                    <td>${order.note || '-'}</td>
                    <td>
                        <button class="btn btn-secondary" onclick="completeOrder(${order.id}, ${order.product_id}, '${order.product_name.replace(/'/g, "\\'")}')">入荷完了</button>
                        <button class="btn btn-secondary" onclick="updateOrderStatus(${order.id}, 'cancelled')">キャンセル</button>
                    </td>
                `;
            });

            // 件数バッジを更新
            pendingCount.textContent = `${pendingOrders.length}件`;
        } else {
            pendingSection.style.display = 'none';
        }
    } catch (error) {
        console.error('発注依頼取得エラー:', error);
    }
}

// 発注依頼ダイアログ表示
async function showOrderDialog(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    // 発注分析を取得
    try {
        const response = await fetch(`/api/orders/analysis/${productId}`);
        const analysis = await response.json();

        let analysisText = '';
        if (analysis.hasData) {
            const reorderPointInfo = analysis.reorderPointUpdated
                ? `<p style="color: #667eea; font-weight: bold;">✓ 発注点が自動更新されました: ${analysis.reorderPoint} → ${analysis.optimizedReorderPoint}個</p>`
                : analysis.optimizedReorderPoint !== analysis.reorderPoint
                    ? `<p>・最適化された発注点: ${analysis.optimizedReorderPoint}個（現在: ${analysis.reorderPoint}個）</p>`
                    : `<p>・現在の発注点: ${analysis.reorderPoint}個（最適値）</p>`;

            analysisText = `
                <div style="background: #f0f0f0; padding: 15px; margin: 10px 0; border-radius: 5px;">
                    <h4>発注分析 (${analysis.analysisPeriod || '過去30日間'}のデータ)</h4>
                    ${reorderPointInfo}
                    <p>・1日平均消費量: ${analysis.avgDailyConsumption}個</p>
                    <p>・在庫切れまで: 約${analysis.daysUntilStockout}日</p>
                    <p>・推奨発注量: ${analysis.recommendedOrderQty}個</p>
                    <p>・消費トレンド: ${analysis.analysisNote}</p>
                    ${analysis.hasWeeklyPattern ? '<p>・曜日別の消費パターンが確認されています</p>' : ''}
                </div>
            `;
        } else if (analysis.message) {
            analysisText = `
                <div style="background: #fff3cd; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #ffc107;">
                    <p style="margin: 0; color: #856404;">
                        <strong>📊 分析情報:</strong><br>
                        ${analysis.message}
                    </p>
                </div>
            `;
        }

        const modal = document.getElementById('modal');
        const modalBody = document.getElementById('modal-body');

        modalBody.innerHTML = `
            <h3>${product.name} の発注依頼</h3>
            ${analysisText}
            <form id="order-request-form">
                <div class="form-group">
                    <label>現在庫</label>
                    <input type="text" value="${product.current_stock}" readonly>
                </div>
                <div class="form-group">
                    <label>備考</label>
                    <input type="text" id="order-note" placeholder="発注に関する備考（任意）">
                </div>
                <p style="color: #666; font-size: 14px; margin: 10px 0;">
                    ※ 入荷数量は、入荷完了時に入力します
                </p>
                <button type="submit" class="btn btn-primary">発注依頼を送信</button>
            </form>
        `;

        document.getElementById('order-request-form').addEventListener('submit', async (e) => {
            e.preventDefault();

            const data = {
                productId: productId,
                quantity: 0,
                note: document.getElementById('order-note').value
            };

            try {
                const response = await fetch('/api/orders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (response.ok) {
                    closeModal();
                    alert('発注依頼を送信しました');
                    showDashboard();
                }
            } catch (error) {
                alert('発注依頼の送信に失敗しました');
            }
        });

        modal.classList.add('show');
    } catch (error) {
        alert('発注分析の取得に失敗しました');
    }
}

// 発注ステータス更新
// 入荷完了処理（数量入力あり）
async function completeOrder(orderId, productId, productName) {
    const quantity = prompt(`${productName}の入荷数量を入力してください:`);

    if (quantity === null) return; // キャンセル

    const receivedQty = parseInt(quantity);
    if (isNaN(receivedQty) || receivedQty <= 0) {
        alert('正しい数量を入力してください');
        return;
    }

    if (!confirm(`${productName}を${receivedQty}個入荷しますか？`)) return;

    try {
        // 入庫処理
        const inResponse = await fetch('/api/inventory/in', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId: productId,
                quantity: receivedQty,
                note: `発注依頼による入荷`
            })
        });

        if (!inResponse.ok) {
            throw new Error('入庫処理に失敗しました');
        }

        // 発注ステータスを「入荷完了」に更新
        const statusResponse = await fetch(`/api/orders/${orderId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'received' })
        });

        if (statusResponse.ok) {
            alert(`${receivedQty}個入荷しました`);
            showDashboard();
        }
    } catch (error) {
        console.error('Complete order error:', error);
        alert('入荷完了処理に失敗しました');
    }
}

async function updateOrderStatus(orderId, status) {
    if (!confirm('ステータスを更新しますか？')) return;

    try {
        const response = await fetch(`/api/orders/${orderId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });

        if (response.ok) {
            alert('ステータスを更新しました');
            showDashboard();
        }
    } catch (error) {
        alert('ステータス更新に失敗しました');
    }
}

// 商品一覧表示
async function showProducts() {
    await loadProducts();
    loadProductsCategoryFilter();
    setupProductsTableSorting();
    updateProductsDisplay();
}

// 商品マスター用カテゴリフィルター読み込み
function loadProductsCategoryFilter() {
    const categoryFilter = document.getElementById('products-category-filter');
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];

    const currentValue = categoryFilter.value;
    categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>';
    categories.forEach(category => {
        categoryFilter.innerHTML += `<option value="${category}">${category}</option>`;
    });
    categoryFilter.value = currentValue;

    // イベントリスナーを設定（重複を避けるため一度削除）
    const newFilter = categoryFilter.cloneNode(true);
    categoryFilter.parentNode.replaceChild(newFilter, categoryFilter);
    newFilter.addEventListener('change', updateProductsDisplay);
}

// 商品マスターテーブルのソート機能設定
function setupProductsTableSorting() {
    const headers = document.querySelectorAll('#products-table th.sortable');
    headers.forEach(header => {
        // 既存のイベントリスナーを削除するため新しい要素で置き換え
        const newHeader = header.cloneNode(true);
        header.parentNode.replaceChild(newHeader, header);

        newHeader.addEventListener('click', () => {
            const column = newHeader.dataset.sort;
            if (productsSortColumn === column) {
                productsSortDirection = productsSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                productsSortColumn = column;
                productsSortDirection = 'asc';
            }
            updateProductsDisplay();
        });
    });
}

// 商品マスター表示更新
function updateProductsDisplay() {
    const categoryFilter = document.getElementById('products-category-filter');
    const selectedCategory = categoryFilter ? categoryFilter.value : '';

    // カテゴリフィルタリング
    productsFilteredData = selectedCategory
        ? products.filter(p => p.category === selectedCategory)
        : [...products];

    // ソート
    productsFilteredData.sort((a, b) => {
        let aVal = a[productsSortColumn];
        let bVal = b[productsSortColumn];

        // null/undefinedの処理
        if (aVal == null) aVal = '';
        if (bVal == null) bVal = '';

        // 数値の場合は数値として比較
        if (productsSortColumn === 'id' || productsSortColumn === 'reorder_point' || productsSortColumn === 'current_stock') {
            aVal = Number(aVal);
            bVal = Number(bVal);
        } else {
            // 文字列の場合は小文字に変換して比較
            aVal = String(aVal).toLowerCase();
            bVal = String(bVal).toLowerCase();
        }

        if (aVal < bVal) return productsSortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return productsSortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // テーブル表示
    const tbody = document.querySelector('#products-table tbody');
    tbody.innerHTML = '';

    productsFilteredData.forEach(product => {
        const row = tbody.insertRow();
        const imageHtml = product.image_url
            ? `<img src="${product.image_url}" class="product-thumbnail" onclick="showImagePopup('${product.image_url}')" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px; cursor: pointer;">`
            : '<span style="color: #999;">画像なし</span>';

        row.innerHTML = `
            <td>${imageHtml}</td>
            <td>${product.name}</td>
            <td>${product.category || '-'}</td>
            <td>${product.reorder_point}</td>
            <td>${product.current_stock}</td>
            <td>
                <button class="btn btn-secondary" onclick="editProduct(${product.id})">編集</button>
                <button class="btn btn-secondary" onclick="setInitialStock(${product.id})">初期在庫</button>
            </td>
        `;
    });

    // ソート方向の矢印を更新
    updateProductsSortArrows();
}

// ソート方向の矢印を更新
function updateProductsSortArrows() {
    const headers = document.querySelectorAll('#products-table th.sortable');
    headers.forEach(header => {
        const arrow = header.querySelector('.sort-arrow');
        if (header.dataset.sort === productsSortColumn) {
            arrow.textContent = productsSortDirection === 'asc' ? ' ▲' : ' ▼';
        } else {
            arrow.textContent = '';
        }
    });
}

// 商品データ取得
async function loadProducts() {
    try {
        const response = await fetch('/api/products');
        products = await response.json();

        // 履歴フィルター更新
        const filter = document.getElementById('history-filter');
        filter.innerHTML = '<option value="">全商品</option>';
        products.forEach(p => {
            filter.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        });
    } catch (error) {
        console.error('商品データ取得エラー:', error);
    }
}

// 商品追加フォーム表示
function showAddProductForm() {
    const modal = document.getElementById('modal');
    const modalBody = document.getElementById('modal-body');

    modalBody.innerHTML = `
        <h3>新規商品登録</h3>
        <form id="product-form" enctype="multipart/form-data">
            <div class="form-group">
                <label>商品名</label>
                <input type="text" id="product-name" required>
            </div>
            <div class="form-group">
                <label>カテゴリ</label>
                <input type="text" id="product-category">
            </div>
            <div class="form-group">
                <label>商品画像</label>
                <input type="file" id="product-image" accept="image/*">
                <div id="image-preview" style="margin-top: 10px;"></div>
            </div>
            <div class="form-group">
                <label>発注点</label>
                <input type="number" id="product-reorder" min="0" value="0">
            </div>
            <div class="form-group">
                <label>初期在庫</label>
                <input type="number" id="product-initial" min="0" value="0">
            </div>
            <button type="submit" class="btn btn-primary">登録</button>
        </form>
    `;

    // 画像プレビュー
    document.getElementById('product-image').addEventListener('change', (e) => {
        const file = e.target.files[0];
        const preview = document.getElementById('image-preview');

        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                preview.innerHTML = `<img src="${e.target.result}" style="max-width: 200px; max-height: 200px; border-radius: 5px;">`;
            };
            reader.readAsDataURL(file);
        } else {
            preview.innerHTML = '';
        }
    });

    document.getElementById('product-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData();
        formData.append('name', document.getElementById('product-name').value);
        formData.append('category', document.getElementById('product-category').value);
        formData.append('reorder_point', parseInt(document.getElementById('product-reorder').value));
        formData.append('current_stock', parseInt(document.getElementById('product-initial').value));

        const imageFile = document.getElementById('product-image').files[0];
        if (imageFile) {
            formData.append('image', imageFile);
        }

        try {
            const response = await fetch('/api/products', {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                closeModal();
                await loadProducts();
                updateProductsDisplay();
                alert('商品を登録しました');
            } else {
                const errorData = await response.json();
                alert('登録に失敗しました: ' + (errorData.error || response.statusText));
            }
        } catch (error) {
            console.error('登録エラー:', error);
            alert('登録に失敗しました: ' + error.message);
        }
    });

    modal.classList.add('show');
}

// 商品編集
async function editProduct(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const modal = document.getElementById('modal');
    const modalBody = document.getElementById('modal-body');

    const currentImageHtml = product.image_url
        ? `<div style="margin-bottom: 10px;"><img src="${product.image_url}" style="max-width: 150px; max-height: 150px; border-radius: 5px;"></div>`
        : '';

    modalBody.innerHTML = `
        <h3>商品編集</h3>
        <form id="edit-product-form" enctype="multipart/form-data">
            <div class="form-group">
                <label>商品名</label>
                <input type="text" id="edit-name" value="${product.name}" required>
            </div>
            <div class="form-group">
                <label>カテゴリ</label>
                <input type="text" id="edit-category" value="${product.category || ''}">
            </div>
            <div class="form-group">
                <label>商品画像</label>
                ${currentImageHtml}
                <input type="file" id="edit-image" accept="image/*">
                <div id="edit-image-preview" style="margin-top: 10px;"></div>
            </div>
            <div class="form-group">
                <label>発注点</label>
                <input type="number" id="edit-reorder" min="0" value="${product.reorder_point}">
            </div>
            <button type="submit" class="btn btn-primary">更新</button>
        </form>
    `;

    // 画像プレビュー
    document.getElementById('edit-image').addEventListener('change', (e) => {
        const file = e.target.files[0];
        const preview = document.getElementById('edit-image-preview');

        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                preview.innerHTML = `<img src="${e.target.result}" style="max-width: 200px; max-height: 200px; border-radius: 5px;">`;
            };
            reader.readAsDataURL(file);
        } else {
            preview.innerHTML = '';
        }
    });

    document.getElementById('edit-product-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData();
        formData.append('name', document.getElementById('edit-name').value);
        formData.append('category', document.getElementById('edit-category').value);
        formData.append('reorder_point', parseInt(document.getElementById('edit-reorder').value));

        const imageFile = document.getElementById('edit-image').files[0];
        if (imageFile) {
            formData.append('image', imageFile);
        }

        try {
            const response = await fetch(`/api/products/${productId}`, {
                method: 'PUT',
                body: formData
            });

            if (response.ok) {
                closeModal();
                await loadProducts();
                updateProductsDisplay();
                alert('商品を更新しました');
            } else {
                const errorData = await response.json();
                alert('更新に失敗しました: ' + (errorData.error || response.statusText));
            }
        } catch (error) {
            console.error('更新エラー:', error);
            alert('更新に失敗しました: ' + error.message);
        }
    });

    modal.classList.add('show');
}

// 初期在庫設定
async function setInitialStock(productId) {
    const product = products.find(p => p.id === productId);
    const stock = prompt(`${product.name}の初期在庫数を入力してください:`, product.current_stock);

    if (stock === null) return;

    try {
        const response = await fetch('/api/products/initialize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId: productId,
                initialStock: parseInt(stock)
            })
        });

        if (response.ok) {
            await loadProducts();
            updateProductsDisplay();
            alert('初期在庫を設定しました');
        }
    } catch (error) {
        alert('設定に失敗しました');
    }
}

// YYYY-MM-DD形式に変換
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 1週間前の期間を自動設定
function setDefaultWeekRange() {
    const today = new Date();
    const oneWeekAgo = new Date(today);
    oneWeekAgo.setDate(today.getDate() - 7);

    document.getElementById('week-start').value = formatDate(oneWeekAgo);
    document.getElementById('week-end').value = formatDate(today);
}

// 開始日変更時のイベント（終了日を7日後に自動設定）
function onWeekStartChange(e) {
    const startDate = new Date(e.target.value);
    if (!isNaN(startDate.getTime())) {
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6); // 7日間（開始日含む）
        document.getElementById('week-end').value = formatDate(endDate);
    }
}

// 終了日変更時のイベント（開始日を7日前に自動設定）
function onWeekEndChange(e) {
    const endDate = new Date(e.target.value);
    if (!isNaN(endDate.getTime())) {
        const startDate = new Date(endDate);
        startDate.setDate(endDate.getDate() - 6); // 7日間（終了日含む）
        document.getElementById('week-start').value = formatDate(startDate);
    }
}

// 週次入力用カテゴリフィルター読み込み
function loadWeeklyCategoryFilter() {
    const categoryFilter = document.getElementById('weekly-category-filter');
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];

    categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>';
    categories.forEach(category => {
        categoryFilter.innerHTML += `<option value="${category}">${category}</option>`;
    });
}

// 週次商品一覧読み込み（日付別対応、カテゴリフィルター対応）
function loadWeeklyProducts() {
    const weekStart = document.getElementById('week-start').value;
    const weekEnd = document.getElementById('week-end').value;

    if (!weekStart || !weekEnd) {
        alert('期間を指定してください');
        return;
    }

    const startDate = new Date(weekStart);
    const endDate = new Date(weekEnd);

    if (startDate > endDate) {
        alert('期間の指定が正しくありません');
        return;
    }

    // カテゴリフィルターで商品を絞り込み
    const selectedCategory = document.getElementById('weekly-category-filter').value;
    const filteredProducts = selectedCategory
        ? products.filter(p => p.category === selectedCategory)
        : products;

    if (filteredProducts.length === 0) {
        alert('該当する商品がありません');
        return;
    }

    // 日付タブを生成
    const dateTabs = document.getElementById('date-tabs');
    const tablesContainer = document.getElementById('daily-tables-container');
    dateTabs.innerHTML = '';
    tablesContainer.innerHTML = '';

    const dates = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        dates.push(new Date(d));
    }

    dates.forEach((date, index) => {
        const dateStr = date.toISOString().split('T')[0];
        const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
        const displayDate = `${date.getMonth() + 1}/${date.getDate()}(${dayOfWeek})`;

        // タブを作成
        const tab = document.createElement('div');
        tab.className = 'date-tab' + (index === 0 ? ' active' : '');
        tab.textContent = displayDate;
        tab.dataset.date = dateStr;
        tab.onclick = () => switchDateTab(dateStr);
        dateTabs.appendChild(tab);

        // 日付ごとのテーブルコンテナを作成
        const dailyContent = document.createElement('div');
        dailyContent.className = 'daily-content' + (index === 0 ? ' active' : '');
        dailyContent.id = `content-${dateStr}`;
        dailyContent.innerHTML = `
            <h3>${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 (${dayOfWeek})</h3>
            <table class="daily-table">
                <thead>
                    <tr>
                        <th>画像</th>
                        <th>商品名</th>
                        <th>カテゴリ</th>
                        <th>現在庫</th>
                        <th>出庫数</th>
                    </tr>
                </thead>
                <tbody>
                    ${filteredProducts.map(product => `
                        <tr>
                            <td>
                                ${product.image_url
                                    ? `<img src="${product.image_url}"
                                           alt="${product.name}"
                                           class="product-thumbnail weekly-thumbnail"
                                           style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px; cursor: pointer;"
                                           onclick="openImagePopup('${product.image_url}')">`
                                    : '<span style="color: #999;">画像なし</span>'}
                            </td>
                            <td>${product.name}</td>
                            <td>${product.category || '-'}</td>
                            <td>${product.current_stock}</td>
                            <td>
                                <input type="number"
                                       name="quantity_${dateStr}_${product.id}"
                                       min="0"
                                       value="0"
                                       data-date="${dateStr}"
                                       data-product-id="${product.id}">
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        tablesContainer.appendChild(dailyContent);
    });

    document.getElementById('daily-input-container').style.display = 'block';
}

// 日付タブ切り替え
function switchDateTab(dateStr) {
    // タブのアクティブ状態を切り替え
    document.querySelectorAll('.date-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.date === dateStr);
    });

    // コンテンツの表示を切り替え
    document.querySelectorAll('.daily-content').forEach(content => {
        content.classList.toggle('active', content.id === `content-${dateStr}`);
    });
}

// 週次入力送信（日付別対応）
async function submitWeeklyInput(e) {
    e.preventDefault();

    const weekStart = document.getElementById('week-start').value;
    const weekEnd = document.getElementById('week-end').value;

    if (!weekStart || !weekEnd) {
        alert('期間を入力してください');
        return;
    }

    // 日付ごとのデータを収集
    const dailyItems = {};
    document.querySelectorAll('.daily-table input[type="number"]').forEach(input => {
        const quantity = parseInt(input.value);
        if (quantity > 0) {
            const date = input.dataset.date;
            const productId = parseInt(input.dataset.productId);

            if (!dailyItems[date]) {
                dailyItems[date] = [];
            }

            dailyItems[date].push({
                productId: productId,
                quantity: quantity
            });
        }
    });

    if (Object.keys(dailyItems).length === 0) {
        alert('出庫数を入力してください');
        return;
    }

    try {
        const response = await fetch('/api/inventory/weekly', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                weekStart: weekStart,
                weekEnd: weekEnd,
                dailyItems: dailyItems
            })
        });

        if (response.ok) {
            alert('週次入力を登録しました');
            await loadProducts();
        }
    } catch (error) {
        alert('登録に失敗しました');
    }
}

// 入庫用カテゴリフィルター読み込み
function loadInStockCategoryFilter() {
    const categoryFilter = document.getElementById('in-category-filter');
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];

    categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>';
    categories.forEach(category => {
        categoryFilter.innerHTML += `<option value="${category}">${category}</option>`;
    });
}

// 入庫商品選択肢読み込み（カテゴリフィルター対応）
function loadInStockProducts() {
    const select = document.getElementById('in-product');
    const selectedCategory = document.getElementById('in-category-filter').value;

    // カテゴリフィルターで商品を絞り込み
    const filteredProducts = selectedCategory
        ? products.filter(p => p.category === selectedCategory)
        : products;

    select.innerHTML = '<option value="">商品を選択してください</option>';

    if (filteredProducts.length === 0) {
        select.innerHTML += '<option value="">該当する商品がありません</option>';
        return;
    }

    filteredProducts.forEach(product => {
        select.innerHTML += `<option value="${product.id}">${product.name}${product.category ? ` (${product.category})` : ''}</option>`;
    });

    // 画像コンテナを非表示にする
    document.getElementById('in-product-image-container').style.display = 'none';
}

// 入庫商品選択時に画像を表示
function showInStockProductImage() {
    const productId = document.getElementById('in-product').value;
    const imageContainer = document.getElementById('in-product-image-container');
    const imageElement = document.getElementById('in-product-image');

    if (!productId) {
        imageContainer.style.display = 'none';
        return;
    }

    const product = products.find(p => p.id === parseInt(productId));

    if (product && product.image_url) {
        imageElement.src = product.image_url;
        imageElement.alt = product.name;
        imageContainer.style.display = 'block';
    } else {
        imageContainer.style.display = 'none';
    }
}

// 入庫処理送信
async function submitInStock(e) {
    e.preventDefault();

    const data = {
        productId: parseInt(document.getElementById('in-product').value),
        quantity: parseInt(document.getElementById('in-quantity').value),
        note: document.getElementById('in-note').value
    };

    try {
        const response = await fetch('/api/inventory/in', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.ok) {
            alert('入庫を登録しました');
            document.getElementById('in-stock-form').reset();
            await loadProducts();
        }
    } catch (error) {
        alert('登録に失敗しました');
    }
}

// 出庫日のデフォルト設定（今日の日付）
function setDefaultOutDate() {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    document.getElementById('out-date').value = dateStr;
}

// 出庫用カテゴリフィルター読み込み
function loadOutStockCategoryFilter() {
    const categoryFilter = document.getElementById('out-category-filter');
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];

    categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>';
    categories.forEach(category => {
        categoryFilter.innerHTML += `<option value="${category}">${category}</option>`;
    });
}

// 出庫商品選択肢読み込み（カテゴリフィルター対応）
function loadOutStockProducts() {
    const select = document.getElementById('out-product');
    const selectedCategory = document.getElementById('out-category-filter').value;

    // カテゴリフィルターで商品を絞り込み
    const filteredProducts = selectedCategory
        ? products.filter(p => p.category === selectedCategory)
        : products;

    select.innerHTML = '<option value="">商品を選択してください</option>';

    if (filteredProducts.length === 0) {
        select.innerHTML += '<option value="">該当する商品がありません</option>';
        return;
    }

    filteredProducts.forEach(product => {
        select.innerHTML += `<option value="${product.id}">${product.name}${product.category ? ` (${product.category})` : ''}</option>`;
    });

    // 画像コンテナを非表示にする
    document.getElementById('out-product-image-container').style.display = 'none';
}

// 出庫商品選択時に画像を表示
function showOutStockProductImage() {
    const productId = document.getElementById('out-product').value;
    const imageContainer = document.getElementById('out-product-image-container');
    const imageElement = document.getElementById('out-product-image');

    if (!productId) {
        imageContainer.style.display = 'none';
        return;
    }

    const product = products.find(p => p.id === parseInt(productId));

    if (product && product.image_url) {
        imageElement.src = product.image_url;
        imageElement.alt = product.name;
        imageContainer.style.display = 'block';
    } else {
        imageContainer.style.display = 'none';
    }
}

// 出庫処理送信
async function submitOutStock(e) {
    e.preventDefault();

    const outDate = document.getElementById('out-date').value;
    const data = {
        productId: parseInt(document.getElementById('out-product').value),
        quantity: parseInt(document.getElementById('out-quantity').value),
        date: outDate,
        note: document.getElementById('out-note').value
    };

    try {
        const response = await fetch('/api/inventory/out', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.ok) {
            alert('出庫を登録しました');
            document.getElementById('out-stock-form').reset();
            setDefaultOutDate(); // 日付を再設定
            await loadProducts();
        }
    } catch (error) {
        alert('登録に失敗しました');
    }
}

// 履歴用カテゴリフィルター読み込み
function loadHistoryCategoryFilter() {
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];
    const select = document.getElementById('history-category-filter');
    select.innerHTML = '<option value="">全カテゴリ</option>';

    categories.forEach(category => {
        select.innerHTML += `<option value="${category}">${category}</option>`;
    });
}

// 履歴用商品フィルター読み込み
function loadHistoryProductFilter(categoryFilter = '') {
    const select = document.getElementById('history-filter');
    select.innerHTML = '<option value="">全商品</option>';

    const filteredProducts = categoryFilter
        ? products.filter(p => p.category === categoryFilter)
        : products;

    filteredProducts.forEach(product => {
        select.innerHTML += `<option value="${product.id}">${product.name}</option>`;
    });
}

// 履歴のカテゴリフィルター変更
function onHistoryCategoryChange() {
    const category = document.getElementById('history-category-filter').value;
    loadHistoryProductFilter(category);
    // カテゴリ変更時に商品フィルターをリセット
    document.getElementById('history-filter').value = '';
}

// 履歴読み込み（日付表示改善）
async function loadHistory() {
    const productId = document.getElementById('history-filter').value;
    const startDate = document.getElementById('history-start-date').value;
    const endDate = document.getElementById('history-end-date').value;

    let url = '/api/inventory/history?';
    const params = [];

    if (productId) {
        params.push(`productId=${productId}`);
    }

    if (startDate) {
        params.push(`startDate=${startDate}`);
    }

    if (endDate) {
        params.push(`endDate=${endDate}`);
    }

    url += params.join('&');

    try {
        const response = await fetch(url);
        const history = await response.json();

        const tbody = document.querySelector('#history-table tbody');
        tbody.innerHTML = '';

        history.forEach(item => {
            const row = tbody.insertRow();
            const typeText = item.type === 'in' ? '入庫' : item.type === 'out' ? '出庫' : '調整';

            // 取引日付と作成日時を分けて表示
            const transactionDate = item.transaction_date ?
                new Date(item.transaction_date).toLocaleDateString('ja-JP') : '-';
            const createdTime = new Date(item.created_at).toLocaleTimeString('ja-JP');

            row.innerHTML = `
                <td>${transactionDate} ${createdTime}</td>
                <td>${item.product_name}</td>
                <td>${item.category || '-'}</td>
                <td>${typeText}</td>
                <td>${item.quantity}</td>
                <td>${item.note || '-'}</td>
                <td>${item.username}</td>
                <td>
                    <button class="btn btn-secondary" onclick="editHistory(${item.id})">修正</button>
                </td>
            `;
        });
    } catch (error) {
        console.error('履歴取得エラー:', error);
    }
}

// 履歴修正
async function editHistory(historyId) {
    const quantity = prompt('新しい数量を入力してください:');
    if (quantity === null) return;

    const note = prompt('備考を入力してください:');

    try {
        const response = await fetch(`/api/inventory/history/${historyId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quantity: parseInt(quantity),
                note: note || ''
            })
        });

        if (response.ok) {
            alert('履歴を修正しました');
            await loadProducts();
            loadHistory();
        }
    } catch (error) {
        alert('修正に失敗しました');
    }
}

// CSVエクスポート
function exportCurrentStock() {
    window.location.href = '/api/inventory/export?type=current';
}

function exportHistory() {
    window.location.href = '/api/inventory/export?type=history';
}

// モーダル閉じる
function closeModal() {
    document.getElementById('modal').classList.remove('show');
}

// 画像ポップアップ表示
function showImagePopup(imageUrl) {
    const popup = document.getElementById('image-popup');
    const img = document.getElementById('image-popup-img');
    img.src = imageUrl;
    popup.classList.add('show');
}

// 画像ポップアップを閉じる
function closeImagePopup() {
    document.getElementById('image-popup').classList.remove('show');
}

// 画像ポップアップのイベントリスナー設定
document.addEventListener('DOMContentLoaded', () => {
    const popup = document.getElementById('image-popup');
    const closeBtn = popup.querySelector('.image-popup-close');

    // ×ボタンで閉じる
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeImagePopup();
    });

    // 背景クリックで閉じる（画像クリックでも閉じる）
    popup.addEventListener('click', closeImagePopup);
});

// 全入力クリア
function clearAllInputs() {
    if (confirm('すべての入力をクリアしますか？')) {
        document.querySelectorAll('.daily-table input[type="number"]').forEach(input => {
            input.value = '0';
        });
    }
}

// グラフ用カテゴリフィルター読み込み
function loadChartCategoryFilter() {
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];
    const select = document.getElementById('chart-category-filter');
    select.innerHTML = '<option value="">すべてのカテゴリ</option>';

    categories.forEach(category => {
        select.innerHTML += `<option value="${category}">${category}</option>`;
    });
}

// グラフ用商品リスト読み込み
function loadChartProductList(categoryFilter = '') {
    const select = document.getElementById('chart-product-filter');
    select.innerHTML = '<option value="">商品を選択してください</option>';

    const filteredProducts = categoryFilter
        ? products.filter(p => p.category === categoryFilter)
        : products;

    filteredProducts.forEach(product => {
        select.innerHTML += `<option value="${product.id}">${product.name} (${product.category || 'カテゴリなし'})</option>`;
    });
}

// グラフのカテゴリフィルター変更
function onChartCategoryChange() {
    const category = document.getElementById('chart-category-filter').value;
    loadChartProductList(category);
}

// 在庫推移グラフ表示
async function loadStockChart() {
    const productId = document.getElementById('chart-product-filter').value;
    const period = parseInt(document.getElementById('chart-period').value);

    if (!productId) {
        alert('商品を選択してください');
        return;
    }

    try {
        // グラフデータと発注分析を並行取得
        const [chartResponse, analysisResponse] = await Promise.all([
            fetch(`/api/inventory/chart?productId=${productId}&days=${period}`),
            fetch(`/api/orders/analysis/${productId}`)
        ]);

        const data = await chartResponse.json();
        const analysis = await analysisResponse.json();

        // 商品情報を取得
        const product = products.find(p => p.id === parseInt(productId));

        // 既存のチャートがあれば破棄
        if (chartInstance) {
            chartInstance.destroy();
        }

        // データセットを準備
        const datasets = [{
            label: '在庫数',
            data: data.stocks,
            borderColor: '#667eea',
            backgroundColor: 'rgba(102, 126, 234, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            yAxisID: 'y'
        }];

        // 発注点の横線を追加
        if (product && product.reorder_point > 0) {
            datasets.push({
                label: '発注点',
                data: Array(data.labels.length).fill(product.reorder_point),
                borderColor: '#ff6b6b',
                borderWidth: 2,
                borderDash: [5, 5],
                fill: false,
                pointRadius: 0,
                yAxisID: 'y'
            });
        }

        const ctx = document.getElementById('stock-chart').getContext('2d');
        chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: data.productName + ' の在庫推移',
                        font: { size: 16 }
                    },
                    legend: {
                        display: true
                    },
                    subtitle: {
                        display: analysis.hasData,
                        text: analysis.hasData
                            ? `1日平均消費: ${analysis.avgDailyConsumption}個 | 在庫切れまで: 約${analysis.daysUntilStockout}日 | ${analysis.analysisNote}`
                            : '',
                        font: { size: 12 },
                        padding: { bottom: 10 }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });

        // グラフの下に分析情報を表示
        const chartContainer = document.getElementById('chart-container');
        let analysisDiv = document.getElementById('chart-analysis-info');

        if (!analysisDiv) {
            analysisDiv = document.createElement('div');
            analysisDiv.id = 'chart-analysis-info';
            chartContainer.parentElement.appendChild(analysisDiv);
        }

        if (analysis.hasData) {
            analysisDiv.innerHTML = `
                <div style="background: white; padding: 20px; margin-top: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h3>発注分析情報 (${analysis.analysisPeriod || '過去30日間'}のデータ)</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px;">
                        <div>
                            <strong>1日平均消費量:</strong><br>
                            ${analysis.avgDailyConsumption}個
                        </div>
                        <div>
                            <strong>在庫切れまで:</strong><br>
                            約${analysis.daysUntilStockout}日
                        </div>
                        <div>
                            <strong>推奨発注量:</strong><br>
                            ${analysis.recommendedOrderQty}個
                        </div>
                        <div>
                            <strong>消費トレンド:</strong><br>
                            ${analysis.analysisNote}
                        </div>
                    </div>
                    ${analysis.hasWeeklyPattern ? '<p style="margin-top: 15px; color: #667eea;"><strong>※ 曜日別の消費パターンが確認されています</strong></p>' : ''}
                    ${analysis.needsOrder ? `
                        <div style="margin-top: 15px;">
                            <button class="btn btn-primary" onclick="showOrderDialog(${productId})">この商品の発注依頼</button>
                        </div>
                    ` : ''}
                </div>
            `;
        } else {
            analysisDiv.innerHTML = `
                <div style="background: #fff3cd; padding: 20px; margin-top: 20px; border-radius: 8px; border-left: 4px solid #ffc107;">
                    <p style="margin: 0; color: #856404;">
                        <strong>📊 分析情報:</strong><br>
                        ${analysis.message || '分析に十分なデータがありません（最低3日分の出庫データが必要です）'}
                    </p>
                </div>
            `;
        }
    } catch (error) {
        console.error('グラフ取得エラー:', error);
        alert('グラフの読み込みに失敗しました');
    }
}

// 現在庫表示用のカテゴリフィルター読み込み
function loadStockViewCategoryFilter() {
    const categoryFilter = document.getElementById('stock-view-category-filter');
    if (!categoryFilter) return;

    const categories = [...new Set(products.map(p => p.category).filter(c => c))];

    categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>';
    categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        categoryFilter.appendChild(option);
    });
}

// 出庫日付のデフォルト設定（今日）
function setDefaultOutDate() {
    const dateInput = document.getElementById('out-date');
    if (!dateInput) return;

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    dateInput.value = dateStr;
}

// 入庫日付のデフォルト設定（今日）
function setDefaultInDate() {
    const dateInput = document.getElementById('in-date');
    if (!dateInput) return;

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    dateInput.value = dateStr;
}

// 今日の出庫履歴を読み込み
async function loadTodayOutHistory() {
    const today = new Date().toISOString().split('T')[0];

    try {
        const response = await fetch(`/api/inventory/history?startDate=${today}&endDate=${today}`);
        const history = await response.json();

        const outHistory = history.filter(h => h.type === 'out');

        const tbody = document.querySelector('#today-out-table tbody');
        tbody.innerHTML = '';

        if (outHistory.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = '<td colspan="3">今日の出庫記録はありません</td>';
            tbody.appendChild(row);
            return;
        }

        outHistory.forEach(item => {
            const row = document.createElement('tr');

            const nameCell = document.createElement('td');
            nameCell.textContent = item.product_name;
            row.appendChild(nameCell);

            const qtyCell = document.createElement('td');
            qtyCell.textContent = `${item.quantity}個`;
            row.appendChild(qtyCell);

            const timeCell = document.createElement('td');
            const time = new Date(item.created_at).toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit'
            });
            timeCell.textContent = time;
            row.appendChild(timeCell);

            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('今日の出庫履歴取得エラー:', error);
    }
}

// 出庫処理の更新（日付対応）
async function submitOutStock(e) {
    e.preventDefault();

    const productId = document.getElementById('out-product').value;
    const quantity = document.getElementById('out-quantity').value;
    const date = document.getElementById('out-date').value;
    const note = document.getElementById('out-note').value;

    try {
        const response = await fetch('/api/inventory/out', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId: parseInt(productId),
                quantity: parseInt(quantity),
                date,
                note
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('出庫を記録しました');
            document.getElementById('out-stock-form').reset();
            setDefaultOutDate(); // 日付を今日に戻す
            document.getElementById('out-product-image').innerHTML = '';
            document.getElementById('out-product-info').innerHTML = '';
            await loadProducts(); // 商品情報を再読み込み
            await loadTodayOutHistory(); // 今日の出庫履歴を更新
        } else {
            alert('エラー: ' + (data.error || '出庫処理に失敗しました'));
        }
    } catch (error) {
        console.error('出庫処理エラー:', error);
        alert('出庫処理に失敗しました');
    }
}

// 入庫処理の更新（日付対応）
async function submitInStock(e) {
    e.preventDefault();

    const productId = document.getElementById('in-product').value;
    const quantity = document.getElementById('in-quantity').value;
    const date = document.getElementById('in-date').value;
    const note = document.getElementById('in-note').value;

    try {
        const response = await fetch('/api/inventory/in', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId: parseInt(productId),
                quantity: parseInt(quantity),
                date,
                note
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('入庫を記録しました');
            document.getElementById('in-stock-form').reset();
            setDefaultInDate(); // 日付を今日に戻す
            document.getElementById('in-product-image').innerHTML = '';
            document.getElementById('in-product-info').innerHTML = '';
            await loadProducts(); // 商品情報を再読み込み
        } else {
            alert('エラー: ' + (data.error || '入庫処理に失敗しました'));
        }
    } catch (error) {
        console.error('入庫処理エラー:', error);
        alert('入庫処理に失敗しました');
    }
}

// 初期化時に追加のイベントリスナーを設定
if (typeof setupUserPagesEventListeners === 'function') {
    setupUserPagesEventListeners();
}

if (typeof setupAdminPagesEventListeners === 'function') {
    setupAdminPagesEventListeners();
}