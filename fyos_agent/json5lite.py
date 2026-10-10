"""Winziger JSON5-Leser fuer die Pruefung der gerenderten Konfiguration.

Unterstuetzt genau die Teilmenge, die `config/openclaw.json5.tmpl` verwendet:
Zeilen- und Blockkommentare, unquotierte Schluessel, einfache Anfuehrungszeichen
nicht, Kommas am Ende. Mehr ist nicht noetig; das Gateway liest die Datei selbst.
"""

from __future__ import annotations

import json
import re
from typing import Any

_SCHLUESSEL = re.compile(r'([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)')
_KOMMA_ENDE = re.compile(r',(\s*[}\]])')


def _ohne_kommentare(text: str) -> str:
    aus: list[str] = []
    i, n = 0, len(text)
    in_text = False
    while i < n:
        c = text[i]
        if in_text:
            aus.append(c)
            if c == "\\" and i + 1 < n:
                aus.append(text[i + 1])
                i += 1
            elif c == '"':
                in_text = False
        elif c == '"':
            in_text = True
            aus.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            ende = text.find("*/", i + 2)
            i = n if ende < 0 else ende + 2
            continue
        else:
            aus.append(c)
        i += 1
    return "".join(aus)


def _schluessel_quoten(text: str) -> str:
    """Setzt Schluessel in Anfuehrungszeichen, aber nur ausserhalb von Zeichenketten."""
    n = len(text)
    ergebnis: list[str] = []
    pos = 0
    in_text = False
    i = 0
    while i < n:
        c = text[i]
        if in_text:
            if c == "\\":
                i += 1
            elif c == '"':
                ergebnis.append(text[pos:i + 1])
                pos = i + 1
                in_text = False
        elif c == '"':
            ergebnis.append(_SCHLUESSEL.sub(r'\1"\2"\3', text[pos:i]))
            pos = i
            in_text = True
        i += 1
    ergebnis.append(_SCHLUESSEL.sub(r'\1"\2"\3', text[pos:]))
    return "".join(ergebnis)


def lade(text: str) -> Any:
    """Parst die JSON5-Teilmenge; wirft ValueError bei Fehlern."""
    roh = _ohne_kommentare(text)
    roh = _schluessel_quoten(roh)
    roh = _KOMMA_ENDE.sub(r"\1", roh)
    try:
        return json.loads(roh)
    except json.JSONDecodeError as fehler:
        raise ValueError(f"JSON5 nicht lesbar: {fehler}") from fehler
