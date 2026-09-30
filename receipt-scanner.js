/**
 * StoreControl Pro - Smart Receipt Scanner & OCR Module
 * Handles photo capture, client-side preprocessing, German Z-Report OCR parsing,
 * duplicate detection, mathematical validation, and cloud persistence.
 */

(function() {
    let currentScanData = null;
    let tesseractWorker = null;

    // =========================================================================
    // INITIALIZATION & EVENT BINDINGS
    // =========================================================================
    window.openReceiptScanner = function() {
        const modal = document.getElementById('receiptScanModal');
        if (modal) {
            resetScanModal();
            modal.classList.remove('hidden');
        }
    };

    window.closeReceiptScanner = function() {
        const modal = document.getElementById('receiptScanModal');
        if (modal) modal.classList.add('hidden');
    };

    window.openReceiptViewer = function(receiptUrl, revenueId) {
        const modal = document.getElementById('receiptViewerModal');
        const img = document.getElementById('receiptViewerImg');
        const title = document.getElementById('receiptViewerTitle');
        if (modal && img) {
            img.src = receiptUrl;
            if (title) title.textContent = `Originalbeleg zur Buchung ${revenueId || ''}`;
            modal.classList.remove('hidden');
        }
    };

    window.closeReceiptViewer = function() {
        const modal = document.getElementById('receiptViewerModal');
        if (modal) modal.classList.add('hidden');
    };

    function resetScanModal() {
        currentScanData = null;
        const uploadZone = document.getElementById('receiptUploadZone');
        const previewZone = document.getElementById('receiptPreviewZone');
        const progressBar = document.getElementById('receiptProgressBar');
        const progressContainer = document.getElementById('receiptProgressContainer');
        const statusText = document.getElementById('receiptProgressText');

        if (uploadZone) uploadZone.classList.remove('hidden');
        if (previewZone) previewZone.classList.add('hidden');
        if (progressContainer) progressContainer.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        if (statusText) statusText.textContent = 'Bereit zum Scannen';

        // Reset inputs
        const fileInput = document.getElementById('receiptFileInput');
        if (fileInput) fileInput.value = '';
        const cameraInput = document.getElementById('receiptCameraInput');
        if (cameraInput) cameraInput.value = '';
    }

    // =========================================================================
    // IMAGE PREPROCESSING (Canvas Grayscale & Contrast Optimization)
    // =========================================================================
    async function preprocessImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    // Calculate optimal dimensions (max 1800px)
                    const maxDim = 1800;
                    let width = img.width;
                    let height = img.height;

                    if (width > maxDim || height > maxDim) {
                        if (width > height) {
                            height = Math.round((height * maxDim) / width);
                            width = maxDim;
                        } else {
                            width = Math.round((width * maxDim) / height);
                            height = maxDim;
                        }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');

                    // Grayscale & contrast enhancement for optimal thermal receipt OCR
                    ctx.filter = 'grayscale(100%) contrast(140%) brightness(105%)';
                    ctx.drawImage(img, 0, 0, width, height);

                    const processedBase64 = canvas.toDataURL('image/jpeg', 0.88);
                    resolve({
                        base64: processedBase64,
                        canvas: canvas,
                        width,
                        height,
                        originalName: file.name
                    });
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // =========================================================================
    // CORE SCAN & RECOGNITION PIPELINE
    // =========================================================================
    window.handleReceiptFileSelect = async function(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        const file = files[0];
        await processReceiptFile(file);
    };

    async function processReceiptFile(file) {
        const uploadZone = document.getElementById('receiptUploadZone');
        const progressContainer = document.getElementById('receiptProgressContainer');
        const progressBar = document.getElementById('receiptProgressBar');
        const progressText = document.getElementById('receiptProgressText');

        if (uploadZone) uploadZone.classList.add('hidden');
        if (progressContainer) progressContainer.classList.remove('hidden');

        function updateProgress(percent, text) {
            if (progressBar) progressBar.style.width = `${Math.min(percent, 100)}%`;
            if (progressText) progressText.textContent = text;
        }

        try {
            updateProgress(15, '📷 Bild wird optimiert & geschärft...');
            const preprocessed = await preprocessImage(file);

            updateProgress(35, '🔍 Texterkennung (OCR) wird initialisiert...');

            let ocrText = '';
            if (typeof Tesseract !== 'undefined') {
                const worker = await Tesseract.createWorker('deu', 1, {
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            const p = Math.round(35 + (m.progress * 45));
                            updateProgress(p, `🔍 Lese Kassenbeleg... ${Math.round(m.progress * 100)}%`);
                        }
                    }
                });
                const ret = await worker.recognize(preprocessed.canvas);
                ocrText = ret.data.text;
                await worker.terminate();
            } else {
                updateProgress(60, '🔍 Lese Beleg über Server-OCR...');
            }

            updateProgress(85, '⚖️ Daten werden abgeglichen & geprüft...');

            // Parse text using the universal German receipt parser
            let parsed = null;
            if (window.ReceiptParser && typeof window.ReceiptParser.parseGermanReceiptText === 'function') {
                parsed = window.ReceiptParser.parseGermanReceiptText(ocrText);
            }

            // Upload image & verify duplicates on backend
            let uploadRes = null;
            if (window.syncManager && syncManager.isLoggedIn()) {
                uploadRes = await syncManager.apiRequest('/api/receipts/upload', {
                    method: 'POST',
                    body: JSON.stringify({
                        image: preprocessed.base64,
                        fileName: preprocessed.originalName,
                        ocrText: ocrText
                    })
                });
            }

            updateProgress(100, '✅ Beleg erfolgreich ausgelesen!');

            // Merge server response with client parsed result
            currentScanData = {
                file: file,
                base64: preprocessed.base64,
                receiptUrl: uploadRes?.receiptUrl || preprocessed.base64,
                receiptHash: uploadRes?.receiptHash || null,
                isDuplicateImage: uploadRes?.isDuplicateImage || false,
                existingRevenue: uploadRes?.existingRevenue || null,
                existingBookingForDay: uploadRes?.existingBookingForDay || null,
                parsed: uploadRes?.parsed || parsed || { total: 0, cash: 0, card: 0, warnings: [] },
                rawText: ocrText
            };

            // Display verification preview
            showReceiptVerificationView(currentScanData);

        } catch (err) {
            console.error('Scan error:', err);
            alert('Fehler beim Scannen des Belegs: ' + err.message);
            resetScanModal();
        }
    }

    // =========================================================================
    // VERIFICATION PREVIEW MODAL LOGIC
    // =========================================================================
    function showReceiptVerificationView(data) {
        const progressContainer = document.getElementById('receiptProgressContainer');
        const previewZone = document.getElementById('receiptPreviewZone');
        const img = document.getElementById('receiptPreviewImg');

        if (progressContainer) progressContainer.classList.add('hidden');
        if (previewZone) previewZone.classList.remove('hidden');
        if (img) img.src = data.base64;

        // Populate Form Fields
        const parsed = data.parsed || {};
        
        // 1. Filiale
        const storeSelect = document.getElementById('scanStoreId');
        if (storeSelect) {
            storeSelect.innerHTML = (STATE.stores || []).map(s => `
                <option value="${s.id}" ${parsed.storeId === s.id ? 'selected' : ''}>${s.name} (${s.address || ''})</option>
            `).join('');

            // Highlight if recognized
            const storeBadge = document.getElementById('scanStoreBadge');
            if (storeBadge) {
                if (parsed.storeId) {
                    storeBadge.className = 'text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1';
                    storeBadge.innerHTML = '✓ Automatisch erkannt';
                } else {
                    storeBadge.className = 'text-[11px] font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full flex items-center gap-1';
                    storeBadge.innerHTML = '⚠️ Bitte auswählen';
                }
            }
        }

        // 2. Datum
        const dateInput = document.getElementById('scanDate');
        if (dateInput) {
            dateInput.value = parsed.date || new Date().toISOString().substring(0, 10);
            const dateBadge = document.getElementById('scanDateBadge');
            if (dateBadge) {
                if (parsed.date) {
                    dateBadge.className = 'text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full';
                    dateBadge.textContent = '✓ Erkannt';
                } else {
                    dateBadge.className = 'text-[11px] font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full';
                    dateBadge.textContent = '⚠️ Heutiges Datum';
                }
            }
        }

        // 3. Beträge
        const cashInput = document.getElementById('scanCash');
        const cardInput = document.getElementById('scanCard');
        const totalInput = document.getElementById('scanTotal');

        if (cashInput) cashInput.value = (parsed.cash || 0).toFixed(2);
        if (cardInput) cardInput.value = (parsed.card || 0).toFixed(2);
        if (totalInput) totalInput.value = (parsed.total || 0).toFixed(2);

        // 4. Details (MwSt, Belegnummer)
        const detailsContainer = document.getElementById('scanDetailsContainer');
        if (detailsContainer) {
            const details = [];
            if (parsed.receiptNumber) details.push(`Beleg-Nr.: ${parsed.receiptNumber}`);
            if (parsed.transactionCount) details.push(`Kunden: ${parsed.transactionCount}`);
            if (parsed.tax19) details.push(`MwSt 19%: ${parsed.tax19.toFixed(2)} €`);
            if (parsed.tax7) details.push(`MwSt 7%: ${parsed.tax7.toFixed(2)} €`);
            detailsContainer.innerHTML = details.length > 0 
                ? details.map(d => `<span class="bg-slate-100 text-slate-700 text-xs px-2 py-1 rounded-md font-medium">${d}</span>`).join(' ')
                : '<span class="text-xs text-slate-400">Keine weiteren Details ausgewiesen</span>';
        }

        // 5. Duplikat- & Warnmeldungen
        const warningBox = document.getElementById('scanWarningBox');
        if (warningBox) {
            let warnHtml = '';
            if (data.isDuplicateImage) {
                warnHtml += `
                    <div class="bg-rose-50 border border-rose-200 text-rose-800 text-xs p-3 rounded-xl flex items-start gap-2 mb-2 font-medium">
                        <span class="text-base">🛑</span>
                        <div>
                            <strong>Doppelter Upload verhindert:</strong> Dieses Foto wurde bereits hochgeladen und ist als Buchung vom ${data.existingRevenue?.date} (${data.existingRevenue?.storeName}) erfasst!
                        </div>
                    </div>
                `;
            } else if (data.existingBookingForDay && data.existingBookingForDay.length > 0) {
                const b = data.existingBookingForDay[0];
                warnHtml += `
                    <div class="bg-amber-50 border border-amber-200 text-amber-800 text-xs p-3 rounded-xl flex items-start gap-2 mb-2 font-medium">
                        <span class="text-base">⚠️</span>
                        <div>
                            <strong>Bestehender Tagesumsatz vorhanden:</strong> Für diese Filiale existiert am ${b.date} bereits ein Umsatz von ${b.total.toFixed(2)} € (Bar: ${b.cash.toFixed(2)} €, Karte: ${b.card.toFixed(2)} €). Dieser neue Beleg wird als zusätzlicher Abschluss gebucht.
                        </div>
                    </div>
                `;
            }
            warningBox.innerHTML = warnHtml;
        }

        // Live Math Sum Check
        window.recalculateScanMath();
    }

    window.recalculateScanMath = function() {
        const cashVal = parseFloat(document.getElementById('scanCash')?.value || 0) || 0;
        const cardVal = parseFloat(document.getElementById('scanCard')?.value || 0) || 0;
        const totalVal = parseFloat(document.getElementById('scanTotal')?.value || 0) || 0;

        const sumPay = Math.round((cashVal + cardVal) * 100) / 100;
        const sumBadge = document.getElementById('scanSumCheckBadge');
        const saveBtn = document.getElementById('scanSaveBtn');

        if (!sumBadge) return;

        if (totalVal > 0 && Math.abs(sumPay - totalVal) <= 0.05) {
            sumBadge.className = 'bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs p-2.5 rounded-xl flex items-center justify-between font-bold';
            sumBadge.innerHTML = `<span>✓ Summenprüfung OK: ${cashVal.toFixed(2)} € Bar + ${cardVal.toFixed(2)} € Karte</span><span class="text-emerald-700 font-black">${totalVal.toFixed(2)} € Gesamt</span>`;
            if (saveBtn) saveBtn.disabled = false;
        } else if (totalVal > 0) {
            sumBadge.className = 'bg-rose-50 border border-rose-200 text-rose-800 text-xs p-2.5 rounded-xl flex items-center justify-between font-bold';
            sumBadge.innerHTML = `<span>⚠️ Abweichung: Bar + Karte = ${sumPay.toFixed(2)} € (Differenz: ${(totalVal - sumPay).toFixed(2)} €)</span><span class="text-rose-700 font-black">Soll: ${totalVal.toFixed(2)} €</span>`;
        } else {
            sumBadge.className = 'bg-slate-50 border border-slate-200 text-slate-600 text-xs p-2.5 rounded-xl flex items-center justify-between';
            sumBadge.innerHTML = '<span>Bitte Gesamtbetrag und Zahlungsarten eingeben</span>';
        }
    };

    // =========================================================================
    // CONFIRM & SAVE REVENUE INTO CENTRAL DATABASE
    // =========================================================================
    window.confirmAndSaveScannedRevenue = async function() {
        if (!currentScanData) return;

        const storeId = document.getElementById('scanStoreId')?.value;
        const date = document.getElementById('scanDate')?.value;
        const cash = parseFloat(document.getElementById('scanCash')?.value || 0) || 0;
        const card = parseFloat(document.getElementById('scanCard')?.value || 0) || 0;
        const total = parseFloat(document.getElementById('scanTotal')?.value || 0) || (cash + card);
        const note = document.getElementById('scanNote')?.value || '';

        if (!storeId || !date || total <= 0) {
            alert('Bitte wählen Sie eine Filiale und ein Datum aus und prüfen Sie den Gesamtbetrag.');
            return;
        }

        const saveBtn = document.getElementById('scanSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Wird gespeichert...';
        }

        const revenuePayload = {
            id: `rev_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            storeId: storeId,
            date: date,
            cash: cash,
            card: card,
            total: total,
            note: note ? `[Beleg] ${note}` : '[Beleg per Foto erfasst]',
            receiptUrl: currentScanData.receiptUrl,
            receiptHash: currentScanData.receiptHash,
            receiptData: {
                receiptNumber: currentScanData.parsed?.receiptNumber || null,
                transactionCount: currentScanData.parsed?.transactionCount || null,
                tax19: currentScanData.parsed?.tax19 || null,
                tax7: currentScanData.parsed?.tax7 || null,
                scannedAt: new Date().toISOString()
            }
        };

        try {
            // Save via API
            if (window.syncManager && syncManager.isLoggedIn()) {
                const res = await syncManager.apiRequest('/api/revenues', {
                    method: 'POST',
                    body: JSON.stringify(revenuePayload)
                });
                if (res && (res.success || res.record)) {
                    const savedRecord = res.record || revenuePayload;
                    STATE.revenues = STATE.revenues || [];
                    STATE.revenues.unshift(savedRecord);
                    saveStateToLocalStorageCache();
                    updateUI();

                    if (typeof showToast === 'function') {
                        showToast(`✅ Tagesumsatz (${total.toFixed(2)} €) mit Beleg gespeichert!`, 'success');
                    }
                    closeReceiptScanner();
                } else {
                    throw new Error(res?.error || 'Fehler beim Speichern');
                }
            } else {
                // Offline fallback
                revenuePayload._pendingSync = true;
                STATE.revenues = STATE.revenues || [];
                STATE.revenues.unshift(revenuePayload);
                saveStateToLocalStorageCache();
                updateUI();
                if (typeof showToast === 'function') {
                    showToast(`✅ Lokal gespeichert (Offline). Wird synchronisiert sobald online.`, 'info');
                }
                closeReceiptScanner();
            }
        } catch (e) {
            console.error('Save error:', e);
            alert('Fehler beim Speichern des Umsatzes: ' + e.message);
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = '💾 Umsatz buchen';
            }
        }
    };

})();
