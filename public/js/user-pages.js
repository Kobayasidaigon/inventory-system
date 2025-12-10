// 一般ユーザー向けページの機能

// 現在庫表示ページ
async function showStockView() {
    const categoryFilter = document.getElementById('stock-view-category-filter');
    const selectedCategory = categoryFilter.value;

    const filteredProducts = selectedCategory
        ? products.filter(p => p.category === selectedCategory)
        : products;

    const tbody = document.querySelector('#stock-view-table tbody');
    tbody.innerHTML = '';

    // 発注依頼済み商品を取得
    await loadPendingOrders();

    for (const product of filteredProducts) {
        const row = document.createElement('tr');

        // 画像
        const imageCell = document.createElement('td');
        if (product.image_url) {
            const img = document.createElement('img');
            img.src = product.image_url;
            img.alt = product.name;
            img.className = 'product-thumbnail';
            img.style.cursor = 'pointer';
            img.onclick = () => showImagePopup(product.image_url);
            imageCell.appendChild(img);
        } else {
            imageCell.textContent = '画像なし';
        }
        row.appendChild(imageCell);

        // 商品名
        const nameCell = document.createElement('td');
        nameCell.textContent = product.name;
        row.appendChild(nameCell);

        // カテゴリ
        const categoryCell = document.createElement('td');
        categoryCell.textContent = product.category || '-';
        row.appendChild(categoryCell);

        // 現在庫
        const stockCell = document.createElement('td');
        stockCell.textContent = `${product.current_stock}個`;
        row.appendChild(stockCell);

        // 発注点
        const reorderCell = document.createElement('td');
        reorderCell.textContent = `${product.reorder_point}個`;
        row.appendChild(reorderCell);

        // 状態
        const statusCell = document.createElement('td');
        const isPending = pendingOrders.some(order =>
            order.product_id === product.id && order.status === 'pending'
        );
        const isApproved = pendingOrders.some(order =>
            order.product_id === product.id && order.status === 'approved'
        );

        let statusText = '';
        let statusClass = '';

        if (isApproved) {
            statusText = '発注承認済';
            statusClass = 'stock-approved';
        } else if (isPending) {
            statusText = '発注希望済';
            statusClass = 'stock-pending';
        } else if (product.current_stock <= product.reorder_point) {
            statusText = '⚠️ 要発注';
            statusClass = 'stock-warning';
        } else {
            statusText = '✅ 在庫十分';
            statusClass = 'stock-ok';
        }

        const statusSpan = document.createElement('span');
        statusSpan.textContent = statusText;
        statusSpan.className = statusClass;
        statusCell.appendChild(statusSpan);
        row.appendChild(statusCell);

        tbody.appendChild(row);
    }
}

// 発注希望ページ
async function showOrderRequest() {
    const filterSelect = document.getElementById('order-request-filter');
    const filter = filterSelect.value;

    await loadPendingOrders();

    let filteredProducts = [...products];

    if (filter === 'needs-order') {
        // 要発注のみ（発注点以下で、まだ発注希望していない商品）
        filteredProducts = products.filter(p =>
            p.current_stock <= p.reorder_point &&
            !pendingOrders.some(order => order.product_id === p.id && order.status === 'pending')
        );
    } else if (filter === 'pending') {
        // 発注希望済みのみ
        const pendingProductIds = pendingOrders
            .filter(order => order.status === 'pending' || order.status === 'approved')
            .map(order => order.product_id);
        filteredProducts = products.filter(p => pendingProductIds.includes(p.id));
    }

    const tbody = document.querySelector('#order-request-table tbody');
    tbody.innerHTML = '';

    for (const product of filteredProducts) {
        const row = document.createElement('tr');

        // 画像
        const imageCell = document.createElement('td');
        if (product.image_url) {
            const img = document.createElement('img');
            img.src = product.image_url;
            img.alt = product.name;
            img.className = 'product-thumbnail';
            img.style.cursor = 'pointer';
            img.onclick = () => showImagePopup(product.image_url);
            imageCell.appendChild(img);
        } else {
            imageCell.textContent = '画像なし';
        }
        row.appendChild(imageCell);

        // 商品名
        const nameCell = document.createElement('td');
        nameCell.textContent = product.name;
        row.appendChild(nameCell);

        // 現在庫
        const stockCell = document.createElement('td');
        stockCell.textContent = `${product.current_stock}個`;
        row.appendChild(stockCell);

        // 発注点
        const reorderCell = document.createElement('td');
        reorderCell.textContent = `${product.reorder_point}個`;
        row.appendChild(reorderCell);

        // 推奨発注数
        const recommendedCell = document.createElement('td');
        const recommendedQty = Math.max(0, (product.reorder_point * 2) - product.current_stock);
        recommendedCell.textContent = `${recommendedQty}個`;
        row.appendChild(recommendedCell);

        // 状態
        const statusCell = document.createElement('td');
        const existingOrder = pendingOrders.find(order => order.product_id === product.id);

        if (existingOrder) {
            let statusText = '';
            let statusClass = '';

            if (existingOrder.status === 'approved') {
                statusText = `発注承認済 (${existingOrder.approved_quantity || existingOrder.requested_quantity}個)`;
                statusClass = 'stock-approved';
            } else if (existingOrder.status === 'pending') {
                statusText = `発注希望済 (${existingOrder.requested_quantity}個)`;
                statusClass = 'stock-pending';
            } else if (existingOrder.status === 'rejected') {
                statusText = '却下';
                statusClass = 'stock-rejected';
            }

            const statusSpan = document.createElement('span');
            statusSpan.textContent = statusText;
            statusSpan.className = statusClass;
            statusCell.appendChild(statusSpan);
        } else {
            statusCell.textContent = '-';
        }
        row.appendChild(statusCell);

        // 操作
        const actionCell = document.createElement('td');
        const existingPendingOrder = pendingOrders.find(order =>
            order.product_id === product.id &&
            (order.status === 'pending' || order.status === 'approved')
        );

        if (existingPendingOrder) {
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'キャンセル';
            cancelBtn.className = 'btn btn-danger btn-sm';
            cancelBtn.onclick = () => cancelOrderRequest(existingPendingOrder.id);
            actionCell.appendChild(cancelBtn);
        } else {
            const requestBtn = document.createElement('button');
            requestBtn.textContent = '発注希望する';
            requestBtn.className = 'btn btn-primary btn-sm';
            requestBtn.onclick = () => showOrderRequestForm(product, recommendedQty);
            actionCell.appendChild(requestBtn);
        }

        row.appendChild(actionCell);
        tbody.appendChild(row);
    }
}

