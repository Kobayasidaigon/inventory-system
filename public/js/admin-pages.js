// 管理者向けページの機能

// 発注管理ページ
async function showOrderManagement() {
    const filterSelect = document.getElementById('order-mgmt-filter');
    const filter = filterSelect.value;

    const orders = await loadPendingOrders();

    let filteredOrders = orders;
    if (filter !== 'all') {
        filteredOrders = orders.filter(order => order.status === filter);
    }

    const tbody = document.querySelector('#order-mgmt-table tbody');
    tbody.innerHTML = '';

    for (const order of filteredOrders) {
        const row = document.createElement('tr');

        // 商品名
        const nameCell = document.createElement('td');
        nameCell.textContent = order.product_name || '不明';
        row.appendChild(nameCell);

        // 現在庫
        const stockCell = document.createElement('td');
        stockCell.textContent = `${order.current_stock || 0}個`;
        row.appendChild(stockCell);

        // 希望数 / 承認数
        const qtyCell = document.createElement('td');
        if (order.status === 'approved' && order.approved_quantity) {
            qtyCell.innerHTML = `
                <span style="text-decoration: line-through; color: #888;">${order.requested_quantity}個</span>
                → <strong>${order.approved_quantity}個</strong>
            `;
        } else {
            qtyCell.textContent = `${order.requested_quantity}個`;
        }
        row.appendChild(qtyCell);

        // 希望者
        const requesterCell = document.createElement('td');
        requesterCell.textContent = order.requested_by || order.username || '-';
        row.appendChild(requesterCell);

        // 希望日時
        const dateCell = document.createElement('td');
        dateCell.textContent = new Date(order.requested_at).toLocaleString('ja-JP');
        row.appendChild(dateCell);

        // 状態
        const statusCell = document.createElement('td');
        let statusText = '';
        let statusClass = '';

        switch (order.status) {
            case 'pending':
                statusText = '未承認';
                statusClass = 'status-pending';
                break;
            case 'approved':
                statusText = '承認済';
                statusClass = 'status-approved';
                break;
            case 'rejected':
                statusText = '却下';
                statusClass = 'status-rejected';
                break;
            case 'cancelled':
                statusText = 'キャンセル';
                statusClass = 'status-cancelled';
                break;
        }

        const statusSpan = document.createElement('span');
        statusSpan.textContent = statusText;
        statusSpan.className = statusClass;
        statusCell.appendChild(statusSpan);

        if (order.approved_by) {
            const approverSpan = document.createElement('div');
            approverSpan.textContent = `(${order.approved_by})`;
            approverSpan.style.fontSize = '0.9em';
            approverSpan.style.color = '#666';
            statusCell.appendChild(approverSpan);
        }

        row.appendChild(statusCell);

        // 操作
        const actionCell = document.createElement('td');

        if (order.status === 'pending') {
            const approveBtn = document.createElement('button');
            approveBtn.textContent = '承認';
            approveBtn.className = 'btn btn-success btn-sm';
            approveBtn.onclick = () => showApproveForm(order);
            actionCell.appendChild(approveBtn);

            actionCell.appendChild(document.createTextNode(' '));

            const rejectBtn = document.createElement('button');
            rejectBtn.textContent = '却下';
            rejectBtn.className = 'btn btn-danger btn-sm';
            rejectBtn.onclick = () => rejectOrder(order.id);
            actionCell.appendChild(rejectBtn);
        } else if (order.status === 'approved') {
            const editBtn = document.createElement('button');
            editBtn.textContent = '編集';
            editBtn.className = 'btn btn-secondary btn-sm';
            editBtn.onclick = () => showEditOrderForm(order);
            actionCell.appendChild(editBtn);
        } else {
            actionCell.textContent = '-';
        }

        row.appendChild(actionCell);
        tbody.appendChild(row);
    }
}

