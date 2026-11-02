"""Der echte Hub für die Vertragstests des Runners (25.10.2026, Entscheidung 583: Verträge nur gegen den echten Hub).

Echt ist, was den Vertrag ausmacht: die Routen `mcp_hub.agent.agent_routen()` (Annahme, Eingang, Arbeitsbereiche) mit den Modulen
`_agentenstrom`, `_agenteneingang` und `_arbeitsbereiche`. Ersetzt ist allein der Speicher: Redis ist hier eine kleine Attrappe
im Prozess (XADD, XREAD, XREVRANGE, SET/GET, Pipeline). Die Attrappe prüft nichts vom Vertrag; jede Ablehnung kommt aus dem Hub-Code.

Aufruf (vom Node-Test):  python3 hub_echt.py          → druckt `BEREIT <port>` und dient auf 127.0.0.1, bis er beendet wird.
Nur für die Prüfung gibt es `GET /_test/strom` (alles, was im Ausgang und im Eingang liegt); `POST /_test/zuruecksetzen` leert.
Fehlt Python-Paket oder Hub-Code, endet das Skript mit Rückgabewert 3 und einer Zeile `FEHLT <Grund>`; der Test überspringt dann
ehrlich mit diesem Grund.
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path

WURZEL = Path(__file__).resolve().parents[5]
if str(WURZEL) not in sys.path:
    sys.path.insert(0, str(WURZEL))


def _schluessel(sid: str) -> tuple[int, int]:
    a, _, b = str(sid).partition("-")
    return int(a), int(b or 0)


class SpeicherRedis:
    """Gerade genug Redis für die Agenten-Routen: Ströme im Prozess, Zeichenketten, Pipeline."""

    def __init__(self) -> None:
        self.stroeme: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.werte: dict[str, str] = {}
        self._sperre = threading.Lock()
        self._n = 0

    def xadd(self, name, felder, maxlen=None, approximate=True):
        with self._sperre:
            self._n += 1
            sid = f"{int(time.time() * 1000)}-{self._n}"
            self.stroeme.setdefault(name, []).append((sid, dict(felder)))
            return sid

    def xrevrange(self, name, count=None):
        with self._sperre:
            liste = list(reversed(self.stroeme.get(name, [])))
        return liste[:count]

    def xread(self, stroeme, count=None, block=None):
        ((name, nach),) = stroeme.items()
        grenze = _schluessel(nach)
        ende = time.time() + (block or 0) / 1000
        while True:
            with self._sperre:
                neu = [(s, f) for s, f in self.stroeme.get(name, []) if _schluessel(s) > grenze][:count]
            if neu:
                return [[name, neu]]
            if time.time() >= ende:
                return []
            time.sleep(0.05)

    def set(self, schluessel, wert):
        self.werte[schluessel] = wert

    def get(self, schluessel):
        return self.werte.get(schluessel)

    def pipeline(self, transaction=True):
        return _Pipe(self)


class _Pipe:
    def __init__(self, r: SpeicherRedis) -> None:
        self.r, self.befehle = r, []

    def xadd(self, name, felder, maxlen=None, approximate=True):
        self.befehle.append((name, felder))

    def execute(self):
        for name, felder in self.befehle:
            self.r.xadd(name, felder)
        return [True] * len(self.befehle)


def app_bauen():
    """Starlette-App mit den echten Agenten-Routen und der Speicher-Attrappe; gibt (app, redis) zurück."""
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from mcp_hub import agent

    r = SpeicherRedis()
    agent.setze_redis(r)

    async def strom(_request):
        with r._sperre:
            return JSONResponse({k: [dict(f, _id=s) for s, f in v] for k, v in r.stroeme.items()})

    async def zuruecksetzen(_request):
        with r._sperre:
            r.stroeme.clear()
            r.werte.clear()
        return JSONResponse({"ok": True})

    routen = [
        Route("/_test/strom", strom, methods=["GET"]),
        Route("/_test/zuruecksetzen", zuruecksetzen, methods=["POST"]),
        *agent.agent_routen(),
    ]
    return Starlette(routes=routen), r


def main() -> int:
    try:
        import uvicorn

        app, _ = app_bauen()
    except Exception as fehler:  # noqa: BLE001 — jede fehlende Abhängigkeit heißt: ehrlich überspringen
        print(f"FEHLT {type(fehler).__name__}: {fehler}", flush=True)
        return 3
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    print(f"BEREIT {port}", flush=True)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
