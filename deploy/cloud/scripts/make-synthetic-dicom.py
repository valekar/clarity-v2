#!/usr/bin/env python3
"""Write one tiny synthetic CT DICOM Part 10 file for the isolated cloud proof."""

from __future__ import annotations

import struct
import sys
import re
from pathlib import Path

LONG_LENGTH_VR = {b"OB", b"OD", b"OF", b"OL", b"OV", b"OW", b"SQ", b"UC", b"UR", b"UT", b"UN"}


def element(group: int, number: int, vr: bytes, value: bytes) -> bytes:
    if len(value) % 2:
        value += b"\0" if vr == b"UI" or vr in LONG_LENGTH_VR else b" "
    tag = struct.pack("<HH", group, number) + vr
    if vr in LONG_LENGTH_VR:
        return tag + b"\0\0" + struct.pack("<I", len(value)) + value
    return tag + struct.pack("<H", len(value)) + value


def text(group: int, number: int, vr: bytes, value: str) -> bytes:
    return element(group, number, vr, value.encode("ascii"))


def main() -> None:
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: make-synthetic-dicom.py OUTPUT [UID_SUFFIX]")
    suffix = sys.argv[2] if len(sys.argv) == 3 else "1"
    if not re.fullmatch(r"[1-9][0-9]{0,31}", suffix):
        raise SystemExit("UID_SUFFIX must be 1-32 digits and cannot start with zero")
    study_uid = f"1.2.826.0.1.3680043.10.987.{suffix}"
    series_uid = f"{study_uid}.1"
    sop_uid = f"{series_uid}.1"
    sop_class = "1.2.840.10008.5.1.4.1.1.2"

    file_meta_fields = [
        element(0x0002, 0x0001, b"OB", b"\0\1"),
        text(0x0002, 0x0002, b"UI", sop_class),
        text(0x0002, 0x0003, b"UI", sop_uid),
        text(0x0002, 0x0010, b"UI", "1.2.840.10008.1.2.1"),
        text(0x0002, 0x0012, b"UI", "1.2.826.0.1.3680043.10.987"),
    ]
    file_meta_body = b"".join(file_meta_fields)
    file_meta = element(0x0002, 0x0000, b"UL", struct.pack("<I", len(file_meta_body))) + file_meta_body
    dataset = b"".join(
        [
            text(0x0008, 0x0016, b"UI", sop_class),
            text(0x0008, 0x0018, b"UI", sop_uid),
            text(0x0008, 0x0060, b"CS", "CT"),
            text(0x0010, 0x0010, b"PN", "SYNTHETIC^PROOF"),
            text(0x0010, 0x0020, b"LO", "SYNTHETIC-ONLY"),
            text(0x0020, 0x000D, b"UI", study_uid),
            text(0x0020, 0x000E, b"UI", series_uid),
            element(0x0028, 0x0002, b"US", struct.pack("<H", 1)),
            text(0x0028, 0x0004, b"CS", "MONOCHROME2"),
            element(0x0028, 0x0010, b"US", struct.pack("<H", 1)),
            element(0x0028, 0x0011, b"US", struct.pack("<H", 1)),
            element(0x0028, 0x0100, b"US", struct.pack("<H", 16)),
            element(0x0028, 0x0101, b"US", struct.pack("<H", 16)),
            element(0x0028, 0x0102, b"US", struct.pack("<H", 15)),
            element(0x0028, 0x0103, b"US", struct.pack("<H", 0)),
            element(0x7FE0, 0x0010, b"OW", struct.pack("<H", 0)),
        ]
    )
    Path(sys.argv[1]).write_bytes(b"\0" * 128 + b"DICM" + file_meta + dataset)
    print(f"{study_uid}\t{series_uid}\t{sop_uid}")


if __name__ == "__main__":
    main()
