// グローバル変数
let currentUser = null;
let products = [];
let chartInstance = null;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadProducts();
    setupEventListeners();

    // URLパラメータをチェックしてページ遷移
    const urlParams = new URLSearchParams(window.location.search);
    const pageParam = urlParams.get('page');

    if (pageParam) {
        // URLパラメータに基づいてページを表示
        await showPage(pageParam);

        // ナビゲーションボタンのアクティブ状態を更新
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === pageParam);
        });

        // URLパラメータをクリア（履歴を汚さないため）
        window.history.replaceState({}, '', window.location.pathname);
    } else {
        showDashboard();
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

        // 管理者の場合は管理画面にリダイレクト
        if (data.isAdmin) {
            window.location.href = '/admin.html';
            return;
        }

        currentUser = data.userName;
        document.getElementById('username-display').textContent = `ログイン中: ${currentUser}`;
    } catch (error) {
        console.error('認証チェックエラー:', error);
        window.location.href = '/';
    }
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
    document.getElementById('show-qrcode-btn').addEventListener('click', showQRCode);

    // カテゴリフィルター変更イベント
    document.getElementById('chart-category-filter').addEventListener('change', onChartCategoryChange);
    document.getElementById('history-category-filter').addEventListener('change', onHistoryCategoryChange);

    // 履歴グループ化トグル
    document.getElementById('group-history-toggle').addEventListener('change', loadHistory);

    // 追加のイベントリスナー
    setupShowMoreOrdersLink();
    setupImagePopup();
    setupTableColumnResize();

    // 棚卸関連のイベント
    document.getElementById('new-count-btn').addEventListener('click', showNewCountForm);
    document.getElementById('new-count-form').addEventListener('submit', handleNewCountSubmit);

    // 棚卸CSV出力ボタン（ページ遷移時に動的に追加されるため、delegationで処理）
    document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'export-count-csv') {
            exportCountCSV();
        }
    });
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
        case 'history':
            await loadProducts();
            loadHistoryCategoryFilter();
            loadHistoryProductFilter();
            loadHistory();
            break;
        case 'chart':
            await loadProducts();
            loadChartCategoryFilter();
            loadChartProductList();
            break;
        case 'inventory-count':
            await loadInventoryCounts();
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

// ダッシュボード表示更新（カード型）
function updateDashboardDisplay() {
    const selectedCategory = document.getElementById('dashboard-category-filter').value;

    let filteredProducts = products;

    // カテゴリでフィルター
    if (selectedCategory) {
        filteredProducts = filteredProducts.filter(p => p.category === selectedCategory);
    }

    const container = document.getElementById('stock-cards-container');
    const stockCount = document.getElementById('stock-count');
    container.innerHTML = '';

    filteredProducts.forEach(product => {
        const isLow = product.current_stock <= product.reorder_point;

        // 画像HTML
        const imageHtml = product.image_url
            ? `<img src="${product.image_url}" class="stock-card-image" onclick="openImagePopup('${product.image_url}')" alt="${product.name}">`
            : `<div class="stock-card-image-placeholder">画像なし</div>`;

        // ステータス
        const statusClass = isLow ? 'status-low' : 'status-ok';
        const statusText = isLow ? '⚠️ 発注依頼済み' : '✓ 正常';

        // カード作成
        const card = document.createElement('div');
        card.className = `stock-card ${isLow ? 'low-stock' : ''}`;
        card.innerHTML = `
            <div class="stock-card-header">
                ${imageHtml}
                <div class="stock-card-name">${product.name}</div>
                ${product.category ? `<span class="stock-card-category">${product.category}</span>` : ''}
            </div>

            <div class="stock-card-stats">
                <div class="stock-stat">
                    <div class="stock-stat-label">現在庫</div>
                    <div class="stock-stat-value ${isLow ? 'low' : 'ok'}">${product.current_stock}</div>
                </div>
                <div class="stock-stat">
                    <div class="stock-stat-label">発注点</div>
                    <div class="stock-stat-value">${product.reorder_point}</div>
                </div>
            </div>

            <div class="stock-card-status ${statusClass}">
                ${statusText}
            </div>

            <div class="stock-card-actions">
                <button class="btn-quick btn-quick-out" onclick="quickStockChange(${product.id}, -5)" title="5個出庫">-5</button>
                <button class="btn-quick btn-quick-out" onclick="quickStockChange(${product.id}, -1)" title="1個出庫">-1</button>
                <button class="btn-quick btn-quick-in" onclick="quickStockChange(${product.id}, 1)" title="1個入庫">+1</button>
                <button class="btn-quick btn-quick-in" onclick="quickStockChange(${product.id}, 5)" title="5個入庫">+5</button>
            </div>
        `;

        container.appendChild(card);
    });

    // 件数バッジを更新
    stockCount.textContent = `${filteredProducts.length}件`;
}

// 発注依頼済み商品一覧表示
let allActiveOrders = [];
let showingAllOrders = false;

async function loadPendingOrders() {
    try {
        const response = await fetch('/api/orders');
        const orders = await response.json();

        // pending、orderedのステータスのみ表示（received、cancelledは除外）
        allActiveOrders = orders.filter(o => o.status === 'pending' || o.status === 'ordered');
        const pendingSection = document.getElementById('pending-orders-section');
        const pendingCount = document.getElementById('pending-count');

        if (allActiveOrders.length > 0) {
            pendingSection.style.display = 'block';
            renderPendingOrders(false);

            // 件数バッジを更新
            pendingCount.textContent = `${allActiveOrders.length}件`;
        } else {
            pendingSection.style.display = 'none';
        }
    } catch (error) {
        console.error('発注依頼取得エラー:', error);
    }
}

