"""Ticket flight numbers -> the callsign the aircraft actually broadcasts.

Tickets, airports and Google use IATA airline codes (6E7251, EK501), but
ADS-B transponders broadcast the ICAO code (IGO7251, UAE501). Searching
receiver data for "6E7251" finds nothing, so translate first.

Covers major passenger and cargo airlines; anything not listed can still
be searched by its ICAO callsign, registration or hex code.
"""

import re

IATA_TO_ICAO = {
    # India
    "6E": "IGO", "AI": "AIC", "IX": "AXB", "SG": "SEJ", "QP": "AKJ", "9I": "LLR",
    # Middle East & Africa
    "EK": "UAE", "EY": "ETD", "QR": "QTR", "FZ": "FDB", "G9": "ABY", "WY": "OMA",
    "GF": "GFA", "SV": "SVA", "XY": "KNE", "J9": "JZR", "KU": "KAC", "RJ": "RJA",
    "MS": "MSR", "ME": "MEA", "ET": "ETH", "KQ": "KQA", "SA": "SAA",
    # Europe
    "BA": "BAW", "VS": "VIR", "U2": "EZY", "FR": "RYR", "LH": "DLH", "LX": "SWR",
    "OS": "AUA", "SN": "BEL", "AF": "AFR", "KL": "KLM", "IB": "IBE", "VY": "VLG",
    "AZ": "ITY", "SK": "SAS", "AY": "FIN", "LO": "LOT", "TP": "TAP", "EI": "EIN",
    "W6": "WZZ", "TK": "THY", "PC": "PGT",
    # Americas
    "AA": "AAL", "DL": "DAL", "UA": "UAL", "WN": "SWA", "B6": "JBU", "AS": "ASA",
    "NK": "NKS", "F9": "FFT", "AC": "ACA", "WS": "WJA", "AM": "AMX", "LA": "LAN",
    "AV": "AVA", "CM": "CMP", "G3": "GLO", "AD": "AZU",
    # Asia-Pacific
    "SQ": "SIA", "CX": "CPA", "NH": "ANA", "JL": "JAL", "KE": "KAL", "OZ": "AAR",
    "CA": "CCA", "MU": "CES", "CZ": "CSN", "HU": "CHH", "TG": "THA", "MH": "MAS",
    "GA": "GIA", "PR": "PAL", "VN": "HVN", "QF": "QFA", "VA": "VOZ", "NZ": "ANZ",
    "BR": "EVA", "CI": "CAL", "AK": "AXM", "TR": "TGW", "3K": "JSA", "UL": "ALK",
    "BG": "BBC", "PK": "PIA",
    # Cargo
    "FX": "FDX", "5X": "UPS",
}

_FLIGHT_NUMBER = re.compile(r"^([A-Z0-9]{2})0*(\d{1,4}[A-Z]?)$")


def icao_callsign(query: str) -> str | None:
    """'6E7251' -> 'IGO7251', 'BA0117' -> 'BAW117'. None if the query
    doesn't look like an IATA flight number for a known airline."""
    m = _FLIGHT_NUMBER.match(query.strip().upper())
    if not m or m.group(1) not in IATA_TO_ICAO:
        return None
    return IATA_TO_ICAO[m.group(1)] + m.group(2)


def icao_airline(query: str) -> str | None:
    """Bare airline code in either form -> ICAO: '6E' -> 'IGO', 'IGO' -> 'IGO'."""
    q = query.strip().upper()
    if q in IATA_TO_ICAO:
        return IATA_TO_ICAO[q]
    return q if re.fullmatch(r"[A-Z]{3}", q) else None
