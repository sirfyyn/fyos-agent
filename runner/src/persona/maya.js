/**
 * persona/maya.js — Maya-S FLE-Engine-Bridge (ADR-216 / pi-RPC).
 *
 * Port von `fyos-maya`. Der alte Stand ist ein Beschreibungsobjekt ohne Wirkung: Maya-S (DeepSeek-V4.1-Flash,
 * CLI-Engine auf Port 18425, 262144 Kontext, Brücke /tmp/maya_bridge.py) sollte als Modell-Provider im Runner
 * stehen; `registerMcpServer` war auskommentiert, `register()` meldete nur „registered“. Hier ist es genauso:
 * die Beschreibung und die gleiche Rückmeldung, aber weder Werkzeug noch Provider. Die Engine ist eine CLI und
 * spricht nicht die OpenAI-Schnittstelle, die `models.js` für Hausmodell nutzt; ein Provider dafür ist nicht Teil
 * dieser Übernahme.
 */
export const MAYA = {
  id: 'fyos-maya',
  name: 'Maya-S FLE Bridge',
  modelPort: 18425,
  modelName: 'deepseek-v4.1-flash',
  engineType: 'cli', // CLI-Engine (anders als Hausmodell/Kat HTTP)
  maxContext: 262144,
  bridgePath: '/tmp/maya_bridge.py',
};

/** Wie `index.register()` im alten Stand: meldet nur, nichts wird angebunden. */
export function mayaRegistrieren() {
  return { status: 'registered', modelPort: MAYA.modelPort };
}

/** Maya trägt weder Werkzeuge noch Abschnitte noch Hooks bei. */
export function mayaBeitrag() {
  return { sections: [], hooks: [], tools: [] };
}