function renderPendingOrders(showAll) {
    const tbody = document.querySelector('#pending-orders-table tbody');
    const showMoreDiv = document.getElementById('show-more-orders');
    tbody.innerHTML = '';

    const DISPLAY_LIMIT = 8;
    const ordersToShow = showAll ? allActiveOrders : allActiveOrders.slice(0, DISPLAY_LIMIT);

    ordersToShow.forEach(order => {
        const row = tbody.insertRow();
        const requestedDateTime = new Date(order.requested_at);
        const formattedDate = requestedDateTime.toLocaleDateString('ja-JP');

        // ステータスの表示
        const statusMap = {
            'pending': '発注依頼中',
            'ordered': '発注済',
            'received': '受領済',
            'cancelled': 'キャンセル'
        };
        const statusColorMap = {
            'pending': '#f57c00',
            'ordered': '#1976d2',
            'received': '#388e3c',
            'cancelled': '#757575'
        };

        const statusText = statusMap[order.status] || order.status;
        const statusColor = statusColorMap[order.status] || '#000';

        // ステータスに応じたボタン表示
        let actionButtons = '';
        if (order.status === 'pending') {
            actionButtons = `
                <button class="btn btn-secondary" onclick="completeOrder(${order.id}, ${order.product_id}, '${order.product_name.replace(/'/g, "\\'")}')">入荷完了</button>
                <button class="btn btn-secondary" onclick="updateOrderStatus(${order.id}, 'cancelled')">キャンセル</button>
            `;
        } else if (order.status === 'ordered') {
            actionButtons = `
                <button class="btn btn-secondary" onclick="completeOrder(${order.id}, ${order.product_id}, '${order.product_name.replace(/'/g, "\\'")}')">入荷完了</button>
            `;
        } else {
            actionButtons = '-';
        }

        row.innerHTML = `
            <td>${order.product_name}</td>
            <td>${formattedDate}</td>
            <td style="white-space: nowrap;">${actionButtons}</td>
        `;
    });

    // 「もっと確認」リンクの表示制御
    if (allActiveOrders.length > DISPLAY_LIMIT && !showAll) {
        showMoreDiv.style.display = 'block';
    } else {
        showMoreDiv.style.display = 'none';
    }
}

