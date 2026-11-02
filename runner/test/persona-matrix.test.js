import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matrixWerkzeuge } from '../src/persona/matrix.js';

function werkzeug(antwort, status = 200, env = {}) {
  const aufrufe = [];
  const [t] = matrixWerkzeuge({
    env,
    fetch: async (url, init) => {
      aufrufe.push([url, JSON.parse(init.body), init]);
      return { status, json: async () => antwort };
    },
  });
  return { t, aufrufe };
}

test('sendet an den lokalen Sender, ohne Raum-Id und Token', async () => {
  const { t, aufrufe } = werkzeug({ ok: true, event_id: '$x' });
  assert.equal(t.name, 'matrix_senden');
  const r = await t.execute({ text: 'PRB-4429 gelöst', art: 'erledigt', bezug: 'PRB-4429' }, {}, {});
  assert.equal(r.output[0].text, 'Gesendet.');
  assert.equal(aufrufe[0][0], 'http://127.0.0.1:18436/senden');
  assert.equal(aufrufe[0][1].bezug, 'PRB-4429');
  assert.equal(aufrufe[0][1].dringend, false);
  assert.equal(aufrufe[0][2].method, 'POST');
  assert.equal(aufrufe[0][2].headers.authorization, undefined);
});

test('FYOS_MATRIX_URL ersetzt die Adresse, ein Schrägstrich am Ende stört nicht', async () => {
  const { t, aufrufe } = werkzeug({ ok: true }, 200, { FYOS_MATRIX_URL: 'http://sender:1/' });
  await t.execute({ text: 'x', dringend: true, raum: 'ops' }, {}, {});
  assert.equal(aufrufe[0][0], 'http://sender:1/senden');
  assert.equal(aufrufe[0][1].dringend, true);
  assert.equal(aufrufe[0][1].raum, 'ops');
});

test('Ruhezeit und Schutz melden, dass nichts gesendet wurde', async () => {
  let w = werkzeug({ ok: false, grund: 'ruhezeit 22-7' }, 409);
  assert.match((await w.t.execute({ text: 'x' }, {}, {})).output[0].text, /Nicht gesendet: ruhezeit/);
  w = werkzeug({ ok: false, grund: 'zu viele' }, 429);
  assert.match((await w.t.execute({ text: 'x' }, {}, {})).output[0].text, /Nicht gesendet: zu viele/);
  w = werkzeug({ ok: false, grund: 'raum unbekannt' }, 400);
  assert.match((await w.t.execute({ text: 'x' }, {}, {})).output[0].text, /Nicht gesendet \(400\): raum unbekannt/);
});

test('Schatten wird als Schatten gemeldet, Netzfehler als nicht erreichbar', async () => {
  assert.match((await werkzeug({ ok: true, schatten: true }).t.execute({ text: 'x' }, {}, {})).output[0].text, /Schattenbetrieb/);
  const [t] = matrixWerkzeuge({ env: {}, fetch: async () => { throw new Error('refused'); } });
  assert.match((await t.execute({ text: 'x' }, {}, {})).output[0].text, /nicht erreichbar: refused/);
});

test('Abbruch des Zugs wird an den Aufruf weitergereicht', async () => {
  const { t, aufrufe } = werkzeug({ ok: true });
  const c = new AbortController();
  await t.execute({ text: 'x' }, {}, { signal: c.signal });
  c.abort();
  assert.equal(aufrufe[0][2].signal.aborted, true);
});
