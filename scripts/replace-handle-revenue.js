const fs = require('fs');
let appJs = fs.readFileSync('app.js', 'utf8');

const startStr = 'async function handleRevenueSubmit(e) {';
const endStr = 'function editRevenue(id) {';

const startIndex = appJs.indexOf(startStr);
const endIndex = appJs.indexOf(endStr);

if (startIndex !== -1 && endIndex !== -1) {
    const newHandleRev = `async function handleRevenueSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const editId = document.getElementById('revEditId').value.trim();
    const existing = editId ? STATE.revenues.find(r => r.id === editId) : null;

    const dateInput = document.getElementById('revDate').value;
    const storeIdInput = document.getElementById('revStoreId').value;
    const cashInput = document.getElementById('revCash').value;
    const cardInput = document.getElementById('revCard').value;
    const noteInput = document.getElementById('revNote').value;

    const storeId = storeIdInput || (existing ? existing.storeId : '');
    const date = dateInput || (existing ? existing.date : '');
    const cash = (cashInput !== '' && !isNaN(parseFloat(cashInput))) ? parseFloat(cashInput) : (existing ? existing.cash : 0);
    const card = (cardInput !== '' && !isNaN(parseFloat(cardInput))) ? parseFloat(cardInput) : (existing ? existing.card : 0);
    const total = Math.round((cash + card) * 100) / 100;
    const note = noteInput !== undefined ? noteInput.trim() : (existing ? (existing.note || '') : '');

    if (!storeId) {
        showToast('Bitte eine Filiale auswählen.', 'error');
        return;
    }
    if (!date) {
        showToast('Bitte ein Datum angeben.', 'error');
        return;
    }
    if (cash < 0 || card < 0) {
        showToast('Negative Beträge sind nicht zulässig.', 'error');
        return;
    }
    if (total <= 0) {
        showToast('Der Gesamtumsatz muss größer als 0 € sein.', 'error');
        return;
    }

    const payload = {
        ...(existing || {}),
        id: editId || undefined,
        storeId,
        date,
        cash,
        card,
        total,
        note
    };

    try {
        await dataService.saveRevenue(payload, submitBtn);
        closeModal('quickRevenueModal');
        form.reset();
        document.getElementById('revEditId').value = '';
    } catch (err) {
        // Fehler wird von dataService angezeigt; Formular bleibt erhalten, kein Datenverlust!
    }
}

`;

    appJs = appJs.slice(0, startIndex) + newHandleRev + appJs.slice(endIndex);
    fs.writeFileSync('app.js', appJs, 'utf8');
    console.log('handleRevenueSubmit successfully replaced!');
} else {
    console.error('Markers not found!');
}