// 「もっと確認」リンクのイベントリスナー（setupEventListeners内で設定）
function setupShowMoreOrdersLink() {
    const showMoreLink = document.getElementById('show-more-orders-link');
    if (showMoreLink) {
        showMoreLink.addEventListener('click', (e) => {
            e.preventDefault();
            showingAllOrders = true;
            renderPendingOrders(true);
        });
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
                    <h4>発注分析</h4>
                    ${reorderPointInfo}
                    <p>・1日平均消費量: ${analysis.avgDailyConsumption}個</p>
                    <p>・在庫切れまで: 約${analysis.daysUntilStockout}日</p>
                    <p>・推奨発注量: ${analysis.recommendedOrderQty}個</p>
                    <p>・消費トレンド: ${analysis.analysisNote}</p>
                    ${analysis.hasWeeklyPattern ? '<p>・曜日別の消費パターンが確認されています</p>' : ''}
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

        if (inResponse.status === 401) {
            alert('セッションが切れました。再度ログインしてください。');
            window.location.href = '/';
            return;
        }

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

    // カテゴリフィルターのイベントリスナーを設定（重複を避けるため一度削除）
    const categoryFilter = document.getElementById('products-category-filter');
    const newFilter = categoryFilter.cloneNode(true);
    categoryFilter.parentNode.replaceChild(newFilter, categoryFilter);
    newFilter.addEventListener('change', updateProductsDisplay);

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
}

// 商品マスター表示更新
function updateProductsDisplay() {
    const selectedCategory = document.getElementById('products-category-filter').value;

    let filteredProducts = products;

    // カテゴリでフィルター
    if (selectedCategory) {
        filteredProducts = filteredProducts.filter(p => p.category === selectedCategory);
    }

    const tbody = document.querySelector('#products-table tbody');
    tbody.innerHTML = '';

    filteredProducts.forEach(product => {
        const row = tbody.insertRow();
        const imageHtml = product.image_url
            ? `<img src="${product.image_url}" class="product-thumbnail" onclick="showImagePopup('${product.image_url}')" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px;">`
            : '<span style="color: #999;">画像なし</span>';

        row.innerHTML = `
            <td>${imageHtml}</td>
            <td>${product.name}</td>
            <td>${product.category || '-'}</td>
            <td>¥${(product.unit_price || 0).toLocaleString()}</td>
            <td>${product.reorder_point}</td>
            <td>${product.current_stock}</td>
            <td>
                <button class="btn btn-secondary" onclick="editProduct(${product.id})">編集</button>
                <button class="btn btn-danger" onclick="deleteProduct(${product.id}, '${product.name.replace(/'/g, "\\'")}')">削除</button>
            </td>
        `;
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

    // 既存のカテゴリ一覧を取得
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];
    const categoryOptions = categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');

    modalBody.innerHTML = `
        <h3>新規商品登録</h3>
        <form id="product-form" enctype="multipart/form-data">
            <div class="form-group">
                <label>商品名</label>
                <input type="text" id="product-name" required>
            </div>
            <div class="form-group">
                <label>カテゴリ</label>
                <select id="product-category" required>
                    <option value="">カテゴリを選択してください</option>
                    ${categoryOptions}
                    <option value="__new__">新しいカテゴリを追加...</option>
                </select>
                <input type="text" id="product-category-new" style="display: none; margin-top: 10px;" placeholder="新しいカテゴリ名を入力">
            </div>
            <div class="form-group">
                <label>商品画像</label>
                <input type="file" id="product-image" accept="image/*">
                <div id="image-preview" style="margin-top: 10px;"></div>
            </div>
            <div class="form-group">
                <label>単価（円）</label>
                <input type="number" id="product-unit-price" min="0" step="0.01" value="0">
            </div>
            <div class="form-group">
                <label>発注点</label>
                <input type="number" id="product-reorder" min="0" value="0">
            </div>
            <div class="form-group">
                <label>初期在庫</label>
                <input type="number" id="product-initial" min="0" value="0">
            </div>
            <div class="form-group">
                <label style="display: inline-flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="product-include-count" checked style="
                        width: 18px;
                        height: 18px;
                        margin-right: 8px;
                        cursor: pointer;
                        accent-color: #667eea;
                    ">
                    <span>棚卸対象に含める</span>
                </label>
            </div>
            <button type="submit" class="btn btn-primary">登録</button>
        </form>
    `;

    // カテゴリ選択の変更イベント
    document.getElementById('product-category').addEventListener('change', (e) => {
        const newCategoryInput = document.getElementById('product-category-new');
        if (e.target.value === '__new__') {
            newCategoryInput.style.display = 'block';
            newCategoryInput.required = true;
        } else {
            newCategoryInput.style.display = 'none';
            newCategoryInput.required = false;
            newCategoryInput.value = '';
        }
    });

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

        // 2重送信防止
        const submitButton = e.target.querySelector('button[type="submit"]');
        if (submitButton.disabled) return;
        submitButton.disabled = true;
        submitButton.textContent = '処理中...';

        const categorySelect = document.getElementById('product-category');
        const newCategoryInput = document.getElementById('product-category-new');
        let category = categorySelect.value;

        // 新しいカテゴリが選択された場合
        if (category === '__new__') {
            category = newCategoryInput.value.trim();
            if (!category) {
                alert('新しいカテゴリ名を入力してください');
                submitButton.disabled = false;
                submitButton.textContent = '登録';
                return;
            }
        }

        const formData = new FormData();
        formData.append('name', document.getElementById('product-name').value);
        formData.append('category', category);
        formData.append('unit_price', parseFloat(document.getElementById('product-unit-price').value) || 0);
        formData.append('reorder_point', parseInt(document.getElementById('product-reorder').value));
        formData.append('current_stock', parseInt(document.getElementById('product-initial').value));
        formData.append('include_in_count', document.getElementById('product-include-count').checked ? 1 : 0);

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
                showProducts();
                alert('商品を登録しました');
            } else {
                const errorData = await response.json();
                alert('登録に失敗しました: ' + (errorData.error || response.statusText));
            }
        } catch (error) {
            console.error('登録エラー:', error);
            alert('登録に失敗しました: ' + error.message);
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = '登録';
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

    // 既存のカテゴリ一覧を取得
    const categories = [...new Set(products.map(p => p.category).filter(c => c))];
    const categoryOptions = categories.map(cat =>
        `<option value="${cat}" ${cat === product.category ? 'selected' : ''}>${cat}</option>`
    ).join('');

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
                <select id="edit-category" required>
                    <option value="">カテゴリを選択してください</option>
                    ${categoryOptions}
                    <option value="__new__">新しいカテゴリを追加...</option>
                </select>
                <input type="text" id="edit-category-new" style="display: none; margin-top: 10px;" placeholder="新しいカテゴリ名を入力">
            </div>
            <div class="form-group">
                <label>商品画像</label>
                ${currentImageHtml}
                <input type="file" id="edit-image" accept="image/*">
                <div id="edit-image-preview" style="margin-top: 10px;"></div>
            </div>
            <div class="form-group">
                <label>単価（円）</label>
                <input type="number" id="edit-unit-price" min="0" step="0.01" value="${product.unit_price || 0}">
            </div>
            <div class="form-group">
                <label>発注点</label>
                <input type="number" id="edit-reorder" min="0" value="${product.reorder_point}">
            </div>
            <div class="form-group">
                <label>現在庫</label>
                <input type="number" id="edit-current-stock" min="0" value="${product.current_stock}">
                <small style="color: #666;">※在庫数を変更できます</small>
            </div>
            <div class="form-group">
                <label style="display: inline-flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="edit-include-count" ${product.include_in_count !== 0 ? 'checked' : ''} style="
                        width: 18px;
                        height: 18px;
                        margin-right: 8px;
                        cursor: pointer;
                        accent-color: #667eea;
                    ">
                    <span>棚卸対象に含める</span>
                </label>
            </div>
            <button type="submit" class="btn btn-primary">更新</button>
        </form>
    `;

    // カテゴリ選択の変更イベント
    document.getElementById('edit-category').addEventListener('change', (e) => {
        const newCategoryInput = document.getElementById('edit-category-new');
        if (e.target.value === '__new__') {
            newCategoryInput.style.display = 'block';
            newCategoryInput.required = true;
        } else {
            newCategoryInput.style.display = 'none';
            newCategoryInput.required = false;
            newCategoryInput.value = '';
        }
    });

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

        // 2重送信防止
        const submitButton = e.target.querySelector('button[type="submit"]');
        if (submitButton.disabled) return;
        submitButton.disabled = true;
        submitButton.textContent = '処理中...';

        const categorySelect = document.getElementById('edit-category');
        const newCategoryInput = document.getElementById('edit-category-new');
        let category = categorySelect.value;

        // 新しいカテゴリが選択された場合
        if (category === '__new__') {
            category = newCategoryInput.value.trim();
            if (!category) {
                alert('新しいカテゴリ名を入力してください');
                submitButton.disabled = false;
                submitButton.textContent = '更新';
                return;
            }
        }

        const formData = new FormData();
        formData.append('name', document.getElementById('edit-name').value);
        formData.append('category', category);
        formData.append('unit_price', parseFloat(document.getElementById('edit-unit-price').value) || 0);
        formData.append('reorder_point', parseInt(document.getElementById('edit-reorder').value));
        formData.append('current_stock', parseInt(document.getElementById('edit-current-stock').value));
        formData.append('include_in_count', document.getElementById('edit-include-count').checked ? 1 : 0);

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
                showProducts();
                alert('商品を更新しました');
            } else {
                const errorData = await response.json();
                alert('更新に失敗しました: ' + (errorData.error || response.statusText));
            }
        } catch (error) {
            console.error('更新エラー:', error);
            alert('更新に失敗しました: ' + error.message);
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = '更新';
        }
    });

    modal.classList.add('show');
}

// 商品削除
async function deleteProduct(productId, productName) {
    // 確認ダイアログを表示
    const confirmed = confirm(`商品「${productName}」を削除しますか？\n\n※在庫履歴がある商品は削除できません。`);

    if (!confirmed) return;

    try {
        const response = await fetch(`/api/products/${productId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            await loadProducts();
            showProducts();
            alert('商品を削除しました');
        } else {
            alert('削除に失敗しました: ' + (data.error || ''));
        }
    } catch (error) {
        console.error('削除エラー:', error);
        alert('削除に失敗しました: ' + error.message);
    }
}

