#!/usr/bin/env python3
"""Write tiny, deterministic synthetic DICOM Part 10 viewer fixtures."""

from __future__ import annotations

import struct
import sys
import re
from pathlib import Path

LONG_LENGTH_VR = {b"OB", b"OD", b"OF", b"OL", b"OV", b"OW", b"SQ", b"UC", b"UR", b"UT", b"UN"}
PATTERN_SIDE = 8
PATTERN_LEVELS = (0, 21845, 43690, 65535)
IMPLEMENTED_PROFILES = ("ct", "mr", "sr", "pdf")


def synthetic_pixel_pattern() -> bytes:
    """Make four constant quadrants with ascending unsigned grayscale values."""
    samples = []
    for row in range(PATTERN_SIDE):
        for column in range(PATTERN_SIDE):
            quadrant = (row // (PATTERN_SIDE // 2)) * 2 + column // (PATTERN_SIDE // 2)
            samples.append(PATTERN_LEVELS[quadrant])
    return struct.pack("<" + "H" * len(samples), *samples)


def element(group: int, number: int, vr: bytes, value: bytes) -> bytes:
    if len(value) % 2:
        value += b"\0" if vr == b"UI" or vr in LONG_LENGTH_VR else b" "
    tag = struct.pack("<HH", group, number) + vr
    if vr in LONG_LENGTH_VR:
        return tag + b"\0\0" + struct.pack("<I", len(value)) + value
    return tag + struct.pack("<H", len(value)) + value


def text(group: int, number: int, vr: bytes, value: str) -> bytes:
    return element(group, number, vr, value.encode("ascii"))


def item(value: bytes) -> bytes:
    return struct.pack("<HHI", 0xFFFE, 0xE000, len(value)) + value


def sequence(group: int, number: int, value: bytes) -> bytes:
    return (struct.pack("<HH", group, number) + b"SQ\0\0" +
            struct.pack("<I", 0xFFFFFFFF) + item(value) +
            struct.pack("<HHI", 0xFFFE, 0xE0DD, 0))


def build_fixture(profile: str, suffix: str = "1", instance_suffix: str = "1", patient_label: str = "PROOF") -> tuple[bytes, tuple[str, str, str]]:
    if profile not in IMPLEMENTED_PROFILES:
        raise ValueError(f"profile must be one of: {', '.join(IMPLEMENTED_PROFILES)}")
    if not re.fullmatch(r"[1-9][0-9]{0,31}", suffix):
        raise ValueError("UID_SUFFIX must be 1-32 digits and cannot start with zero")
    if not re.fullmatch(r"[1-9][0-9]{0,11}", instance_suffix):
        raise ValueError("INSTANCE_SUFFIX must be 1-12 digits and cannot start with zero")
    study_uid = f"1.2.826.0.1.3680043.10.987.{suffix}"
    series_uid = f"{study_uid}.1"
    sop_uid = f"{series_uid}.{instance_suffix}"
    if len(sop_uid) > 64:
        raise ValueError("generated SOP UID exceeds the DICOM 64-character limit")
    if not re.fullmatch(r"[A-Z0-9_-]{1,24}", patient_label):
        raise ValueError("synthetic patient label must be 1-24 uppercase ASCII letters, digits, hyphen or underscore")

    profiles = {
        "ct": ("CT", "1.2.840.10008.5.1.4.1.1.2"),
        "mr": ("MR", "1.2.840.10008.5.1.4.1.1.4"),
        "sr": ("SR", "1.2.840.10008.5.1.4.1.1.88.11"),
        "pdf": ("DOC", "1.2.840.10008.5.1.4.1.1.104.1"),
    }
    modality, sop_class = profiles[profile]
    file_meta_fields = [
        element(0x0002, 0x0001, b"OB", b"\0\1"),
        text(0x0002, 0x0002, b"UI", sop_class),
        text(0x0002, 0x0003, b"UI", sop_uid),
        text(0x0002, 0x0010, b"UI", "1.2.840.10008.1.2.1"),
        text(0x0002, 0x0012, b"UI", "1.2.826.0.1.3680043.10.987"),
    ]
    file_meta_body = b"".join(file_meta_fields)
    file_meta = element(0x0002, 0x0000, b"UL", struct.pack("<I", len(file_meta_body))) + file_meta_body
    dataset = [
        text(0x0008, 0x0016, b"UI", sop_class),
        text(0x0008, 0x0018, b"UI", sop_uid),
        text(0x0008, 0x0060, b"CS", modality),
        text(0x0010, 0x0010, b"PN", f"SYNTHETIC^{patient_label}"),
        text(0x0010, 0x0020, b"LO", "SYNTHETIC-ONLY"),
        text(0x0020, 0x000D, b"UI", study_uid),
        text(0x0020, 0x000E, b"UI", series_uid),
        text(0x0020, 0x0013, b"IS", instance_suffix),
    ]
    if profile in ("ct", "mr"):
        dataset.extend([
            element(0x0028, 0x0002, b"US", struct.pack("<H", 1)),
            text(0x0028, 0x0004, b"CS", "MONOCHROME2"),
            element(0x0028, 0x0010, b"US", struct.pack("<H", PATTERN_SIDE)),
            element(0x0028, 0x0011, b"US", struct.pack("<H", PATTERN_SIDE)),
            text(0x0028, 0x0030, b"DS", "1\\1"),
            text(0x0028, 0x1050, b"DS", "32768"),
            text(0x0028, 0x1051, b"DS", "65536"),
            text(0x0028, 0x1052, b"DS", "0"),
            text(0x0028, 0x1053, b"DS", "1"),
            element(0x0028, 0x0100, b"US", struct.pack("<H", 16)),
            element(0x0028, 0x0101, b"US", struct.pack("<H", 16)),
            element(0x0028, 0x0102, b"US", struct.pack("<H", 15)),
            element(0x0028, 0x0103, b"US", struct.pack("<H", 0)),
            element(0x7FE0, 0x0010, b"OW", synthetic_pixel_pattern()),
        ])
    elif profile == "sr":
        content = b"".join([
            text(0x0040, 0xA040, b"CS", "TEXT"),
            sequence(0x0040, 0xA043, b"".join([
                text(0x0008, 0x0100, b"SH", "121071"),
                text(0x0008, 0x0102, b"SH", "DCM"),
                text(0x0008, 0x0104, b"LO", "Finding"),
            ])),
            text(0x0040, 0xA160, b"UT", "Synthetic finding only"),
        ])
        dataset.extend([text(0x0008, 0x0008, b"CS", "DERIVED\\SECONDARY"),
                        sequence(0x0040, 0xA730, content)])
    else:
        dataset.extend([
            text(0x0042, 0x0010, b"ST", "Synthetic document"),
            text(0x0042, 0x0012, b"LO", "application/pdf"),
            element(0x0042, 0x0011, b"OB", b"%PDF-1.4\n% synthetic fixture\n"),
        ])
    data = b"\0" * 128 + b"DICM" + file_meta + b"".join(dataset)
    return data, (study_uid, series_uid, sop_uid)


def main() -> None:
    if len(sys.argv) not in (2, 3, 4, 5, 6):
        raise SystemExit("usage: make-synthetic-dicom.py OUTPUT [UID_SUFFIX] [INSTANCE_SUFFIX] [ct|mr|sr|pdf] [SYNTHETIC_LABEL]")
    suffix = sys.argv[2] if len(sys.argv) >= 3 else "1"
    instance_suffix = sys.argv[3] if len(sys.argv) >= 4 else "1"
    profile = sys.argv[4] if len(sys.argv) >= 5 else "ct"
    patient_label = sys.argv[5] if len(sys.argv) == 6 else "PROOF"
    data, uids = build_fixture(profile, suffix, instance_suffix, patient_label)
    Path(sys.argv[1]).write_bytes(data)
    study_uid, series_uid, sop_uid = uids
    print(f"{study_uid}\t{series_uid}\t{sop_uid}")


if __name__ == "__main__":
    main()
