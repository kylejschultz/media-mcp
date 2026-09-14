from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image

FIXTURES = Path(__file__).parent / "fixtures"


def generate() -> None:
    FIXTURES.mkdir(exist_ok=True)
    common = [
        "/usr/bin/ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        "0.1",
        "-map_metadata",
        "-1",
        "-y",
    ]
    subprocess.run([*common, "-c:a", "flac", str(FIXTURES / "test.flac")], check=True)
    subprocess.run([*common, "-c:a", "libmp3lame", "-b:a", "64k", str(FIXTURES / "test.mp3")], check=True)
    Image.new("RGB", (24, 24), "red").save(FIXTURES / "cover.png", "PNG", optimize=False)


if __name__ == "__main__":
    generate()
