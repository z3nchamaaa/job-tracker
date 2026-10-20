#!/usr/bin/env python3
"""Inspect pinned NuGet archives in memory; never install or execute package code."""
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'dependency-integrity.json').read_text())
reports = []
for package in manifest['packages']:
    with urllib.request.urlopen(package['source'], timeout=30) as response:
        data = response.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != package['sha256']:
        raise ValueError('Package size or SHA-256 mismatch: ' + package['name'])
    archive = zipfile.ZipFile(io.BytesIO(data))
    hooks = []
    for name in archive.namelist():
        if name.endswith(('.targets', '.props')):
            source = archive.read(name).decode('utf-8-sig')
            parsed = ET.fromstring(source)
            operations = []
            for element in parsed.iter():
                tag = element.tag.split('}')[-1]
                if tag in ('Exec', 'UsingTask', 'Import', 'Copy', 'Delete', 'WriteLinesToFile', 'MakeDir'):
                    operations.append({'task': tag, 'attributes': element.attrib})
            hooks.append({'file': name, 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'operations': operations, 'source': source})
    reports.append({'name': package['name'], 'version': package['version'], 'sha256Matched': True,
                    'signatureVerified': False, 'executed': False, 'buildHooks': hooks})
output = root / 'dist/verification/nuget-build-hooks.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(reports, indent=2) + '\n')
print(output.relative_to(root))
