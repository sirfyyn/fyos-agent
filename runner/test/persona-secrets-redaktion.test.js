/**
 * Secrets wie Claude (Besitzer 26.10.2026): Persona darf Secret-Werte benutzen, aber nie ausgeben. Diese Tests prüfen die Schwärzung der
 * Werkzeugausgabe mit Attrappen (kein echter Wert, kein Clusterzugriff): Kubernetes-Secrets als yaml, json, jsonpath, go-template,
 * Dekodierung, das Weiterreichen in einen Verbraucher und die Muster für Token, Passwort, Schlüssel, Bearer, JWT, Hex und Base64.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ERSATZ,
  SECRET_AUSGABE_ERSATZ,
  ausgabeFormat,
  ausgabeGanzSchwaerzen,
  befehlTeile,
  ergebnisSchwaerzen,
  kubectlVerb,
  lesendeTeile,
  redaktionHooks,
  schwaerzen,
  secretObjekteSchwaerzen,
} from '../src/persona/redaktion.js';

// Attrappen: kommen nur in diesen Tests vor.
const KLAR = 'Wegwerf-Testwert-4711-nur-Attrappe';
const B64 = Buffer.from(KLAR).toString('base64');
const B64_ZWEI = Buffer.from('Zweiter-Wegwerf-Wert-0815').toString('base64');

const YAML = `apiVersion: v1
data:
  token: ${B64}
  passwort: ${B64_ZWEI}
kind: Secret
metadata:
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"v1","data":{"token":"${B64}"},"kind":"Secret"}
  creationTimestamp: "2026-10-26T08:00:00Z"
  name: attrappe-geheimnis
  namespace: fyos
type: Opaque
`;

const JSON_TEXT = JSON.stringify(
  {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'attrappe-geheimnis', namespace: 'fyos', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': `{"data":{"token":"${B64}"}}` } },
    data: { token: B64, passwort: B64_ZWEI },
    type: 'Opaque',
  },
  null,
  2,
);

const roh = (text) => assert.ok(!text.includes(B64) && !text.includes(B64_ZWEI) && !text.includes(KLAR), 'Secret-Wert ist noch im Text');

test('yaml: data-Werte und last-applied weg, Namen und Metadaten bleiben', () => {
  const aus = schwaerzen(YAML, { befehl: 'kubectl -n fyos get secret attrappe-geheimnis -o yaml' });
  roh(aus);
  assert.match(aus, /token: \[geschwärzt\]/);
  assert.match(aus, /passwort: \[geschwärzt\]/);
  assert.match(aus, /name: attrappe-geheimnis/);
  assert.match(aus, /namespace: fyos/);
  assert.match(aus, /kind: Secret/);
});

test('json: data-Werte und last-applied weg, Form bleibt gültiges JSON', () => {
  const aus = schwaerzen(JSON_TEXT, { befehl: 'kubectl get secret attrappe-geheimnis -n fyos -o json' });
  roh(aus);
  const j = JSON.parse(aus);
  assert.equal(j.data.token, ERSATZ);
  assert.equal(j.data.passwort, ERSATZ);
  assert.equal(j.metadata.name, 'attrappe-geheimnis');
  assert.equal(j.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'], ERSATZ);
});

test('Liste mehrerer Secrets (kind: List) und abgeschnittenes JSON', () => {
  const liste = `kind: List\nitems:\n- apiVersion: v1\n  data:\n    a: ${B64}\n  kind: Secret\n  metadata:\n    name: eins\n- apiVersion: v1\n  data:\n    b: ${B64_ZWEI}\n  kind: Secret\n  metadata:\n    name: zwei\n`;
  const aus = secretObjekteSchwaerzen(liste);
  roh(aus);
  assert.match(aus, /name: eins/);
  assert.match(aus, /name: zwei/);
  const abgeschnitten = JSON_TEXT.slice(0, JSON_TEXT.indexOf(B64) + 12);
  roh(secretObjekteSchwaerzen(abgeschnitten));
});

test('stringData im Klartext und mehrzeilige Werte', () => {
  const t = `kind: Secret\nmetadata:\n  name: x\nstringData:\n  zugang: ${KLAR}\n  schluessel: |\n    zeile-eins-${KLAR}\n    zeile-zwei\n  naechster: wert-2\n`;
  const aus = secretObjekteSchwaerzen(t);
  roh(aus);
  assert.doesNotMatch(aus, /zeile-zwei/);
  assert.match(aus, /naechster: \[geschwärzt\]/);
});

test('ConfigMap ohne Secret bleibt unverändert', () => {
  const cm = 'kind: ConfigMap\ndata:\n  modus: dunkel\n  port: "8080"\n';
  assert.equal(secretObjekteSchwaerzen(cm), cm);
});

test('jsonpath und go-template, die Werte ziehen: die ganze Ausgabe fällt weg', () => {
  for (const befehl of [
    `kubectl -n fyos get secret attrappe-geheimnis -o jsonpath='{.data.token}'`,
    `kubectl get secret attrappe-geheimnis -n fyos -o jsonpath="{.data}"`,
    `kubectl get secret attrappe-geheimnis -n fyos -o go-template='{{.data.token}}'`,
    `kubectl get secrets -n fyos -o jsonpath='{.items[*].data}'`,
    `kubectl get secret attrappe-geheimnis -o jsonpath='{@}'`,
    `kubectl get secret attrappe-geheimnis -o custom-columns=T:.data.token`,
    `kubectl get secret attrappe-geheimnis -o jsonpath-file=/tmp/x`,
  ]) {
    assert.equal(schwaerzen(B64, { befehl }), SECRET_AUSGABE_ERSATZ, befehl);
  }
});

test('Dekodieren am Ende der Pipe: der Klartext fällt weg', () => {
  for (const befehl of [
    `kubectl get secret attrappe-geheimnis -n fyos -o jsonpath='{.data.token}' | base64 -d`,
    `kubectl get secret attrappe-geheimnis -n fyos -o yaml | grep token`,
    `kubectl get secret attrappe-geheimnis -n fyos -o json | jq -r .data.token | base64 --decode`,
    `echo ok; kubectl get secret a -o jsonpath='{.data.x}' | base64 -d | cat`,
  ]) {
    assert.equal(schwaerzen(KLAR, { befehl }), SECRET_AUSGABE_ERSATZ, befehl);
  }
});

test('Durchreichen von A nach B: die Ausgabe des Verbrauchers bleibt lesbar', () => {
  const durchreichen = [
    `kubectl get secret a -n fyos -o jsonpath='{.data.token}' | base64 -d | kubectl -n caddy create secret generic b --from-file=token=/dev/stdin`,
    `kubectl -n caddy create secret generic b --from-literal=token="$(kubectl get secret a -n fyos -o jsonpath='{.data.token}' | base64 -d)"`,
    `kubectl get secret a -n fyos -o yaml | kubectl apply -n fyos -f -`,
  ];
  for (const befehl of durchreichen) {
    assert.equal(schwaerzen('secret/b created', { befehl }), 'secret/b created', befehl);
    assert.equal(ausgabeGanzSchwaerzen(befehl, 'secret/b created'), false);
  }
  // Prüfen ohne Anzeigen: Hash und Vergleich
  assert.equal(schwaerzen('1 ' + 'a'.repeat(3), { befehl: `kubectl get secret a -o jsonpath='{.data.token}' | wc -c` }), '1 aaa');
  assert.equal(ausgabeGanzSchwaerzen(`kubectl get secret a -o jsonpath='{.data.token}' | grep -q Zg`, 'x'), false);
});

test('Namen, Tabellen, describe und Fehler bleiben lesbar', () => {
  const tabelle = 'NAME                 TYPE     DATA   AGE\nattrappe-geheimnis   Opaque   2      4d\n';
  assert.equal(schwaerzen(tabelle, { befehl: 'kubectl get secrets -n fyos' }), tabelle);
  assert.equal(schwaerzen('secret/attrappe-geheimnis', { befehl: 'kubectl get secrets -n fyos -o name' }), 'secret/attrappe-geheimnis');
  const spalten = 'fyos attrappe-geheimnis Opaque';
  assert.equal(
    schwaerzen(spalten, { befehl: 'kubectl get secrets -A --no-headers -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,TYPE:.type' }),
    spalten,
  );
  const describe = 'Name:  attrappe-geheimnis\nType:  Opaque\nData\n====\ntoken:     30 bytes\n';
  const beschrieben = schwaerzen(describe, { befehl: 'kubectl describe secret attrappe-geheimnis -n fyos' });
  assert.match(beschrieben, /Name:\s+attrappe-geheimnis/);
  assert.notEqual(beschrieben, SECRET_AUSGABE_ERSATZ);
  const fehler = 'Error from server (Forbidden): secrets "x" is forbidden: User "system:serviceaccount:persona-agent:persona" cannot get resource "secrets" in the namespace "kube-system"';
  assert.equal(schwaerzen(fehler, { befehl: `kubectl get secret x -n kube-system -o jsonpath='{.data}'` }), fehler);
});

test('andere Befehle mit dem Wort secret lösen nichts aus', () => {
  assert.equal(schwaerzen('ok', { befehl: 'curl -k https://git.example.net/get/secret' }), 'ok');
  assert.equal(schwaerzen('viel Text', { befehl: 'kubectl get pods; echo secrets' }), 'viel Text');
  assert.equal(lesendeTeile('kubectl get pods -n fyos').length, 0);
  assert.equal(lesendeTeile('kubectl -n fyos get secret x -o yaml').length, 1);
  assert.equal(lesendeTeile('kubectl config view --raw').length, 1);
});

test('Hilfsfunktionen: Aufteilung, Verb, Format', () => {
  assert.deepEqual(befehlTeile(`a | b; c && d || e\nf`), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(befehlTeile(`echo "a | b" | tee $(x | y)`), ['echo "a | b"', 'tee $(x | y)']);
  assert.equal(kubectlVerb('kubectl -n caddy create secret generic b'), 'create');
  assert.equal(kubectlVerb('sudo kubectl --context x get pods'), 'get');
  assert.equal(kubectlVerb('echo kubectl create'), '');
  assert.equal(ausgabeFormat('kubectl get secret x'), 'tabelle');
  assert.equal(ausgabeFormat('kubectl get secret x -o yaml'), 'strukturiert');
  assert.equal(ausgabeFormat('kubectl get secret x -ojson'), 'strukturiert');
  assert.equal(ausgabeFormat(`kubectl get secret x -o jsonpath='{.data.t}'`), 'frei');
});

test('Muster: Token, Passwort, Schlüssel, Bearer, JWT, URL, Hex, Base64', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJhdHRyYXBwZSJ9', 'c2lnbmF0dXItYXR0cmFwcGU'].join('.');
  const faelle = [
    ['Authorization: Bearer abcdefghijklmnop1234', 'Bearer [geschwärzt]'],
    [`token ${jwt}`, '[geschwärzt]'],
    ['{"access_token": "abc.def-ghi 123"}', '"access_token": "[geschwärzt]"'],
    ['{"client_secret":"s3cr3t-wert"}', '"client_secret":"[geschwärzt]"'],
    ['GITHUB_TOKEN=ghp_Ab12Cd34Ef56Gh78', 'GITHUB_TOKEN=[geschwärzt]'], // sauber: ok (Testattrappe) gitleaks:allow
    ['DB_PASSWORD="mit Leerzeichen 1"', 'DB_PASSWORD=[geschwärzt]'],
    ['SECRET_KEY=abcd1234', 'SECRET_KEY=[geschwärzt]'],
    ['AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI', 'AWS_SECRET_ACCESS_KEY: [geschwärzt]'],
    ['postgres://nutzer:geheim4711@db:5432/x', 'postgres://[geschwärzt]@db:5432/x'],
    ['client-key-data: LS0tLS1CRUdJTg==', 'client-key-data: [geschwärzt]'],
    ['sha256 ' + 'ab12'.repeat(16), 'sha256 [geschwärzt]'],
    ['wert ' + 'Ab1'.repeat(15), 'wert [geschwärzt]'],
  ];
  for (const [rein, erwartet] of faelle) assert.ok(schwaerzen(rein).includes(erwartet), `${rein} -> ${schwaerzen(rein)}`);
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG\n-----END PRIVATE KEY-----\nrest'; // sauber: ok (Testattrappe) gitleaks:allow
  assert.equal(schwaerzen(pem), `${ERSATZ}\nrest`);
  assert.equal(schwaerzen('-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef'), ERSATZ); // sauber: ok (Testattrappe)
});

test('Namen von Feldern, die nur so heißen, bleiben: secretName, secretKeyRef, tokenFile', () => {
  const t = 'secretName: fyos-agent-tokens\nsecretKeyRef:\n  name: persona-secrets\n  key: token_datei\n"secretName": "x"\ntoken_datei: pfad';
  assert.equal(schwaerzen(t), t);
});

test('normale lange Wörter, Pfade und Pod-Namen bleiben', () => {
  const t = '/var/lib/fyos-agent/durable/nachtwerkstatt/MORGENBERICHT.md persona-mail-inbox-7d9f8b6c5d-x2x4z fyos-pi-durable-dienst-laeuft-seit-vierzehn-stunden';
  assert.equal(schwaerzen(t), t);
});

test('Hook afterTool: bash mit kubectl get secret -o yaml wird vor dem Modell geschwärzt, Werkzeugname egal', async () => {
  const [h] = redaktionHooks();
  for (const name of ['bash', 'knoten_befehl']) {
    const argumente = name === 'bash' ? { command: 'kubectl get secret attrappe-geheimnis -n fyos -o yaml' } : { befehl: 'kubectl get secret attrappe-geheimnis -n fyos -o yaml' };
    const r = await h.handlers.afterTool({ name, arguments: argumente }, { output: [{ type: 'text', text: YAML }], details: { x: 1 } });
    roh(r.output[0].text);
    assert.match(r.output[0].text, /name: attrappe-geheimnis/);
    assert.deepEqual(r.details, { x: 1 });
  }
  const frei = await h.handlers.afterTool(
    { name: 'bash', arguments: { command: `kubectl get secret attrappe-geheimnis -n fyos -o jsonpath='{.data.token}'` } },
    { output: [{ type: 'text', text: B64 }], structuredOutput: { stdout: B64 } },
  );
  assert.equal(frei.output[0].text, SECRET_AUSGABE_ERSATZ);
  assert.equal(frei.structuredOutput.stdout, SECRET_AUSGABE_ERSATZ);
});

test('ergebnisSchwaerzen reicht den Befehl durch', () => {
  const neu = ergebnisSchwaerzen([{ type: 'text', text: B64 }], { befehl: `kubectl get secret x -o jsonpath='{.data.t}'` });
  assert.equal(neu[0].text, SECRET_AUSGABE_ERSATZ);
  // Leere Ausgabe bleibt leer; ein Name oder eine Tabelle des Lesebefehls auch.
  assert.equal(ergebnisSchwaerzen([{ type: 'text', text: '' }], { befehl: `kubectl get secret x -o jsonpath='{.data.t}'` }), undefined);
  assert.equal(ergebnisSchwaerzen([{ type: 'text', text: 'secret/x' }], { befehl: 'kubectl get secret x -o name' }), undefined);
});
