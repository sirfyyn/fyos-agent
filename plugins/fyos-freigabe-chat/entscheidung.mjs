/**
 * entscheidung.mjs — die reine Regel: welche Chat-Antwort ist eine Freigabe?
 *
 * ## Warum es das getrennt gibt
 *
 * Der Rest des Plugins spricht HTTP (Karten holen, Kommentar schreiben, Status
 * setzen). Das ist Verdrahtung. Ob eine Nachricht ueberhaupt eine Entscheidung
 * IST, ist eine Regel — und die kann falsch sein, ohne dass etwas wirft. Also
 * steht sie hier, ohne Netz, und ist ohne Pod pruefbar (dieselbe Trennung wie
 * `freigabe.py` und `vorkommen.py` auf der Python-Seite).
 *
 * ## Der Anspruch
 *
 * Der Besitzer antwortet im Chat einfach „genehmigt“, und das reicht als Freigabe. Egal ob er
 * annimmt, ablehnt oder mit Text antwortet: die Antwort klaert die Anfrage.
 *
 * Daraus drei Ausgaenge, und der dritte ist der, der zaehlt:
 *
 *     genehmigen   die Handlung darf laufen     -> Status `in_progress`
 *     ablehnen     die Handlung laeuft nicht     -> Status `triage` (nicht `closed`)
 *     keine        alles andere: ein Kommentar am Vorgang, die Frage BLEIBT OFFEN
 *
 * ## Fail-closed, und was das hier heisst
 *
 * Der gefaehrliche Ausgang ist die Genehmigung: sie laesst eine Handlung laufen —
 * moeglicherweise eine zerstoererische. Deshalb ist die Auswahl eng, und im Zweifel
 * passiert NICHTS (nur ein Kommentar, die Frage bleibt offen — der Besitzer kann sie erneut
 * beantworten). Die Frage an einen Text lautet nicht „steht irgendwo ein Ja?",
 * sondern „IST der ganze Text ein Ja?":
 *
 *     genehmigen   der GANZE Text besteht aus Zustimmungswoertern („ja", „ok", „ja, mach",
 *                  „genehmigt"), hoechstens ergaenzt um die Kennung („genehmigt CHG-12")
 *     ablehnen     der GANZE Text ist ein Nein („nein", „nein danke", „abgelehnt CHG-12")
 *     keine        alles andere — der Regelfall fuer alles, was nach einem Satz aussieht
 *
 * `keine` ist der Wert fuer „nichts tun, Rueckfrage zeigen" (Zielstatus `null` im
 * Vertrag). Der `grund` sagt, warum. Was ein Ja NIE zu einer Genehmigung macht — jedes
 * davon schlaegt jedes Ja:
 *
 *     Frage          Fragezeichen oder Fragewort („ok, was ist das?", „passt das so?",
 *                    „ist CHG-12 schon freigegeben?", „kannst du das erklaeren")
 *     Vorbehalt      „ja, aber warum", „ok, warte kurz", „ja, nur nach Feierabend"
 *     Verneinung     „nicht genehmigt", „nichts freigegeben", „keine Freigabe"
 *     Kommentar      `kommentar CHG-12: ok` — so steht es in der Anfrage, und ein
 *                    Kommentar ist keine Entscheidung
 *     Widerspruch    „nein, doch genehmigt" — wer sich widerspricht, hat nicht
 *                    entschieden. Auch ein Nein loest einen Statuswechsel aus
 *                    (`triage`) und darf nicht geraten werden.
 *
 * Eine frueher Fassung liess ein starkes Ja an jeder Stelle des Satzes zaehlen, ein kurzes Ja
 * bei bis zu vier Woertern, und beachtete Fragen nicht. „ok, was ist das?", „passt das so?"
 * und „ist CHG-12 schon freigegeben?" haben so bei genau einer offenen Freigabe genehmigt.
 * Diese Faelle stehen mit im Test — sie sind der Grund fuer die Form der Regel.
 */

