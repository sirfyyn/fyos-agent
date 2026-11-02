import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Spielmodus, markeAbgelaufen, pidLebt } from '../src/spielmodus.js';

test('ohne Marke ist der Spielmodus aus', () => {
  const s = new Spielmodus(['/var/lib/spielmodus.kid'], { existiert: () => false, log: () => {} });
  assert.equal(s.an(), false);
  assert.equal(s.grund(), null);
});

test('eine Marke ohne Endzeit gilt allein durch ihre Existenz', () => {
  const s = new Spielmodus(['/var/lib/spielmodus.kid'], {
    existiert: () => true,
    lesen: () => {
      throw new Error('keine .bis');
    },
    log: () => {},
  });
  assert.equal(s.an(), true);
  assert.equal(s.grund(), 'spielmodus.kid');
});

test('abgelaufene kid-Marke gilt als vorbei und meldet sich einmal', () => {
  const meldungen = [];
  const s = new Spielmodus(['/var/lib/spielmodus.kid'], {
    existiert: () => true,
    lesen: () => '1000',
    jetzt: () => 2000,
    log: (z) => meldungen.push(z),
  });
  assert.equal(s.an(), false);
  assert.equal(s.an(), false);
  assert.equal(meldungen.length, 1);
  assert.match(meldungen[0], /abgelaufen/);
});

test('noch nicht abgelaufene kid-Marke gilt', () => {
  const s = new Spielmodus(['/var/lib/spielmodus.kid'], {
    existiert: () => true,
    lesen: () => '5000',
    jetzt: () => 2000,
    log: () => {},
  });
  assert.equal(s.an(), true);
});

test('nachhut-Marke ohne lebenden Prozess gilt als vorbei', () => {
  const s = new Spielmodus(['/var/lib/spielmodus.nachhut'], {
    existiert: () => true,
    lesen: () => '4242',
    kill: () => {
      const e = new Error('ESRCH');
      e.code = 'ESRCH';
      throw e;
    },
    log: () => {},
  });
  assert.equal(s.an(), false);
});

test('nachhut-Marke mit lebendem Prozess gilt', () => {
  const s = new Spielmodus(['/var/lib/spielmodus.nachhut'], {
    existiert: () => true,
    lesen: () => '4242',
    kill: () => true,
    log: () => {},
  });
  assert.equal(s.an(), true);
});

test('pidLebt: fremder Benutzer (EPERM) zählt als lebendig, Müll als tot', () => {
  const eperm = () => {
    const e = new Error('EPERM');
    e.code = 'EPERM';
    throw e;
  };
  assert.equal(pidLebt('x', { lesen: () => '1', kill: eperm }), true);
  assert.equal(pidLebt('x', { lesen: () => 'abc', kill: () => true }), false);
  assert.equal(pidLebt('x', { lesen: () => '-3', kill: () => true }), false);
});

test('markeAbgelaufen ohne lesbare Endzeit ist falsch', () => {
  assert.equal(
    markeAbgelaufen('/x', {
      lesen: () => {
        throw new Error('weg');
      },
    }),
    false,
  );
});

test('die erste geltende Marke gewinnt, eine veraltete davor wird übersprungen', () => {
  const s = new Spielmodus(['/var/lib/spielmodus.nachhut', '/var/lib/fyos-agent/pause'], {
    existiert: () => true,
    lesen: () => 'kaputt',
    log: () => {},
  });
  assert.equal(s.grund(), 'pause');
});
