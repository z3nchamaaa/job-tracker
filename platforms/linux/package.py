#!/usr/bin/env python3
"""Build Linux package candidates from allowlisted sources, without installing them.

Packaging can run on macOS, but that does not verify Linux runtime operation.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
OUT = ROOT / "dist" / "linux-x64"

def artifact_name(kind):
    return subprocess.check_output(["node", str(ROOT / "src/backend/artifact-names.cjs"), VERSION, "linux", "x64", kind], text=True).strip()


def tar_gzip(folder):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as archive:
            for item in sorted(folder.rglob("*")):
                if item.is_symlink():
                    raise ValueError("Symlinks are not allowed in staging")
                info = archive.gettarinfo(str(item), arcname="./" + str(item.relative_to(folder)))
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mtime = 0
                if item.is_file():
                    with item.open("rb") as content:
                        archive.addfile(info, content)
                else:
                    archive.addfile(info)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=["deb", "rpm", "all"], default="all")
    options = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    stage = OUT / "payload"
    if stage.exists():
        shutil.rmtree(stage)
    app = stage / "opt" / "job-tracker"
    subprocess.run(["node", str(ROOT / "scripts/stage.cjs"), str(app), "linux", "x64"], check=True)
    host = app / "platforms/linux/job-tracker-host.py"
    host.chmod(0o755)
    launcher = stage / "usr/bin/job-tracker"
    launcher.parent.mkdir(parents=True)
    launcher.write_text('#!/bin/sh\nexec python3 /opt/job-tracker/platforms/linux/job-tracker-host.py "$@"\n')
    launcher.chmod(0o755)
    desktop = stage / "usr/share/applications/jp.jobtracker.app.desktop"
    desktop.parent.mkdir(parents=True)
    desktop.write_text("[Desktop Entry]\nType=Application\nName=就活トラッカー\nExec=job-tracker\n"
                       "Icon=/opt/job-tracker/assets/icons/app-icon.png\nTerminal=false\nCategories=Office;\n")
    if options.format in ("deb", "all"):
        control_dir = OUT / "control"
        control_dir.mkdir(exist_ok=True)
        (control_dir / "control").write_text(
            f"Package: job-tracker\nVersion: {VERSION}\nArchitecture: amd64\n"
            "Maintainer: Job Tracker Contributors <noreply@example.invalid>\n"
            "Section: utils\nPriority: optional\n"
            "Depends: nodejs (>= 24.22.1), nodejs (<< 25) | nodejs (>= 26.12.1), nodejs (<< 27), python3, python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, libsecret-tools\n"
            "Description: Local job application tracker with system WebView\n"
        )
        target = OUT / artifact_name('deb')
        with target.open("wb") as archive:
            archive.write(b"!<arch>\n")
            for name, content in [("debian-binary", b"2.0\n"), ("control.tar.gz", tar_gzip(control_dir)), ("data.tar.gz", tar_gzip(stage))]:
                header = f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(content):<10}`\n".encode("ascii")
                assert len(header) == 60
                archive.write(header)
                archive.write(content)
                if len(content) % 2:
                    archive.write(b"\n")
        print(target.relative_to(ROOT))
    if options.format in ("rpm", "all"):
        if not shutil.which("rpmbuild"):
            raise SystemExit("rpmbuild is required for RPM packaging; no RPM was generated")
        top = OUT / "rpm-build"
        if (top / "RPMS").exists():
            shutil.rmtree(top / "RPMS")
        for name in ["BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS", "BUILDROOT", "tmp"]:
            (top / name).mkdir(parents=True, exist_ok=True)
        payload = top / "SOURCES/payload"
        if payload.exists():
            shutil.rmtree(payload)
        shutil.copytree(stage, payload)
        spec = top / "SPECS/job-tracker.spec"
        spec.write_text(f"""Name: job-tracker
Version: {VERSION}
Release: 1
Summary: Local job application tracker
License: MIT
AutoReqProv: no
Requires: ((nodejs >= 24.22.1 with nodejs < 25) or (nodejs >= 26.12.1 with nodejs < 27)), python3, python3-gobject, gtk3, webkit2gtk4.1, libsecret
%description
Local job application tracker using the operating system WebView.
%prep
%build
%install
mkdir -p "%{{buildroot}}"
cp -R "%{{_sourcedir}}/payload/." "%{{buildroot}}/"
%files
/opt/job-tracker
/usr/bin/job-tracker
/usr/share/applications/jp.jobtracker.app.desktop
""")
        subprocess.run(["rpmbuild", "-bb", "--target", "x86_64-linux", "--define", f"_topdir {top}",
                        "--define", f"_tmppath {top / 'tmp'}", "--define", "_buildhost local",
                        "--define", "_build_id_links none", str(spec)], check=True, timeout=120)
        candidates = list((top / "RPMS").rglob("*.rpm"))
        if len(candidates) != 1:
            raise SystemExit("Expected exactly one RPM")
        arch = subprocess.check_output(["rpm", "-qp", "--qf", "%{ARCH}", str(candidates[0])], text=True).strip()
        if arch != "x86_64":
            raise SystemExit(f"Unexpected RPM architecture: {arch}")
        target = OUT / artifact_name('rpm')
        shutil.copyfile(candidates[0], target)
        print(target.relative_to(ROOT))
    packages = []
    for file in sorted(OUT.iterdir()):
        if file.is_file() and file.name in (artifact_name('deb'), artifact_name('rpm')):
            packages.append({"path": str(file.relative_to(ROOT)), "bytes": file.stat().st_size,
                             "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    subprocess.run(["node", "-e", "require('./scripts/sbom.cjs').platformSbom(process.argv[1],process.argv[2],'linux','x64')", str(app), str(OUT)], cwd=ROOT, check=True)
    subprocess.run(["node", str(ROOT / "scripts/release-manifest.cjs"), str(OUT)], cwd=ROOT, check=True)
    (OUT / "package-report.json").write_text(json.dumps({
        "version": VERSION, "packages": packages,
        "unpackedPayloadBytes": sum(file.stat().st_size for file in stage.rglob("*") if file.is_file()),
        "runtimeVerified": False, "sharedRuntimeDownloadBytes": "unmeasured",
        "note": "Package candidates target Linux x64. Building on another OS does not verify Linux execution. Copilot requires the target OS native package; its availability is checked separately."
    }, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
