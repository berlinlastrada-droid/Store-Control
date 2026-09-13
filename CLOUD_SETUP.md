# ☁️ StoreControl Pro 2.0 – Cloud-Setup & Smartphone-Installation

Mit dieser Anleitung stellen Sie Ihren Laden-Umsatz-Manager in wenigen Minuten 24/7 online in die Cloud. 
**Ihr Computer muss danach NICHT mehr eingeschaltet sein.** Sie und Ihre Mitarbeiter können die App von überall auf der Welt über 5G/Mobilfunk, WLAN und PC aufrufen.

---

## 🚀 Option 1: Kostenloses / Günstiges 24/7 Cloud-Hosting (Render.com)

[Render.com](https://render.com) bietet extrem zuverlässiges Hosting mit Servern in **Frankfurt (Deutschland)**, automatischer SSL-Verschlüsselung (HTTPS) und persistentem Daten-Speicher.

### Schritt-für-Schritt:
1. Erstellen Sie ein kostenloses Konto auf [https://render.com](https://render.com).
2. Laden Sie diesen Projektordner auf Ihr GitHub- oder GitLab-Konto hoch (oder nutzen Sie das Render CLI).
3. Klicken Sie in Render auf **"New +"** → **"Web Service"** und wählen Sie Ihr Repository aus.
4. Render erkennt die vorbereitete Datei [`render.yaml`](file:///C:/Users/esadb/Desktop/La%20Strada/laden-umsatz-manager/render.yaml) bzw. das [`Dockerfile`](file:///C:/Users/esadb/Desktop/La%20Strada/laden-umsatz-manager/Dockerfile) automatisch.
5. Klicken Sie auf **"Deploy"**.
6. Nach ca. 2 Minuten erhalten Sie Ihre persönliche, sichere Internetadresse:
   ```text
   https://storecontrol-xxxx.onrender.com
   ```
7. Fertig! Diese Adresse ist weltweit 24 Stunden am Tag erreichbar – Ihr PC kann ausgeschaltet bleiben.

---

## 🌐 Eigene Domain verbinden (z. B. `manager.meine-domain.de`)

Wenn Sie eine eigene Web-Adresse nutzen möchten:
1. Öffnen Sie in Render.com (oder Railway) die Einstellungen Ihres Web Services → **"Custom Domains"**.
2. Geben Sie Ihre Wunsch-Domain ein (z. B. `manager.la-strada-schuhe.de`).
3. Fügen Sie bei Ihrem Domain-Anbieter (Strato, Ionos, Cloudflare etc.) einen einfachen `CNAME`-Eintrag hinzu, der auf Ihre Render-URL zeigt.
4. Das SSL-Zertifikat (HTTPS) wird automatisch innerhalb von 60 Sekunden kostenlos eingerichtet.

---

## 📱 Als echte App auf dem Smartphone installieren (PWA)

StoreControl Pro ist als **Progressive Web App (PWA)** programmiert. Sie müssen die App nicht aus dem App-Store laden, sondern installieren sie direkt über den Browser:

### Auf dem iPhone / iPad (Apple iOS):
1. Öffnen Sie Ihre Cloud-URL in **Safari** (z. B. `https://ihre-app.onrender.com`).
2. Tippen Sie unten auf das **Teilen-Symbol** (Viereck mit Pfeil nach oben).
3. Scrollen Sie nach unten und wählen Sie **"Zum Home-Bildschirm"**.
4. Tippen Sie oben rechts auf **"Hinzufügen"**.
5. Auf Ihrem Startbildschirm erscheint das **StoreControl App-Symbol**.
6. Wenn Sie darauf tippen, öffnet sich die App im **Vollbildmodus ohne Browserleiste** – genau wie eine native App aus dem App-Store!

### Auf Android (Samsung, Google Pixel, Xiaomi etc.):
1. Öffnen Sie Ihre Cloud-URL in **Google Chrome**.
2. Meist erscheint unten automatisch ein Banner: **"StoreControl Pro zum Startbildschirm hinzufügen"**.
3. Falls nicht: Tippen Sie oben rechts auf die **drei Punkte** (Menü) und wählen Sie **"App installieren"** oder **"Zum Startbildschirm hinzufügen"**.
4. Die App wird installiert und kann wie jede andere Smartphone-App geöffnet werden.

---

## 💾 Datensicherung & Migration

- **Automatischer Datenbestand:** Die 3 Filialen (**Lichtenberg**, **Grünau**, **Königs Wusterhausen**) sowie alle bestehenden Personalkosten und Mieten sind bereits fest in der Datenbank hinterlegt.
- **Manuelle Backups:** Im Tab **"Export & Setup"** können Sie jederzeit mit 1 Klick eine `.json`-Komplettsicherung herunterladen oder für das Finanzamt / die Steuerberatung saubere Excel/CSV-Dateien exportieren.