// 発注希望フォームを表示
function showOrderRequestForm(product, recommendedQty) {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>発注希望: ${product.name}</h3>
        <form id="order-request-form">
            <div class="form-group">
                <label>現在庫</label>
                <input type="text" value="${product.current_stock}個" readonly>
            </div>
            <div class="form-group">
                <label>発注点</label>
                <input type="text" value="${product.reorder_point}個" readonly>
            </div>
            <div class="form-group">
                <label for="order-quantity">発注希望数</label>
                <input type="number" id="order-quantity" value="${recommendedQty}" min="1" required>
            </div>
            <div class="form-group">
                <label for="order-requester">希望者名</label>
                <input type="text" id="order-requester" value="${currentUser}" required>
            </div>
            <div class="form-group">
                <label for="order-note">備考</label>
                <textarea id="order-note"></textarea>
            </div>
            <button type="submit" class="btn btn-primary">発注希望を送信</button>
        </form>
    `;

    document.getElementById('order-request-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const quantity = document.getElementById('order-quantity').value;
        const requester = document.getElementById('order-requester').value;
        const note = document.getElementById('order-note').value;

        await submitOrderRequest(product.id, quantity, requester, note);
    });

    document.getElementById('modal').style.display = 'block';
}

// 発注希望を送信
async function submitOrderRequest(productId, quantity, requestedBy, note) {
    try {
        const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId,
                quantity: parseInt(quantity),
                requestedBy,
                note
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注希望を送信しました');
            closeModal();
            showOrderRequest(); // リフレッシュ
        } else {
            alert('エラー: ' + (data.error || '発注希望の送信に失敗しました'));
        }
    } catch (error) {
        console.error('発注希望送信エラー:', error);
        alert('発注希望の送信に失敗しました');
    }
}

// 発注希望をキャンセル
async function cancelOrderRequest(orderId) {
    if (!confirm('この発注希望をキャンセルしますか？')) {
        return;
    }

    try {
        const response = await fetch(`/api/orders/${orderId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注希望をキャンセルしました');
            showOrderRequest(); // リフレッシュ
        } else {
            alert('エラー: ' + (data.error || 'キャンセルに失敗しました'));
        }
    } catch (error) {
        console.error('キャンセルエラー:', error);
        alert('キャンセルに失敗しました');
    }
}

// 発注依頼一覧を取得
async function loadPendingOrders() {
    try {
        const response = await fetch('/api/orders');
        const data = await response.json();
        pendingOrders = data;
        return data;
    } catch (error) {
        console.error('発注依頼一覧取得エラー:', error);
        return [];
    }
}

// イベントリスナーの設定
function setupUserPagesEventListeners() {
    // 現在庫表示のカテゴリフィルター
    const stockViewFilter = document.getElementById('stock-view-category-filter');
    if (stockViewFilter) {
        stockViewFilter.addEventListener('change', showStockView);
    }

    // 発注希望のフィルター
    const orderRequestFilter = document.getElementById('order-request-filter');
    if (orderRequestFilter) {
        orderRequestFilter.addEventListener('change', showOrderRequest);
    }
}