/**
 * Wie eine Entscheidung aufs Board wirkt — aus dem VERTRAG, nicht hier.
 *
 * Eine eigene Kopie (`{genehmigen: 'in_progress', ablehnen: 'triage'}`) waere eine zweite
 * Wahrheit neben dem Dienst, zusammengehalten nur von einem Kommentar. Deshalb liest diese
 * Datei `vertrag.mjs`, und das liest dieselbe JSON wie jede andere Sicht.
 * Drift ist damit nicht mehr eine Frage der Sorgfalt.
 */
import {ZIEL as ENTSCHEIDUNGEN, KENNUNG as KENNUNG_VERTRAG} from './vertrag.mjs';

export {ENTSCHEIDUNGEN};

/**
 * Die Form einer Kennung — aus dem VERTRAG (`kennung.form`), nicht hier nachgebaut.
 *
 * Fail-closed schon beim Laden: ein fehlendes oder nicht verankertes Muster wuerde
 * jedes Wort zur „Kennung" machen, und die Whitelist unten liesse dann alles durch.
 */
const KENNUNG = (() => {
  const form = KENNUNG_VERTRAG?.form;
  if (typeof form !== 'string' || !form.startsWith('^') || !form.endsWith('$')) {
    throw new Error('freigabe_vertrag.json: kennung.form fehlt oder ist nicht verankert (^…$)');
  }
  return new RegExp(form, 'i');
})();

const ist_kennung = (wort) => KENNUNG.test(wort);

/**
 * Eindeutige Zustimmungswoerter — „ich genehmige das" ist so klar wie „genehmigt".
 * Auch sie zaehlen nur, wenn der GANZE Text ein Ja ist (`ist_zustimmung`), nicht mehr
 * an jeder Stelle des Satzes: „ist CHG-12 schon freigegeben?" ist eine Frage.
 */
const JA_STARK = new Set([
  'genehmigt',
  'genehmige',
  'genehmigen',
  'erteilt',
  'erteile',
  'erteilen',
  'freigegeben',
  'freigeben',
  'vollfreigabe',
  'vollfreigegeben',
  'einverstanden',
]);

/**
 * Kurze, mehrdeutige Woerter. Sie zaehlen NUR, wenn sie die ganze Antwort sind
 * (oder nur mit anderen Zustimmungswoertern kombiniert): „ja" und „ja, mach" sind
 * eine Entscheidung, „ja, aber …" und „passt das so?" sind ein Satz.
 */
const JA_SCHWACH = new Set(['ja', 'ok', 'okay', 'go', 'passt', 'mach', 'los', 'gerne', 'gern']);

/** Hoefliches Beiwerk, das ein Ja nicht veraendert: „ja bitte", „passt so". */
const BEIWERK = new Set(['bitte', 'so']);

/**
 * Beiwerk, das nur NEBEN einem starken Ja stehen darf: „ich genehmige das",
 * „genehmigt, danke". Neben einem kurzen Ja macht es aus der Antwort etwas anderes —
 * „passt das so" ist eine Frage, „ok danke" eine Kenntnisnahme.
 */
const BEIWERK_STARK = new Set(['ich', 'das', 'es', 'dies', 'hiermit', 'danke']);

/** Ausdrueckliche Ablehnung. Darf nie als Zustimmung gelesen werden. */
const NEIN = new Set([
  'abgelehnt',
  'ablehnen',
  'ablehnung',
  'nein',
  'stop',
  'stopp',
  'verweigert',
  'verweigern',
]);

/**
 * Verneinungen. Sie entscheiden nicht selbst — sie machen aus einem Ja ein
 * „keine Entscheidung". Das ist der wichtigen Teil: „nicht genehmigt" darf
 * niemals als Genehmigung durchgehen, und es ist auch keine Ablehnung (vielleicht
 * fehlt nur Information).
 */
const VERNEINUNG = new Set(['nicht', 'nichts', 'nie', 'niemals', 'kein', 'keine', 'ohne']);

/**
 * Woerter, die ein Ja einschraenken, aufschieben oder zurueckziehen: „ja, aber …",
 * „warte kurz", „ok, nur nach Feierabend", „lass mal". Die Whitelist in
 * `ist_zustimmung` laesst sie ohnehin nicht durch; sie stehen hier, damit der Grund
 * ehrlich `vorbehalt` heisst — und damit ein spaeter erweitertes Zustimmungswort nie
 * neben einem Vorbehalt genehmigt.
 */
