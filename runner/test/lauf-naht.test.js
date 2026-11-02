/**
 * Die Naht selbst (src/lauf/): Ereignisnamen, sichtbarer Verlauf (Fenster-Eigenheit), Handgriffe am Gespräch.
 * Der Durchgang mit echtem Harness steht in ansicht-fenster.test.js und runner.integration.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EREIGNIS, KONTEXT, abbrechen, aktivesFenster, ereignisArt, letzterEintragId, neuesteEintraege, piName, sichtbarerVerlauf, zugStarten } from '../src/lauf/index.js';

/** Ein Gespräch, dessen `entries` absteigend in Seiten von `seite` liefert (wie pi-durable) und dessen `context` nur das Fenster kennt. */
function fakeGespraech(n, { seite = 200, ab = 0 } = {}) {
  const alle = Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, kind: i + 1 === ab ? 'pi.reset' : 'x' }));
  const aufrufe = [];
  return {
    aufrufe,
    async entries(opt, limit, cursor, ctx) {
      aufrufe.push({ opt, limit, cursor, ctx });
      assert.equal(opt.order, 'descending');
      const von = cursor === undefined ? alle.length : cursor;
      const items = alle.slice(Math.max(0, von - Math.min(limit, seite)), von).reverse();
      const bis = von - items.length;
      return { items, next: bis > 0 ? bis : undefined };
    },
    async context(ctx) {
      aufrufe.push({ context: ctx });
      const ab0 = ab > 0 ? ab - 1 : 0;
      return { entries: alle.slice(ab0), messages: alle.slice(ab0).map(() => ({})) };
    },
  };
}

test('ereignisArt: pi-durable-Namen werden zu unseren, Unbekanntes und schon Übersetztes bleibt', () => {
  assert.equal(ereignisArt({ type: 'message_end' }), EREIGNIS.NACHRICHT_ENDE);
  assert.equal(ereignisArt({ type: 'tool_execution_start' }), EREIGNIS.WERKZEUG_START);
  assert.equal(ereignisArt({ type: 'run_end' }), EREIGNIS.ZUG_ENDE);
  assert.equal(ereignisArt({ type: 'snapshot' }), EREIGNIS.STAND);
  assert.equal(ereignisArt({ type: 'inbox_update' }), 'inbox_update');
  assert.equal(ereignisArt({ art: 'zug_ende', type: 'x' }), 'zug_ende');
  assert.equal(ereignisArt(null), undefined);
  for (const [name, wert] of Object.entries(EREIGNIS)) assert.ok(piName(wert), `${name} hat einen pi-durable-Namen`);
});

test('sichtbarerVerlauf: die neuesten limit Einträge aufsteigend, seitenweise, auch vor dem Reset-Marker', async () => {
  const conv = fakeGespraech(450, { seite: 200, ab: 400 });
  const v = await sichtbarerVerlauf(conv, { limit: 400 });
  assert.equal(v.length, 400);
  assert.equal(v[0].id, 'e51');
  assert.equal(v.at(-1).id, 'e450');
  assert.ok(v.some((e) => e.kind === 'pi.reset'));
  const seiten = conv.aufrufe.filter((a) => a.opt);
  assert.deepEqual(seiten.map((a) => a.limit), [200, 200]);
  assert.ok(seiten.every((a) => a.ctx === KONTEXT));
});

test('aktivesFenster: nur ab dem Marker; letzterEintragId und neuesteEintraege lesen durch ihn hindurch', async () => {
  const conv = fakeGespraech(10, { ab: 8 });
  const f = await aktivesFenster(conv);
  assert.equal(f.entries.length, 3);
  assert.equal(f.messages.length, 3);
  assert.equal(await letzterEintragId(conv), 'e10');
  assert.deepEqual((await neuesteEintraege(conv, 4)).map((e) => e.id), ['e10', 'e9', 'e8', 'e7']);
  assert.equal(await letzterEintragId(fakeGespraech(0)), undefined);
});

test('zugStarten und abbrechen: Optionen werden auf pi-durable übersetzt, der Kontext kommt aus der Naht', async () => {
  const gesehen = [];
  const conv = {
    async submit(arg, ctx) {
      gesehen.push({ arg, ctx });
      return { id: 7 };
    },
    async abort(ctx) {
      gesehen.push({ abort: true, ctx });
    },
  };
  const s = await zugStarten(conv, { text: 'hallo', wennBeschaeftigt: 'steuern', anfrageId: 'r1', eintrag: { art: 'fyos.mensch', daten: { a: 1 } } });
  assert.equal(s.id, 7);
  assert.deepEqual(gesehen[0].arg, { type: 'input', content: 'hallo', whenBusy: 'steer', requestId: 'r1', entry: { kind: 'fyos.mensch', data: { a: 1 } } });
  assert.equal(gesehen[0].ctx, KONTEXT);
  await zugStarten(conv, { text: 'x', wennBeschaeftigt: 'abweisen', anfrageId: 'r2' });
  assert.equal(gesehen[1].arg.whenBusy, 'reject');
  assert.equal('entry' in gesehen[1].arg, false);
  await zugStarten(conv, { text: 'y', anfrageId: 'r3' });
  assert.equal(gesehen[2].arg.whenBusy, 'followUp');
  await abbrechen(conv);
  assert.deepEqual(gesehen[3], { abort: true, ctx: KONTEXT });
});