// YYYY-MM-DD形式に変換
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
    const groupEnabled = document.getElementById('group-history-toggle').checked;

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

        if (groupEnabled) {
            // グループ化表示
            renderGroupedHistory(history, tbody);
        } else {
            // 通常表示
            renderNormalHistory(history, tbody);
        }
    } catch (error) {
        console.error('履歴取得エラー:', error);
    }
}

// 通常の履歴表示
function renderNormalHistory(history, tbody) {
    history.forEach(item => {
        const row = tbody.insertRow();
        const typeText = item.type === 'in' ? '入庫' : item.type === 'out' ? '出庫' : '調整';

        // UTCから日本時間に変換（+9時間）
        const createdAtUTC = new Date(item.created_at + 'Z'); // Zを追加してUTCとして解釈
        const transactionDate = item.transaction_date ?
            new Date(item.transaction_date).toLocaleDateString('ja-JP') : '-';
        const createdTime = createdAtUTC.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });

        row.innerHTML = `
            <td>${transactionDate} ${createdTime}</td>
            <td>${item.product_name}</td>
            <td>${item.category || '-'}</td>
            <td>${typeText}</td>
            <td>${item.quantity}</td>
            <td>${item.username}</td>
            <td>
                <button class="btn btn-secondary" onclick="editHistory(${item.id})">修正</button>
            </td>
        `;
    });
}

// グループ化された履歴表示
function renderGroupedHistory(history, tbody) {
    // グループ化: 商品ID + 日付 + ユーザー名 + 種別 をキーにする
    const groups = {};

    history.forEach(item => {
        // UTCから日本時間に変換
        const createdAtUTC = new Date(item.created_at + 'Z');
        const date = item.transaction_date ?
            new Date(item.transaction_date).toLocaleDateString('ja-JP') :
            createdAtUTC.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });

        const key = `${item.product_id}_${date}_${item.username}_${item.type}`;

        if (!groups[key]) {
            groups[key] = {
                items: [],
                product_name: item.product_name,
                category: item.category,
                date: date,
                type: item.type,
                username: item.username,
                total_quantity: 0
            };
        }

        groups[key].items.push(item);
        groups[key].total_quantity += parseInt(item.quantity);
    });

    // グループをソート（日付の新しい順）
    const sortedGroups = Object.values(groups).sort((a, b) => {
        const dateA = new Date(a.items[0].created_at);
        const dateB = new Date(b.items[0].created_at);
        return dateB - dateA;
    });

    sortedGroups.forEach((group, index) => {
        const row = tbody.insertRow();
        const typeText = group.type === 'in' ? '入庫' : group.type === 'out' ? '出庫' : '調整';
        const isMultiple = group.items.length > 1;
        const groupId = `group-${index}`;

        row.className = 'history-group-row';
        row.innerHTML = `
            <td>${group.date}</td>
            <td>${group.product_name}</td>
            <td>${group.category || '-'}</td>
            <td>${typeText}</td>
            <td style="font-weight: ${isMultiple ? 'bold' : 'normal'};">
                ${group.total_quantity}
                ${isMultiple ? `<span style="color: #667eea; font-size: 12px;"> (${group.items.length}件)</span>` : ''}
            </td>
            <td>${group.username}</td>
            <td>
                ${isMultiple ? `<button class="btn btn-secondary" onclick="toggleGroupDetails('${groupId}')">詳細</button>` : `<button class="btn btn-secondary" onclick="editHistory(${group.items[0].id})">修正</button>`}
            </td>
        `;

        // 複数件の場合、詳細行を追加（初期状態は非表示）
        if (isMultiple) {
            const detailRow = tbody.insertRow();
            detailRow.id = groupId;
            detailRow.className = 'history-detail-row';
            detailRow.style.display = 'none';

            let detailHtml = `
                <td colspan="7">
                    <div style="background: #f8f9fa; padding: 15px; border-radius: 5px;">
                        <strong>詳細 (${group.items.length}件の記録)</strong>
                        <table style="width: 100%; margin-top: 10px; font-size: 13px;">
                            <thead>
                                <tr style="background: #e9ecef;">
                                    <th style="padding: 5px;">時刻</th>
                                    <th style="padding: 5px;">数量</th>
                                    <th style="padding: 5px;">操作</th>
                                </tr>
                            </thead>
                            <tbody>
            `;

            group.items.forEach(item => {
                // UTCから日本時間に変換
                const createdAtUTC = new Date(item.created_at + 'Z');
                const time = createdAtUTC.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
                detailHtml += `
                    <tr>
                        <td style="padding: 5px;">${time}</td>
                        <td style="padding: 5px;">${item.quantity}</td>
                        <td style="padding: 5px;">
                            <button class="btn-small btn-secondary" onclick="editHistory(${item.id})">修正</button>
                        </td>
                    </tr>
                `;
            });

            detailHtml += `
                            </tbody>
                        </table>
                    </div>
                </td>
            `;

            detailRow.innerHTML = detailHtml;
        }
    });
}