// 承認フォームを表示
function showApproveForm(order) {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>発注承認: ${order.product_name}</h3>
        <form id="approve-order-form">
            <div class="form-group">
                <label>現在庫</label>
                <input type="text" value="${order.current_stock}個" readonly>
            </div>
            <div class="form-group">
                <label>希望数</label>
                <input type="text" value="${order.requested_quantity}個" readonly>
            </div>
            <div class="form-group">
                <label>希望者</label>
                <input type="text" value="${order.requested_by || order.username}" readonly>
            </div>
            <div class="form-group">
                <label for="approved-quantity">承認数量</label>
                <input type="number" id="approved-quantity" value="${order.requested_quantity}" min="1" required>
                <small>※ お盆前などで数量を調整できます</small>
            </div>
            <div class="form-group">
                <label for="approve-note">備考</label>
                <textarea id="approve-note">${order.note || ''}</textarea>
            </div>
            <button type="submit" class="btn btn-success">承認する</button>
        </form>
    `;

    document.getElementById('approve-order-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const approvedQuantity = document.getElementById('approved-quantity').value;
        const note = document.getElementById('approve-note').value;

        await approveOrder(order.id, approvedQuantity, note);
    });

    document.getElementById('modal').style.display = 'block';
}

// 発注を承認
async function approveOrder(orderId, approvedQuantity, note) {
    try {
        const response = await fetch(`/api/orders/${orderId}/approve`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                approvedQuantity: parseInt(approvedQuantity),
                note
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注を承認しました');
            closeModal();
            showOrderManagement(); // リフレッシュ
        } else {
            alert('エラー: ' + (data.error || '承認に失敗しました'));
        }
    } catch (error) {
        console.error('承認エラー:', error);
        alert('承認に失敗しました');
    }
}

// 発注を却下
async function rejectOrder(orderId) {
    const note = prompt('却下理由を入力してください（任意）');

    if (note === null) {
        return; // キャンセルされた
    }

    try {
        const response = await fetch(`/api/orders/${orderId}/reject`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note })
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注を却下しました');
            showOrderManagement(); // リフレッシュ
        } else {
            alert('エラー: ' + (data.error || '却下に失敗しました'));
        }
    } catch (error) {
        console.error('却下エラー:', error);
        alert('却下に失敗しました');
    }
}

// 発注編集フォームを表示
function showEditOrderForm(order) {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>発注編集: ${order.product_name}</h3>
        <form id="edit-order-form">
            <div class="form-group">
                <label>現在庫</label>
                <input type="text" value="${order.current_stock}個" readonly>
            </div>
            <div class="form-group">
                <label>元の希望数</label>
                <input type="text" value="${order.requested_quantity}個" readonly>
            </div>
            <div class="form-group">
                <label for="edit-approved-quantity">承認数量</label>
                <input type="number" id="edit-approved-quantity"
                       value="${order.approved_quantity || order.requested_quantity}" min="1" required>
                <small>※ お盆前などで数量を変更できます</small>
            </div>
            <div class="form-group">
                <label for="edit-note">備考</label>
                <textarea id="edit-note">${order.note || ''}</textarea>
            </div>
            <button type="submit" class="btn btn-primary">更新する</button>
        </form>
    `;

    document.getElementById('edit-order-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const quantity = document.getElementById('edit-approved-quantity').value;
        const note = document.getElementById('edit-note').value;

        await editOrder(order.id, quantity, note);
    });

    document.getElementById('modal').style.display = 'block';
}

// 発注を編集
async function editOrder(orderId, quantity, note) {
    try {
        const response = await fetch(`/api/orders/${orderId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quantity: parseInt(quantity),
                note
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('発注を更新しました');
            closeModal();
            showOrderManagement(); // リフレッシュ
        } else {
            alert('エラー: ' + (data.error || '更新に失敗しました'));
        }
    } catch (error) {
        console.error('更新エラー:', error);
        alert('更新に失敗しました');
    }
}

// イベントリスナーの設定
function setupAdminPagesEventListeners() {
    // 発注管理のフィルター
    const orderMgmtFilter = document.getElementById('order-mgmt-filter');
    if (orderMgmtFilter) {
        orderMgmtFilter.addEventListener('change', showOrderManagement);
    }
}
