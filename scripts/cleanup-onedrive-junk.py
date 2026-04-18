import os
import shutil

base = "/data"
deleted_files = 0
deleted_dirs = 0
freed_bytes = 0

# 1. Delete all .v1_indexcache files
print("=== Deleting .v1_indexcache files ===", flush=True)
for root, dirs, files in os.walk(base):
    for f in files:
        if f.endswith(".v1_indexcache"):
            path = os.path.join(root, f)
            try:
                freed_bytes += os.path.getsize(path)
                os.remove(path)
                deleted_files += 1
            except Exception:
                pass
print(f"  Deleted {deleted_files} .v1_indexcache files", flush=True)

# 2. Delete KiCad community libraries
kicad_dirs = [
    "/data/Projects/PCB/kicad_libraries/digikey-partner-kicad-library",
    "/data/Projects/PCB/kicad_libraries/digikey-kicad-library",
    "/data/Projects/Electronics/Adafruit/Adafruit-SMT-Breakout-PCBs",
]
print("\n=== Deleting KiCad community libraries ===", flush=True)
for d in kicad_dirs:
    if os.path.isdir(d):
        count = sum(1 for _, _, files in os.walk(d) for f in files)
        shutil.rmtree(d)
        deleted_dirs += 1
        deleted_files += count
        print(f"  Deleted {d.split('/data/')[-1]} ({count} files)", flush=True)
    else:
        print(f"  Not found: {d.split('/data/')[-1]}", flush=True)

# 3. Delete Music directory (iTunes cache only, audio already moved)
music_dir = "/data/Music"
print("\n=== Deleting Music directory (iTunes cache) ===", flush=True)
if os.path.isdir(music_dir):
    count = sum(1 for _, _, files in os.walk(music_dir) for f in files)
    sz = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(music_dir) for f in fs)
    shutil.rmtree(music_dir)
    deleted_files += count
    freed_bytes += sz
    print(f"  Deleted Music/ ({count} files, {sz/1024/1024:.0f} MB)", flush=True)

# 4. Delete Python venvs and build caches in Projects
print("\n=== Deleting Python venvs and build caches ===", flush=True)
junk_dirs = {
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "node_modules",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    "dist",
    "build",
    "*.egg-info",
}
for root, dirs, files in os.walk(base):
    for d in dirs[:]:
        if d in junk_dirs or d.endswith(".egg-info"):
            path = os.path.join(root, d)
            try:
                count = sum(1 for _, _, fs in os.walk(path) for f in fs)
                sz = sum(
                    os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs
                )
                shutil.rmtree(path)
                deleted_files += count
                freed_bytes += sz
                deleted_dirs += 1
                dirs.remove(d)
                rel = os.path.relpath(path, base)
                print(f"  Deleted {rel} ({count} files, {sz/1024/1024:.0f} MB)", flush=True)
            except Exception as e:
                print(f"  Error: {path}: {e}", flush=True)

print(f"\n{'='*60}", flush=True)
print("  CLEANUP COMPLETE", flush=True)
print(f"  Files deleted: {deleted_files:,}", flush=True)
print(f"  Directories removed: {deleted_dirs:,}", flush=True)
print(f"  Space freed: {freed_bytes/1024/1024/1024:.2f} GB", flush=True)
print(f"{'='*60}", flush=True)