const VORBEHALT = new Set([
  'aber', 'lieber', 'lass', 'lasse', 'lassen', 'warte', 'warten', 'moment',
  'sondern', 'jedoch', 'allerdings', 'doch', 'nur', 'erst', 'wenn', 'falls',
  'sofern', 'solange', 'sobald', 'bevor', 'vorerst', 'spaeter', 'oder',
  'vielleicht', 'eventuell', 'hm', 'hmm', 'hmmm', 'naja', 'aeh', 'aehm',
  'nee', 'noe', 'nope',
]);

/**
 * Ein ausdruecklicher Kommentar. Die Anfrage nennt ihn als eigenen Weg
 * (`kommentar CHG-123: …`); er ist nie eine Entscheidung, auch wenn im Kommentar
 * „ok" oder „nein" steht.
 */
const KOMMENTAR = new Set(['kommentar', 'kommentiere', 'kommentieren', 'anmerkung']);

/**
 * Fragewoerter (W-Fragen und indirekte Fragen). Ein Text mit einem davon ist eine
 * Frage — „ok, was ist das?" ist keine Freigabe, auch wenn das Fragezeichen fehlt.
 * Umlaute stehen in der Umschrift (`umschrift`): „wofuer" gilt auch fuer „wofür".
 */
const W_WOERTER = new Set([
  'was', 'warum', 'wieso', 'weshalb', 'weswegen', 'wer', 'wen', 'wem', 'wessen',
  'wie', 'wieviel', 'wieviele', 'wann', 'wo', 'wohin', 'woher', 'wofuer', 'wozu',
  'womit', 'wodurch', 'wovon', 'worauf', 'woran', 'woraus', 'worin', 'worueber',
  'welche', 'welcher', 'welches', 'welchem', 'welchen', 'inwiefern', 'inwieweit',
  'ob',
]);

/**
 * Verben, mit denen eine Ja/Nein-Frage beginnt: „ist das freigegeben", „kannst du das
 * erklaeren", „hast du das geprueft". Die Liste ist absichtlich weit und zaehlt an
 * jeder Stelle des Textes, nicht nur am Anfang: ein Satz mit so einem Verb ist nie
 * eine eindeutige Zustimmung. Trifft es einmal eine Aussage („das ist freigegeben"),
 * kostet das eine Rueckfrage — der billigere Fehler.
 *
 * `passt` steht bewusst NICHT hier, weil es selbst ein Ja ist. „passt das so" faengt
 * die Whitelist ab (`ist_zustimmung`): `das` darf nur neben einem starken Ja stehen.
 */
const FRAGE_VERBEN = new Set([
  'ist', 'sind', 'bist', 'war', 'waren', 'wird', 'werden', 'wuerde', 'wuerdest', 'wuerden',
  'kann', 'kannst', 'koennen', 'koennt', 'koennte', 'koenntest', 'koennten',
  'darf', 'darfst', 'duerfen', 'duerfte', 'soll', 'sollst', 'sollen', 'sollte', 'solltest',
  'muss', 'musst', 'muessen', 'muesste', 'gibt', 'gibts', 'hast', 'hat', 'habt', 'haben',
  'geht', 'gehts', 'stimmt', 'reicht',
]);

/** Woerter, die eine Frage ankuendigen: „ich habe eine Frage zu …". */
const FRAGE_NOMEN = new Set(['frage', 'fragen', 'rueckfrage']);

/** Ein Fragezeichen — auch in den Formen, die Tastaturen und Chat-Clients liefern. */
const FRAGEZEICHEN = /[?？﹖⁇⁈⁉‽¿❓❔]/u;

/** Symbole, die nein sagen: ein „ja ❌" ist kein Ja. */
const NEIN_SYMBOLE = /[❌❎🚫⛔🛑👎✖✗✘]/u;