// グループの詳細を展開/折りたたみ
function toggleGroupDetails(groupId) {
    const detailRow = document.getElementById(groupId);
    if (detailRow.style.display === 'none') {
        detailRow.style.display = '';
    } else {
        detailRow.style.display = 'none';
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

// 画像ポップアップのイベントリスナー設定（setupEventListeners内で設定）
function setupImagePopup() {
    const popup = document.getElementById('image-popup');
    const closeBtn = popup.querySelector('.image-popup-close');

    // ×ボタンで閉じる
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeImagePopup();
    });

    // 背景クリックで閉じる（画像クリックでも閉じる）
    popup.addEventListener('click', closeImagePopup);
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
                    <h3>発注分析情報</h3>
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
                <div style="background: white; padding: 20px; margin-top: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <p>分析に十分なデータがありません（過去90日間の出庫データが必要です）</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('グラフ取得エラー:', error);
        alert('グラフの読み込みに失敗しました');
    }
}


// テーブル列のリサイズ機能
function setupTableColumnResize() {
    const tables = document.querySelectorAll('table');

    tables.forEach(table => {
        const headers = table.querySelectorAll('th');

        headers.forEach((header, index) => {
            header.style.cursor = 'pointer';
            header.style.transition = 'all 0.2s ease';
            header.title = 'タップで列幅を変更 (通常 → 広い → 狭い)';

            let currentSize = 'normal'; // normal, wide, narrow

            const resizeColumn = () => {
                const allCells = table.querySelectorAll(`tr > *:nth-child(${index + 1})`);

                // フィードバックアニメーション
                header.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    header.style.transform = 'scale(1)';
                }, 100);

                if (currentSize === 'normal') {
                    // 広くする
                    allCells.forEach(cell => {
                        cell.style.minWidth = '200px';
                        cell.style.maxWidth = '200px';
                        cell.style.flex = '0 0 200px';
                    });
                    currentSize = 'wide';
                    header.style.backgroundColor = '#d4e4ff';
                } else if (currentSize === 'wide') {
                    // 狭くする
                    allCells.forEach(cell => {
                        cell.style.minWidth = '60px';
                        cell.style.maxWidth = '60px';
                        cell.style.flex = '0 0 60px';
                    });
                    currentSize = 'narrow';
                    header.style.backgroundColor = '#ffe4d4';
                } else {
                    // 通常に戻す
                    allCells.forEach(cell => {
                        cell.style.minWidth = '';
                        cell.style.maxWidth = '';
                        cell.style.flex = '';
                    });
                    currentSize = 'normal';
                    header.style.backgroundColor = '';
                }
            };

            // タッチデバイス対応: シングルタップで動作
            header.addEventListener('click', resizeColumn);

            // PC対応: ダブルクリックでも動作
            header.addEventListener('dblclick', (e) => {
                e.preventDefault();
            });
        });
    });
}

// ========== 棚卸機能 ==========

let currentCountId = null;

// 画面切り替え
function showCountListView() {
    document.getElementById('count-list-view').style.display = 'block';
    document.getElementById('count-new-view').style.display = 'none';
    document.getElementById('count-detail-view').style.display = 'none';
    document.getElementById('count-report-view').style.display = 'none';
    loadInventoryCounts();
}

function showCountNewView() {
    document.getElementById('count-list-view').style.display = 'none';
    document.getElementById('count-new-view').style.display = 'block';
    document.getElementById('count-detail-view').style.display = 'none';
    document.getElementById('count-report-view').style.display = 'none';

    const today = new Date();
    document.getElementById('count-date').value = today.toISOString().split('T')[0];
}

function showCountDetailView(countId) {
    currentCountId = countId;
    document.getElementById('count-list-view').style.display = 'none';
    document.getElementById('count-new-view').style.display = 'none';
    document.getElementById('count-detail-view').style.display = 'block';
    document.getElementById('count-report-view').style.display = 'none';
    loadCountDetails(countId);
}

function showCountReportView(countId) {
    currentCountId = countId;
    document.getElementById('count-list-view').style.display = 'none';
    document.getElementById('count-new-view').style.display = 'none';
    document.getElementById('count-detail-view').style.display = 'none';
    document.getElementById('count-report-view').style.display = 'block';
    loadCountReport(countId);
}

