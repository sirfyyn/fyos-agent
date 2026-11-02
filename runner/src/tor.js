/**
 * tor.js — darf Hintergrundarbeit jetzt laufen?
 *
 * Fragt regelmäßig ein Hub-Werkzeug (Vorgabe `schleifen.darf`, Schleife `arbeit`). Besitzer' Schalter
 * für Ginnys Schleifen gilt so auch für Ereignisse aus ITSM, Zeitplan und Syl; Besitzer' eigene
 * Nachrichten sind davon nicht betroffen. Antwortet der Hub nicht, bleibt das Tor zu — sicher
 * statt eifrig. Gleiches Verhalten wie `HintergrundTor` im RPC-Runner.
 */
export class HintergrundTor {
  constructor({ hub, werkzeug = 'schleifen.darf', argumente = { schleife: 'arbeit' }, pruefenS = 60, beiOeffnen, log } = {}) {
    this.hub = hub;
    this.werkzeug = werkzeug;
    this.argumente = argumente;
    this.pruefenS = Math.max(1, Number(pruefenS) || 60);
    this.beiOeffnen = beiOeffnen;
    this.log = log ?? ((z) => console.log(z));
    this.offen = false;
    this.warum = 'noch nicht geprüft';
    this.geprueft = null;
    this._timer = null;
    this._aktiv = false;
  }

  start() {
    if (this._aktiv) return;
    this._aktiv = true;
    const lauf = async () => {
      if (!this._aktiv) return;
      await this.pruefen();
      if (!this._aktiv) return;
      this._timer = setTimeout(lauf, this.pruefenS * 1000);
      this._timer.unref?.();
    };
    void lauf();
  }

  stop() {
    this._aktiv = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  async pruefen() {
    const vorher = this.offen;
    try {
      const antwort = await this.hub.aufrufen(this.werkzeug, this.argumente, { ansicht: 'voll', timeoutMs: 15_000 });
      if (!antwort.ok) throw new Error(antwort.fehler || 'Hub meldet einen Fehler');
      const ergebnis = antwort.result;
      const objekt = ergebnis && typeof ergebnis === 'object' ? ergebnis : null;
      if (!objekt) throw new Error(`Hub meldet kein Objekt: ${String(ergebnis).slice(0, 120)}`);
      this.offen = objekt.darf === true;
      this.warum = String(objekt.warum || (this.offen ? 'offen' : 'zu')).slice(0, 200);
    } catch (fehler) {
      this.offen = false;
      this.warum = `nicht prüfbar: ${String(fehler?.message ?? fehler).slice(0, 160)}`;
    }
    this.geprueft = Date.now();
    if (this.offen !== vorher) {
      this.log(`[fyos-runner] Hintergrund-Tor ${this.offen ? 'offen' : 'zu'}: ${this.warum}`);
      if (this.offen) this.beiOeffnen?.();
    }
    return this.offen;
  }

  zustand() {
    return { offen: this.offen, warum: this.warum, geprueft: this.geprueft };
  }
}
