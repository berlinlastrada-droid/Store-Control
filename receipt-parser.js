/**
 * StoreControl Pro - Targeted German POS Z-Report (Tagesabschluss) Parser Engine
 * Universally compatible: Works in Node.js backend AND browser frontend.
 * 
 * Targeted Rules:
 * 1. Umsätze:
 *    - BAR TOTAL: Ausschließlich der Betrag bei "BAR TOTAL". Wenn nicht vorhanden -> 0,00 €.
 *    - EC Karte TOTAL: Betrag bei "EC Karte TOTAL".
 *    - GESAMTUMSATZ: Betrag bei "SCHUBLADEN TOTAL" (maßgeblicher Gesamtumsatz).
 * 2. Datum:
 *    - Immer das Datum des aktuellen Kassenbons ganz oben, direkt bei der Filialadresse.
 *    - "LETZTER BERICHT" und alle vorherigen Berichtsdatumsangaben werden strikt ignoriert.
 *    - Das Datum des aktuellen Bons hat immer Vorrang.
 * 3. Filialerkennung:
 *    - Bruno-Taut-Straße 1 (Grünau)
 *    - Volkradstraße 32 (Lichtenberg)
 *    - Cottbuser Straße 41 (Königs Wusterhausen)
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ReceiptParser = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    function parseGermanAmount(str) {
        if (!str) return 0;
        let clean = str.replace(/[^\d,\.\-]/g, '').trim();
        if (clean.includes(',') && clean.includes('.')) {
            clean = clean.replace(/\./g, '').replace(',', '.');
        } else if (clean.includes(',')) {
            clean = clean.replace(',', '.');
        }
        const val = parseFloat(clean);
        return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    }

    function extractAmountFromLine(line) {
        if (!line) return 0;
        // Replace pound sign (£ is often OCR's misread of €) and euro sign
        let cleanLine = line.replace(/[€£$]/g, ' EUR ');
        // Normalize OCR spaces around comma or dot (e.g. "478 . 97" or "478 , 97" -> "478.97")
        cleanLine = cleanLine.replace(/(\d+)\s*([,\.])\s*(\d{2})\b/g, '$1$2$3');
        
        // Match amounts with 2 decimals
        const matches = [...cleanLine.matchAll(/(-?\d{1,3}(?:\.\d{3})+,\d{2}|-?\d+,\d{2}|-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2})/g)];
        if (matches.length > 0) {
            return parseGermanAmount(matches[matches.length - 1][1]);
        }
        return 0;
    }

    function normalizeReceiptLine(line) {
        if (!line) return '';
        let l = line.toLowerCase().replace(/[\u2018\u2019\u201A\u201B\u2032\u2035'"]/g, '').replace(/\s+/g, ' ').trim();
        // Collapse common OCR letter-spacing
        l = l.replace(/\bb\s+a\s+r\b/g, 'bar');
        l = l.replace(/\bt\s+o\s+t\s+a\s+l\b/g, 'total');
        l = l.replace(/\bl\s+a\s+d\s+e\b/g, 'lade');
        l = l.replace(/\bg\s+e\s+s\s+a\s+m\s+t\b/g, 'gesamt');
        l = l.replace(/\bu\s+m\s+s\s+a\s+t\s+z\b/g, 'umsatz');
        l = l.replace(/\bs\s+t\s+e\s+u\s+e\s+r\b/g, 'steuer');
        l = l.replace(/\bk\s+a\s+r\s+t\s+e\b/g, 'karte');
        l = l.replace(/\bs\s*c\s*h\s*u\s*b\s*l\s*a\s*d\s*e\s*n\b/g, 'schubladen');
        return l;
    }

    function parseGermanReceiptText(text) {
        if (!text) text = '';
        const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const result = {
            storeId: null,
            storeName: null,
            storeConfidence: 0,
            date: null,
            dateConfidence: 0,
            total: 0,
            cash: 0,
            card: 0,
            other: 0,
            tax: 0,
            tax19: 0,
            tax7: 0,
            receiptNumber: null,
            transactionCount: null,
            sumCheck: 'UNKNOWN',
            isAllCard: false,
            warnings: [],
            confidence: 0,
            rawText: text
        };

        const textLower = text.toLowerCase();

        // 1. STORE RECOGNITION (Exact Match for 3 Branches)
        let scoreLichtenberg = 0;
        if (textLower.includes('volkrad')) scoreLichtenberg += 50;
        if (textLower.includes('lichtenberg')) scoreLichtenberg += 40;
        if (textLower.includes('10319')) scoreLichtenberg += 40;

        let scoreGwenau = 0;
        if (textLower.includes('bruno') || textLower.includes('taut')) scoreGwenau += 50;
        if (textLower.includes('grünau') || textLower.includes('gruenau')) scoreGwenau += 40;
        if (textLower.includes('12524')) scoreGwenau += 40;
        if (textLower.includes('32/215/00914') || textLower.includes('3221500914') || textLower.includes('de3221500914')) scoreGwenau += 50;

        let scoreKW = 0;
        if (textLower.includes('cottbus') || textLower.includes('cottbuser')) scoreKW += 50;
        if (textLower.includes('königs wusterhausen') || textLower.includes('koenigs wusterhausen') || textLower.includes('wusterhausen')) scoreKW += 40;
        if (textLower.includes('15711')) scoreKW += 40;

        if (scoreLichtenberg > scoreGwenau && scoreLichtenberg > scoreKW && scoreLichtenberg >= 30) {
            result.storeId = 'store_1788358842956_bolf';
            result.storeName = 'Volkradstraße 32 (Lichtenberg)';
            result.storeConfidence = Math.min(scoreLichtenberg, 100);
        } else if (scoreGwenau > scoreLichtenberg && scoreGwenau > scoreKW && scoreGwenau >= 30) {
            result.storeId = 'store_1788358914508_zv8v';
            result.storeName = 'Bruno-Taut-Straße 1 (Grünau)';
            result.storeConfidence = Math.min(scoreGwenau, 100);
        } else if (scoreKW > scoreLichtenberg && scoreKW > scoreGwenau && scoreKW >= 30) {
            result.storeId = 'store_1788358943648_q74l';
            result.storeName = 'Cottbuser Straße 41 (Königs Wusterhausen)';
            result.storeConfidence = Math.min(scoreKW, 100);
        } else {
            result.warnings.push('Filiale konnte anhand der Adresse nicht eindeutig erkannt werden. Bitte manuell auswählen.');
        }

        // 2. TARGETED DATE RECOGNITION
        // "Verwende immer das Datum des aktuellen Kassenbons ganz oben, direkt bei der Filialadresse.
        // Ignoriere das Datum bei „LETZTER BERICHT“ und alle anderen vorherigen Berichtsdatumsangaben.
        // Das Datum des aktuellen Bons hat immer Vorrang."

        const dateRegex = /\b([0-3]?\d)[\.\/\-]([0-1]?\d)[\.\/\-](20\d{2}|\d{2})\b/;

        // Step 2a: Blacklist lines containing "LETZTER BERICHT" or previous reports
        const blacklistIndices = new Set();
        for (let i = 0; i < rawLines.length; i++) {
            const lineLow = rawLines[i].toLowerCase();
            if (/[lh1i]?etzter\s*bericht/i.test(lineLow) || /vorherig/i.test(lineLow) || /voriger/i.test(lineLow)) {
                blacklistIndices.add(i);
                // Also ignore subsequent line if date was wrapped onto next line
                if (i + 1 < rawLines.length) blacklistIndices.add(i + 1);
            }
        }

        // Step 2b: Search TOP HEADER (lines 1 to 10, before Z1 BERICHT / FINANZ)
        // The current bon date is directly below the branch address / St.Nr.
        let headerDate = null;
        let headerDateConfidence = 0;

        for (let i = 0; i < Math.min(rawLines.length, 12); i++) {
            if (blacklistIndices.has(i)) continue;
            const line = rawLines[i];
            const lineLow = line.toLowerCase();

            // Stop before FINANZ
            if (lineLow.includes('finanz')) break;
            if (lineLow.includes('z1 bericht') || lineLow.includes('z 1 bericht')) break;

            const m = line.match(dateRegex);
            if (m) {
                let day = m[1].padStart(2, '0');
                let month = m[2].padStart(2, '0');
                let year = m[3].length === 2 ? '20' + m[3] : m[3];
                if (year === '2006') year = '2026'; // OCR 0->2 error
                const y = parseInt(year);
                if (y >= 2020 && y <= 2035) {
                    headerDate = `${year}-${month}-${day}`;
                    headerDateConfidence = (lineLow.includes('mo') || lineLow.includes('di') || lineLow.includes('mi') || lineLow.includes('do') || lineLow.includes('fr') || lineLow.includes('sa') || lineLow.includes('so') || /\d{1,2}:\d{2}/.test(line)) ? 100 : 95;
                    break;
                }
            }
        }

        if (headerDate) {
            result.date = headerDate;
            result.dateConfidence = headerDateConfidence;
        } else {
            // Fallback: search anywhere in receipt EXCEPT blacklisted lines
            for (let i = 0; i < rawLines.length; i++) {
                if (blacklistIndices.has(i)) continue;
                const line = rawLines[i];
                const m = line.match(dateRegex);
                if (m) {
                    let day = m[1].padStart(2, '0');
                    let month = m[2].padStart(2, '0');
                    let year = m[3].length === 2 ? '20' + m[3] : m[3];
                    if (year === '2006') year = '2026';
                    const y = parseInt(year);
                    if (y >= 2020 && y <= 2035) {
                        result.date = `${year}-${month}-${day}`;
                        result.dateConfidence = 85;
                        break;
                    }
                }
            }
        }

        if (!result.date) {
            result.warnings.push('Datum des Tagesabschlusses nicht eindeutig gefunden. Bitte überprüfen.');
        }

        // Helper: lookahead up to 3 lines (skips intermediate transaction counts)
        function findAmountForIndex(idx) {
            for (let offset = 0; offset <= 3; offset++) {
                const curIdx = idx + offset;
                if (curIdx >= rawLines.length) break;
                const amt = extractAmountFromLine(rawLines[curIdx]);
                if (amt > 0) return amt;
            }
            return 0;
        }

        // 3. TARGETED AMOUNTS:
        // - BAR TOTAL: Ausschließlich der Betrag bei "BAR TOTAL". Wenn dort kein Betrag steht -> 0,00 €.
        // - EC Karte TOTAL: Betrag bei "EC Karte TOTAL".
        // - GESAMTUMSATZ: Betrag bei "SCHUBLADEN TOTAL" (maßgeblicher Gesamtumsatz).
        let barTotalAmount = 0;
        let ecTotalAmount = 0;
        let schubladenTotalAmount = 0;
        let fallbackGesamtAmount = 0;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const lineLow = normalizeReceiptLine(line);

            // Z-Bericht Nummer
            if (!result.receiptNumber && (lineLow.includes('z 1') || lineLow.includes('z1') || lineLow.includes('zn bericht') || lineLow.includes('z-bericht') || lineLow.includes('z-nr') || lineLow.includes('beleg-nr'))) {
                const numMatch = line.match(/(?:bericht|nr\.?|zähler)\s*[:\s]*([a-z0-9\-_]+)/i);
                if (numMatch) result.receiptNumber = numMatch[1];
            }

            // TAX / STEUER (Isolated from revenue)
            const isTaxLine = lineLow.includes('steuer') || lineLow.includes('mwst') || lineLow.includes('ust') || lineLow.includes('tax');
            if (isTaxLine) {
                const amt = findAmountForIndex(i);
                if (amt > 0) {
                    if (lineLow.includes('19%') || lineLow.includes('19,00%')) {
                        result.tax19 = amt;
                        result.tax = amt;
                    } else if (lineLow.includes('7%') || lineLow.includes('7,00%')) {
                        result.tax7 = amt;
                        result.tax = amt;
                    } else if (lineLow.includes('steuer 1') || lineLow.includes('steuer1')) {
                        result.tax19 = amt;
                        result.tax = amt;
                    } else if (!result.tax) {
                        result.tax = amt;
                    }
                }
                continue; // Skip tax lines from revenue checks
            }

            // 1. BAR TOTAL: Ausschließlich "BAR TOTAL"
            if (lineLow.includes('bar total') || lineLow.includes('bar-total') || lineLow.includes('bartotal')) {
                const amt = findAmountForIndex(i);
                if (amt > 0) barTotalAmount = amt;
            }

            // 2. EC Karte TOTAL: "EC Karte TOTAL"
            if (
                lineLow.includes('ec karte total') ||
                lineLow.includes('ec-karte total') ||
                lineLow.includes('ec total') ||
                lineLow.includes('ec-total') ||
                (lineLow.includes('ec karte') && lineLow.includes('total')) ||
                (lineLow.startsWith('total') && rawLines[i+1] && rawLines[i+1].toLowerCase().includes('ec karte'))
            ) {
                const amt = findAmountForIndex(i);
                if (amt > 0) ecTotalAmount = amt;
            }

            // 3. SCHUBLADEN TOTAL: Maßgeblicher Gesamtumsatz
            if (
                lineLow.includes('schubladen total') ||
                lineLow.includes('schubladentotal') ||
                lineLow.includes('schubladen-total') ||
                lineLow.includes('ubladen total') ||
                lineLow.includes('ubladen tota')
            ) {
                const amt = findAmountForIndex(i);
                if (amt > 0) schubladenTotalAmount = amt;
            }

            // Backup candidate for Gesamtumsatz (only if Schubladen Total is missing)
            if (!lineLow.includes('brutto steuer') && !isTaxLine && !lineLow.includes('bar') && !lineLow.includes('karte') && !lineLow.includes('ec')) {
                if (lineLow.includes('gesamtumsatz') || lineLow.includes('gesamt-umsatz') || lineLow.includes('gesamtu')) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0) fallbackGesamtAmount = amt;
                }
            }
        }

        // Set Bar: EXCLUSIVELY the amount at "BAR TOTAL", else 0.00 €
        result.cash = barTotalAmount > 0 ? barTotalAmount : 0;

        // Set Card: Amount at "EC Karte TOTAL"
        result.card = ecTotalAmount;
        // Fallback for card if "EC Karte TOTAL" had unreadable word TOTAL
        if (result.card === 0) {
            for (let i = 0; i < rawLines.length; i++) {
                const l = normalizeReceiptLine(rawLines[i]);
                if (l.includes('ec karte in lade') || l.includes('ec in lade')) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0) {
                        result.card = amt;
                        break;
                    }
                }
            }
        }

        // Set Gesamtumsatz: Authoritatively from "SCHUBLADEN TOTAL"
        if (schubladenTotalAmount > 0) {
            result.total = schubladenTotalAmount;
        } else if (fallbackGesamtAmount > 0) {
            result.total = fallbackGesamtAmount;
        } else if (result.cash === 0 && result.card > 0) {
            result.total = result.card;
        } else if (result.cash > 0 && result.card > 0) {
            result.total = Math.round((result.cash + result.card) * 100) / 100;
        }

        // Sanity Check: If card amount exceeds total, reject corrupted amount
        if (result.total > 0 && result.card > result.total) {
            // Find alternate card line
            let altCard = 0;
            for (let i = 0; i < rawLines.length; i++) {
                const l = normalizeReceiptLine(rawLines[i]);
                if (l.includes('ec karte in lade') || l.includes('ec in lade')) {
                    const amt = findAmountForIndex(i);
                    if (amt > 0 && amt <= result.total) {
                        altCard = amt;
                        break;
                    }
                }
            }
            if (altCard > 0) {
                result.card = altCard;
            } else if (result.cash > 0 && result.cash < result.total) {
                result.card = Math.round((result.total - result.cash) * 100) / 100;
            }
        }

        // 4. Mathematical verification
        const sumPay = Math.round((result.cash + result.card) * 100) / 100;
        if (result.cash === 0 && result.card > 0) {
            result.isAllCard = true;
            if (result.total === result.card || Math.abs(result.total - result.card) <= 0.05) {
                result.sumCheck = 'MATCH';
            } else {
                result.sumCheck = 'MISMATCH';
                result.warnings.push(`Prüfen: EC-Umsatz ist ${result.card.toFixed(2)} €, Schubladen Total ist ${result.total.toFixed(2)} €.`);
            }
        } else if (result.cash > 0 && result.card > 0) {
            if (Math.abs(sumPay - result.total) <= 0.05) {
                result.sumCheck = 'MATCH';
            } else {
                result.sumCheck = 'MISMATCH';
                result.warnings.push(`Summenprüfung: Bar (${result.cash.toFixed(2)} €) + Karte (${result.card.toFixed(2)} €) = ${sumPay.toFixed(2)} €, Schubladen Total ist ${result.total.toFixed(2)} €.`);
            }
        } else if (result.total > 0 && sumPay > 0 && Math.abs(sumPay - result.total) <= 0.05) {
            result.sumCheck = 'MATCH';
        } else {
            result.sumCheck = result.total > 0 ? 'PARTIAL' : 'INCOMPLETE';
        }

        let conf = 0;
        if (result.storeId) conf += 35;
        if (result.date) conf += 25;
        if (result.total > 0) conf += 20;
        if (result.sumCheck === 'MATCH') conf += 20;
        else if (result.cash > 0 || result.card > 0) conf += 10;
        result.confidence = conf;

        return result;
    }

    return {
        parseGermanReceiptText,
        parseGermanAmount,
        extractAmountFromLine
    };
}));