// 棚卸一覧を読み込み
async function loadInventoryCounts() {
    try {
        const response = await fetch('/api/inventory-count/list');
        const counts = await response.json();

        const tbody = document.querySelector('#count-list-table tbody');
        tbody.innerHTML = '';

        if (counts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">棚卸データがありません</td></tr>';
            return;
        }

        counts.forEach(count => {
            const row = document.createElement('tr');

            const statusText = {
                'in_progress': '実施中',
                'completed': '完了',
                'approved': '承認済み'
            }[count.status] || count.status;

            const progress = `${count.counted_items}/${count.item_count}`;

            row.innerHTML = `
                <td>${count.count_date}</td>
                <td><span class="status-badge status-${count.status}">${statusText}</span></td>
                <td>${count.created_by}</td>
                <td>${new Date(count.created_at).toLocaleString('ja-JP')}</td>
                <td>${progress}</td>
                <td>
                    <button class="btn btn-small" onclick="showCountDetailView(${count.id})">詳細</button>
                    ${count.status === 'in_progress' ? `<button class="btn btn-small btn-danger" onclick="deleteCount(${count.id})">削除</button>` : ''}
                </td>
            `;
            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('棚卸一覧取得エラー:', error);
        alert('棚卸一覧の取得に失敗しました');
    }
}

// 新規棚卸フォームを表示
function showNewCountForm() {
    showCountNewView();
}

// 新規棚卸作成フォームの送信を処理
async function handleNewCountSubmit(e) {
    e.preventDefault();

    const countDate = document.getElementById('count-date').value;

    try {
        const response = await fetch('/api/inventory-count/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count_date: countDate })
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message);
            showCountDetailView(result.count_id);
        } else {
            alert(result.error || '棚卸の開始に失敗しました');
        }
    } catch (error) {
        console.error('棚卸作成エラー:', error);
        alert('棚卸の開始に失敗しました');
    }
}

// 棚卸詳細を読み込み
async function loadCountDetails(countId) {
    try {
        const response = await fetch(`/api/inventory-count/${countId}`);
        const data = await response.json();

        if (!response.ok) {
            alert(data.error || '棚卸の取得に失敗しました');
            return;
        }

        const { count, items } = data;

        const statusText = {
            'in_progress': '実施中',
            'completed': '完了',
            'approved': '承認済み'
        }[count.status] || count.status;

        // 情報表示
        document.getElementById('count-detail-info').innerHTML = `
            <p><strong>棚卸日:</strong> ${count.count_date}</p>
            <p><strong>ステータス:</strong> <span class="status-badge status-${count.status}">${statusText}</span></p>
        `;

        // カテゴリフィルター
        const categories = [...new Set(items.map(item => item.category))].filter(c => c);
        if (categories.length > 0) {
            document.getElementById('count-detail-filter').innerHTML = `
                <label>カテゴリフィルター：</label>
                <select id="count-category-filter" onchange="filterCountItems()">
                    <option value="">すべて</option>
                    ${categories.map(cat => `<option value="${cat}">${cat}</option>`).join('')}
                </select>
            `;
        } else {
            document.getElementById('count-detail-filter').innerHTML = '';
        }

        // 商品一覧
        document.getElementById('count-detail-items').innerHTML = `
            ${count.status === 'in_progress' ? `
                <div style="background: #e3f2fd; padding: 12px; border-radius: 5px; margin-bottom: 15px; border-left: 4px solid #2196f3;">
                    <strong>💡 操作方法：</strong>
                    <ul style="margin: 8px 0 0 20px; padding: 0;">
                        <li>実在庫を入力すると差異が自動計算されます</li>
                        <li>「保存」ボタン：入力した実在庫をすぐに保存したい場合に使用（任意）</li>
                        <li>「棚卸完了」ボタン：未保存の実在庫も自動保存されて完了します</li>
                    </ul>
                </div>
            ` : ''}
            <table id="count-items-table">
                <thead>
                    <tr>
                        <th>商品名</th>
                        <th>カテゴリ</th>
                        <th>理論在庫</th>
                        <th>実在庫</th>
                        <th>差異</th>
                        <th>理由</th>
                        ${count.status === 'in_progress' ? '<th>操作</th>' : ''}
                    </tr>
                </thead>
                <tbody>
                    ${items.map(item => `
                        <tr data-category="${item.category || ''}" data-item-id="${item.id}">
                            <td>${item.product_name}</td>
                            <td>${item.category || '-'}</td>
                            <td>${item.system_quantity}</td>
                            <td>
                                ${count.status === 'in_progress'
                                    ? `<input type="number" class="actual-qty-input" data-item-id="${item.id}" value="${item.actual_quantity || ''}" min="0" style="width: 80px;">`
                                    : (item.actual_quantity !== null ? item.actual_quantity : '-')
                                }
                            </td>
                            <td class="difference-cell">${item.difference !== null ? (item.difference >= 0 ? '+' : '') + item.difference : '-'}</td>
                            <td>
                                ${count.status === 'in_progress' && item.difference !== 0
                                    ? `<input type="text" class="reason-input" data-item-id="${item.id}" value="${item.reason || ''}" placeholder="理由" style="width: 150px;">`
                                    : (item.reason || '-')
                                }
                            </td>
                            ${count.status === 'in_progress' ? `<td><button class="btn btn-small" onclick="saveCountItem(${item.id})">保存</button></td>` : ''}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        // アクション
        document.getElementById('count-detail-actions').innerHTML = `
            ${count.status === 'in_progress' ? `
                <button class="btn btn-primary" onclick="completeCount(${countId})">棚卸完了</button>
            ` : ''}
            ${count.status === 'completed' ? `
                <button class="btn btn-primary" onclick="approveCount(${countId})">承認・在庫反映</button>
                <button class="btn btn-secondary" onclick="showCountReportView(${countId})">差異レポート</button>
            ` : ''}
            ${count.status === 'approved' ? `
                <button class="btn btn-secondary" onclick="showCountReportView(${countId})">差異レポート</button>
            ` : ''}
        `;

        // 実在庫入力時に差異を自動計算
        if (count.status === 'in_progress') {
            document.querySelectorAll('.actual-qty-input').forEach(input => {
                input.addEventListener('change', function() {
                    const row = this.closest('tr');
                    const systemQty = parseInt(row.querySelector('td:nth-child(3)').textContent);
                    const actualQty = parseInt(this.value) || 0;
                    const difference = actualQty - systemQty;

                    const diffCell = row.querySelector('.difference-cell');
                    diffCell.textContent = difference >= 0 ? '+' + difference : difference;
                    diffCell.style.color = difference === 0 ? '#666' : (difference > 0 ? '#2ecc71' : '#e74c3c');
                });
            });
        }
    } catch (error) {
        console.error('棚卸詳細取得エラー:', error);
        alert('棚卸詳細の取得に失敗しました');
    }
}

// カテゴリフィルター
function filterCountItems() {
    const selectedCategory = document.getElementById('count-category-filter').value;
    const rows = document.querySelectorAll('#count-items-table tbody tr');

    rows.forEach(row => {
        const category = row.dataset.category;
        if (!selectedCategory || category === selectedCategory) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// 棚卸明細を保存
async function saveCountItem(itemId) {
    try {
        const row = document.querySelector(`tr[data-item-id="${itemId}"]`);
        const actualQtyInput = row.querySelector('.actual-qty-input');
        const reasonInput = row.querySelector('.reason-input');

        const actualQuantity = parseInt(actualQtyInput.value);
        const reason = reasonInput ? reasonInput.value : '';

        if (isNaN(actualQuantity) || actualQuantity < 0) {
            alert('実在庫数を正しく入力してください');
            return;
        }

        // 実在庫を保存
        const countResponse = await fetch(`/api/inventory-count/0/items/${itemId}/count`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actual_quantity: actualQuantity })
        });

        if (!countResponse.ok) {
            const error = await countResponse.json();
            alert(error.error || '保存に失敗しました');
            return;
        }

        // 差異理由を保存
        if (reason) {
            await fetch(`/api/inventory-count/0/items/${itemId}/reason`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
        }

        alert('保存しました');
    } catch (error) {
        console.error('保存エラー:', error);
        alert('保存に失敗しました');
    }
}

// 棚卸完了
async function completeCount(countId) {
    if (!confirm('棚卸を完了しますか？入力済みの実在庫を自動保存して完了します。')) {
        return;
    }

    try {
        // まず、入力された実在庫を全て保存
        const rows = document.querySelectorAll('#count-items-table tbody tr');
        let savedCount = 0;
        let errorCount = 0;

        for (const row of rows) {
            const itemId = row.dataset.itemId;
            const actualQtyInput = row.querySelector('.actual-qty-input');
            const reasonInput = row.querySelector('.reason-input');

            if (actualQtyInput && actualQtyInput.value !== '') {
                const actualQuantity = parseInt(actualQtyInput.value);
                const reason = reasonInput ? reasonInput.value : '';

                if (!isNaN(actualQuantity) && actualQuantity >= 0) {
                    try {
                        // 実在庫を保存
                        const countResponse = await fetch(`/api/inventory-count/0/items/${itemId}/count`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ actual_quantity: actualQuantity })
                        });

                        if (countResponse.ok) {
                            // 差異理由を保存
                            if (reason) {
                                await fetch(`/api/inventory-count/0/items/${itemId}/reason`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ reason })
                                });
                            }
                            savedCount++;
                        } else {
                            errorCount++;
                        }
                    } catch (err) {
                        errorCount++;
                        console.error('保存エラー:', err);
                    }
                }
            }
        }

        if (errorCount > 0) {
            alert(`一部の商品の保存に失敗しました（${errorCount}件）`);
            return;
        }

        if (savedCount > 0) {
            console.log(`${savedCount}件の実在庫を保存しました`);
        }

        // 棚卸完了処理
        const response = await fetch(`/api/inventory-count/${countId}/complete`, {
            method: 'POST'
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message);
            loadCountDetails(countId); // 詳細を再読み込み
        } else {
            alert(result.error || '棚卸の完了に失敗しました');
        }
    } catch (error) {
        console.error('棚卸完了エラー:', error);
        alert('棚卸の完了に失敗しました');
    }
}