/** Beiwerk in einer Ablehnung: „nein danke", „nein, so nicht", „abgelehnt, bitte". */
const BEIWERK_NEIN = new Set(['bitte', 'danke', 'so', 'ich', 'das', 'es', 'dies', 'hiermit']);

/** Ersetzt Umlaute durch ihre Umschrift — getippt wird „koennte" genauso wie „könnte". */
const umschrift = (wort) => wort.replace(/[äöüß]/g, (c) => ({ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss'})[c]);

/**
 * Zerlegt Text in vergleichbare Woerter. Umlaute bleiben, Satzzeichen und Emojis
 * fallen weg. Bindestriche bleiben INNEN (`chg-12`), am Rand fallen sie weg — sonst
 * waere ein „ja - mach" das Wort `-` und kein Ja mehr.
 */
export function woerter(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map((wort) => wort.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

/** Steht direkt vor Stelle `i` eine Verneinung? („nicht genehmigen": `genehmigen` ist verneint.) */
function verneint_bei(w, i) {
  return i > 0 && VERNEINUNG.has(w[i - 1]);
}

/**
 * Ist der GANZE Text ein Ja?
 *
 * Whitelist statt Suche: jedes Wort muss ein Zustimmungswort, hoefliches Beiwerk oder
 * die Kennung sein, und mindestens eines muss ein Zustimmungswort sein. Ein Wort, das
 * die Liste nicht kennt, macht aus dem Text einen Satz — und ein Satz ist keine
 * Entscheidung. Das ist die Richtung, die im Zweifel nichts genehmigt: ein vergessenes
 * Wort kostet eine Rueckfrage, ein vergessenes Verbot kostet eine Freigabe.
 */
function ist_zustimmung(w) {
  const stark = w.some((t) => JA_STARK.has(t));
  const ja = stark || w.some((t) => JA_SCHWACH.has(t));
  const erlaubt = (t) =>
    ist_kennung(t) ||
    JA_STARK.has(t) ||
    JA_SCHWACH.has(t) ||
    BEIWERK.has(t) ||
    (stark && BEIWERK_STARK.has(t));
  return ja && w.every(erlaubt);
}

/**
 * Ist der GANZE Text ein Nein? Dieselbe Whitelist-Haltung, spiegelverkehrt: ein
 * ausdrueckliches Nein-Wort, sonst nur Beiwerk, Verneinungen und die Kennung.
 *
 * Zwei Feinheiten, an denen die Ablehnung sonst kippt:
 *
 *     „nein, das nicht genehmigen"   ein VERNEINTES Ja passt zu einem Nein
 *     „nein, doch genehmigt"         ein Ja ohne Verneinung widerspricht ihm
 *     „nicht abgelehnt"              ein verneintes Nein ist KEIN Nein
 */
function ist_ablehnung(w) {
  let nein = false;
  for (let i = 0; i < w.length; i += 1) {
    const t = w[i];
    if (NEIN.has(t)) {
      if (verneint_bei(w, i)) return false;
      nein = true;
    } else if (JA_STARK.has(t) || JA_SCHWACH.has(t)) {
      if (!verneint_bei(w, i)) return false;
    } else if (!(ist_kennung(t) || VERNEINUNG.has(t) || BEIWERK_NEIN.has(t))) {
      return false; // ein fremdes Wort: das ist mehr als ein Nein
    }
  }
  return nein;
}

/**
 * Die Entscheidung zu einer Nachricht.
 *
 * @returns {{art: 'genehmigen'|'ablehnen'|'keine', grund: string}}
 *
 * Bei `keine` sagt der `grund`, warum nichts entschieden wurde:
 *
 *     leere_nachricht         kein Wort
 *     kommentar               `kommentar CHG-12: …` — ausdruecklich keine Entscheidung
 *     frage                   Fragezeichen oder Fragewort
 *     mehrere_kennungen       zwei Vorgaenge im Text
 *     widerspruch             Nein UND Ja im selben Text („nein, doch genehmigt")
 *     nein_nicht_eindeutig    ein Nein, aber nicht als ganze Antwort („nein, morgen frueh")
 *     ja_ist_verneint         „nicht genehmigt"
 *     vorbehalt               „ja, aber …", „warte", „spaeter"
 *     ja_nicht_eindeutig      ein Ja, aber nicht als ganze Antwort („ok, dann los")
 *     kein_entscheidungswort  nichts von alledem
 *
 * Alles ausser `leere_nachricht`, `kommentar` und `kein_entscheidungswort` ist eine
 * Nachricht, die nach Entscheidung aussah und keine war — dort zeigt der Aufrufer eine
 * Rueckfrage (`antwort_text`), damit der Besitzer sein „ok, aber …" nicht fuer erteilt haelt.
 */
export function entscheide(text) {
  const roh = String(text ?? '');
  const w = woerter(roh).map(umschrift);
  if (w.length === 0) return { art: 'keine', grund: 'leere_nachricht' };

  const treffer = (menge) => w.some((t) => menge.has(t));

  // Ein ausdruecklicher Kommentar entscheidet nie — auch nicht mit „ok" darin.
  if (treffer(KOMMENTAR)) return { art: 'keine', grund: 'kommentar' };

  // Eine Frage ist keine Antwort. Das schlaegt alles Folgende, und zwar vor dem Ja:
  // „ok, was ist das?" und „ist CHG-12 schon freigegeben?" enthalten ein Zustimmungswort
  // und sind trotzdem das Gegenteil einer Zustimmung.
  if (FRAGEZEICHEN.test(roh) || treffer(W_WOERTER) || treffer(FRAGE_VERBEN) || treffer(FRAGE_NOMEN)) {
    return { art: 'keine', grund: 'frage' };
  }

  // Zwei Kennungen sind zwei Vorgaenge. Eine Entscheidung gilt genau einem.
  if (new Set(w.filter(ist_kennung)).size > 1) return { art: 'keine', grund: 'mehrere_kennungen' };

  const nein = treffer(NEIN) || NEIN_SYMBOLE.test(roh);
  const ja = treffer(JA_STARK) || treffer(JA_SCHWACH);
  const verneint = treffer(VERNEINUNG);
  const vorbehalt = treffer(VORBEHALT);

  // Ein eindeutiges Nein. Es loest keinen Lauf aus — im schlimmsten Fall muss der Besitzer
  // erneut antworten, und das ist der billigere Fehler. Aber auch das Nein muss die
  // GANZE Antwort sein: „nein, morgen frueh" ist kein Nein, sondern ein Aufschub.
  if (!vorbehalt && ist_ablehnung(w)) return { art: 'ablehnen', grund: 'ausdrueckliches_nein' };

  // Ein eindeutiges Ja: nur wenn der GANZE Text eins ist. Jede Bedingung steht hier
  // einzeln — auch die, die die Whitelist schon mitbringt —, damit ein spaeter
  // erweitertes Zustimmungswort nie neben einer Verneinung, einem Nein oder einem
  // Vorbehalt genehmigt.
  if (ja && !nein && !verneint && !vorbehalt && ist_zustimmung(w)) {
    return { art: 'genehmigen', grund: treffer(JA_STARK) ? 'klares_ja' : 'kurzes_ja' };
  }

  // Ab hier steht fest: KEINE Entscheidung. Es bleibt, den Grund ehrlich zu benennen.
  // Der Aufrufer schreibt die Nachricht als Kommentar an den Vorgang; die Frage
  // bleibt offen.
  if (nein && ja) return { art: 'keine', grund: 'widerspruch' };
  if (nein) return { art: 'keine', grund: 'nein_nicht_eindeutig' };
  // „nicht genehmigt" ist keine Zustimmung und keine Ablehnung — es fehlt etwas.
  if (ja && verneint) return { art: 'keine', grund: 'ja_ist_verneint' };
  if (vorbehalt) return { art: 'keine', grund: 'vorbehalt' };
  if (ja) return { art: 'keine', grund: 'ja_nicht_eindeutig' };
  return { art: 'keine', grund: 'kein_entscheidungswort' };
}

/**
 * Welcher Vorgang gemeint ist.
 *
 * Es kann mehr als eine Freigabe offen sein. Dann ist die Auswahl selbst eine
 * Entscheidung und darf nicht geraten werden:
 *
 *     genau eine offen             -> diese
 *     Kennung im Text              -> genau diese (auch bei mehreren)
 *     mehrere, keine Kennung       -> NICHT handeln; der Aufrufer fragt nach
 *     Kennung, die nicht offen ist -> NICHT handeln; nie auf den einzigen offenen
 *                                     Vorgang umbiegen
 *
 * Eine falsche Zuordnung waere die schlimmste Form: eine Freigabe, die auf einen
 * anderen Vorgang wirkt als den, den der Besitzer gelesen hat. „CHG-99 genehmigt" darf deshalb
 * nicht CHG-12 freigeben, nur weil CHG-12 die einzige offene Freigabe ist: der Besitzer hat
 * einen anderen Vorgang gemeint, und ein Ja zu diesem gilt nicht fuer jenen.
 *
 * @param {Array<{id: string, waiting_for?: string}>} offene
 * @param {string} text
 */
export function waehle_vorgang(offene, text) {
  const liste = Array.isArray(offene) ? offene.filter((t) => t && t.id) : [];
  if (liste.length === 0) return { fehler: 'keine_offen' };

  const w = woerter(text);
  const offen_ids = new Set(liste.map((t) => String(t.id).toLowerCase()));
  const genannt = liste.filter((t) => w.includes(String(t.id).toLowerCase()));
  // Kennungen im Text, die KEINE offene Freigabe tragen (verschrieben, erledigt, fremd).
  const fremd = [...new Set(w.filter((t) => ist_kennung(t) && !offen_ids.has(t)))];

  if (genannt.length + fremd.length > 1) return { fehler: 'mehrere_genannt' };
  if (fremd.length === 1) return { fehler: 'kennung_nicht_offen' };
  if (genannt.length === 1) return { ticket: genannt[0] };

  if (liste.length === 1) return { ticket: liste[0] };
  return { fehler: 'mehrere_offen' };
}

/**
 * `keine`-Gruende, die nur „ein Kommentar" heissen — kein Anlass fuer eine Rueckfrage.
 * Jeder andere Grund (`frage`, `vorbehalt`, `widerspruch`, …) ist eine Nachricht, die
 * nach Entscheidung aussah und keine war.
 */
const NUR_NOTIZ = new Set(['kommentar', 'kein_entscheidungswort', 'leere_nachricht']);

/** Die Antwort, die der Besitzer im Chat sieht. Ohne Modellaufruf. */
export function antwort_text(vorgang, entscheidung, grund) {
  if (entscheidung === 'genehmigen') {
    return `Freigegeben: ${vorgang} steht auf \`in_progress\` — der Lauf geht weiter.`;
  }
  if (entscheidung === 'ablehnen') {
    return `Abgelehnt: ${vorgang} ist zurueck auf \`triage\`. Die Handlung laeuft nicht.`;
  }
  if (grund === 'mehrere_offen') return 'Es sind mehrere Freigaben offen — nenne die Kennung (z. B. `CHG-123`).';
  if (grund === 'mehrere_genannt') return 'Du hast mehrere Kennungen genannt — nenne genau eine.';
  if (grund === 'kennung_nicht_offen') return 'Die genannte Kennung ist keine offene Freigabe — nenne eine offene (z. B. `CHG-123`).';
  if (grund === 'keine_offen') return 'Dazu ist gerade keine Freigabe offen.';
  // Die Rueckfrage. Sie sagt AUSDRUECKLICH, dass nichts freigegeben wurde — sonst hielte
  // der Besitzer sein „ok, aber …" fuer erteilt und wuerde auf einen Lauf warten, der nie kommt.
  if (grund && vorgang && !NUR_NOTIZ.has(grund)) {
    return `Notiert am Vorgang ${vorgang} — aber das war keine eindeutige Entscheidung, es wurde nichts freigegeben. Die Freigabe bleibt offen; antworte mit „genehmigt ${vorgang}" oder „abgelehnt ${vorgang}".`;
  }
  return `Notiert am Vorgang ${vorgang} — die Freigabe bleibt offen. Entscheide mit „genehmigt" oder „abgelehnt".`;
}
