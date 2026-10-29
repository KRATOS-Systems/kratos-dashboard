# Klick-Demos aufnehmen

Die Bilder und Texte unter public/anleitung entstehen automatisch: Test-Odoo und App starten, die App in Chrome durchklicken und bei jedem Schritt Bild und markierte Stelle speichern. Nur Demo-Daten.

    npm i --no-save puppeteer-core   (einmalig, nicht in package.json)
    npm run build
    node scripts/anleitung/run.mjs          alle Demos
    node scripts/anleitung/run.mjs fraesen  eine Demo

Die Abläufe stehen in demos.mjs, die Hilfsfunktionen in lib.mjs. Ändert sich die App, die Demo neu aufnehmen.