// 棚卸承認・在庫反映
async function approveCount(countId) {
    if (!confirm('差異を在庫に反映しますか？この操作は取り消せません。')) {
        return;
    }

    try {
        const response = await fetch(`/api/inventory-count/${countId}/approve`, {
            method: 'POST'
        });

        const result = await response.json();

        if (response.ok) {
            alert(`${result.message}\n調整した商品: ${result.adjusted_items}件`);
            showCountListView();
        } else {
            alert(result.error || '承認に失敗しました');
        }
    } catch (error) {
        console.error('承認エラー:', error);
        alert('承認に失敗しました');
    }
}

// 棚卸削除
async function deleteCount(countId) {
    if (!confirm('この棚卸を削除しますか？')) {
        return;
    }

    try {
        const response = await fetch(`/api/inventory-count/${countId}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message);
            await loadInventoryCounts();
        } else {
            alert(result.error || '削除に失敗しました');
        }
    } catch (error) {
        console.error('削除エラー:', error);
        alert('削除に失敗しました');
    }
}

// 差異レポート読み込み
async function loadCountReport(countId) {
    try {
        const response = await fetch(`/api/inventory-count/${countId}/report`);
        const data = await response.json();

        if (!response.ok) {
            alert(data.error || 'レポートの取得に失敗しました');
            return;
        }

        const { count, items, stats } = data;

        document.getElementById('count-report-summary').innerHTML = `
            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
                <h3>棚卸日: ${count.count_date}</h3>
                <h4>サマリー</h4>
                <p>総商品数: ${stats.total_items}件</p>
                <p>カウント済み: ${stats.counted_items}件</p>
                <p>差異あり: ${stats.items_with_difference}件</p>
                <p>差異合計: ${stats.total_difference >= 0 ? '+' : ''}${stats.total_difference}</p>
                <p style="color: #2ecc71;">プラス差異: +${stats.positive_difference}</p>
                <p style="color: #e74c3c;">マイナス差異: -${stats.negative_difference}</p>
            </div>
        `;

        document.getElementById('count-report-items').innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>商品名</th>
                        <th>カテゴリ</th>
                        <th>理論在庫</th>
                        <th>実在庫</th>
                        <th>差異</th>
                        <th>理由</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.filter(item => item.difference !== 0 && item.difference !== null).map(item => `
                        <tr>
                            <td>${item.product_name}</td>
                            <td>${item.category || '-'}</td>
                            <td>${item.system_quantity}</td>
                            <td>${item.actual_quantity}</td>
                            <td style="color: ${item.difference > 0 ? '#2ecc71' : '#e74c3c'}; font-weight: bold;">
                                ${item.difference >= 0 ? '+' : ''}${item.difference}
                            </td>
                            <td>${item.reason || '-'}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="6" style="text-align: center;">差異のある商品はありません</td></tr>'}
                </tbody>
            </table>
        `;
    } catch (error) {
        console.error('レポート取得エラー:', error);
        alert('レポートの取得に失敗しました');
    }
}

// 棚卸結果CSV出力
async function exportCountCSV() {
    if (!currentCountId) {
        alert('棚卸データが読み込まれていません');
        return;
    }

    try {
        const response = await fetch(`/api/inventory-count/${currentCountId}`);
        const data = await response.json();

        if (!response.ok) {
            alert(data.error || '棚卸データの取得に失敗しました');
            return;
        }

        const { count, items } = data;

        // CSV形式に変換
        let csv = '\uFEFF'; // BOM for UTF-8
        csv += '棚卸結果\n';
        csv += `棚卸日,${count.count_date}\n`;
        csv += `ステータス,${count.status === 'in_progress' ? '実施中' : count.status === 'completed' ? '完了' : '承認済み'}\n`;
        csv += '\n';
        csv += '商品名,カテゴリ,システム在庫,実在庫,差異,理由,備考\n';

        items.forEach(item => {
            const row = [
                item.product_name,
                item.category || '',
                item.system_quantity,
                item.actual_quantity !== null ? item.actual_quantity : '',
                item.difference !== null ? item.difference : '',
                item.reason || '',
                item.note || ''
            ];
            csv += row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',') + '\n';
        });

        // ダウンロード
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `棚卸結果_${count.count_date}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        console.error('CSV出力エラー:', error);
        alert('CSV出力に失敗しました');
    }
}

// ========== ワンタップ登録機能 ==========

// ワンタップで在庫変更
async function quickStockChange(productId, change) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    // 出庫の場合は在庫不足チェック
    if (change < 0 && product.current_stock + change < 0) {
        alert('在庫が不足しています');
        return;
    }

    try {
        const type = change < 0 ? 'out' : 'in';
        const quantity = Math.abs(change);

        const response = await fetch(`/api/inventory/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId: productId,
                quantity: quantity,
                date: new Date().toISOString().split('T')[0],
                note: 'クイック操作'
            })
        });

        if (response.status === 401) {
            alert('セッションが切れました。再度ログインしてください。');
            window.location.href = '/';
            return;
        }

        if (response.ok) {
            // 成功時のフィードバック（短い通知）
            showQuickFeedback(product.name, change);

            // 商品データを再読み込み
            await loadProducts();
            updateDashboardDisplay();

            // 発注依頼済み商品リストも更新
            await loadPendingOrders();
        } else {
            alert('登録に失敗しました');
        }
    } catch (error) {
        console.error('クイック操作エラー:', error);
        alert('登録に失敗しました');
    }
}

// クイック操作のフィードバック表示
function showQuickFeedback(productName, change) {
    const feedback = document.createElement('div');
    feedback.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${change < 0 ? '#f44336' : '#4caf50'};
        color: white;
        padding: 15px 20px;
        border-radius: 5px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        z-index: 10000;
        font-weight: bold;
        animation: slideIn 0.3s ease-out;
    `;
    feedback.textContent = `${productName}: ${change > 0 ? '+' : ''}${change}`;

    document.body.appendChild(feedback);

    setTimeout(() => {
        feedback.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => feedback.remove(), 300);
    }, 1500);
}

// 出庫ページQRコード表示
async function showQRCode() {
    try {
        const response = await fetch('/api/qrcode/out-stock');
        const data = await response.json();

        if (!response.ok) {
            alert(data.error || 'QRコードの生成に失敗しました');
            return;
        }

        const modal = document.getElementById('modal');
        const modalBody = document.getElementById('modal-body');

        modalBody.innerHTML = `
            <h3>📱 出庫ページQRコード</h3>
            <div style="text-align: center; padding: 20px;">
                <p style="margin-bottom: 20px; color: #555;">
                    このQRコードをスマートフォンで読み取ると、<br>
                    出庫ページに直接アクセスできます。
                </p>
                <img src="${data.qrCodeUrl}" alt="QRコード" style="max-width: 100%; border: 2px solid #ddd; border-radius: 8px; padding: 10px;">
                <p style="margin-top: 15px; font-size: 14px; color: #999;">
                    ${data.targetUrl}
                </p>
                <button class="btn btn-primary" style="margin-top: 20px;" onclick="downloadQRCode('${data.qrCodeUrl}')">
                    QRコードを保存
                </button>
            </div>
        `;

        modal.style.display = 'block';
    } catch (error) {
        console.error('QRコード取得エラー:', error);
        alert('QRコードの取得に失敗しました');
    }
}

// QRコードダウンロード
function downloadQRCode(dataUrl) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = '出庫ページQRコード.png';
    link.click();
}
