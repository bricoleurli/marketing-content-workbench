#!/usr/bin/env python3
"""Deploy a pushed, CI-verified GitHub commit through an existing SSH alias."""
import argparse
import json
import re
import shlex
import subprocess

REPO = 'bricoleurli/marketing-content-workbench'
REMOTE = r'''
import json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request
sha=sys.argv[1]
base=pathlib.Path('/opt/marketing-workbench')
app=base/'app'
releases=base/'releases'
releases.mkdir(exist_ok=True)
release=releases/sha
old=app.resolve()
if not release.exists():
    with tempfile.TemporaryDirectory(dir=releases) as temp:
        temp=pathlib.Path(temp)
        archive=temp/'source.tar.gz'
        with urllib.request.urlopen('https://codeload.github.com/bricoleurli/marketing-content-workbench/tar.gz/'+sha,timeout=90) as response, archive.open('wb') as out:
            shutil.copyfileobj(response,out)
        with tarfile.open(archive) as tar: tar.extractall(temp/'source',filter='data')
        source=next((temp/'source').iterdir())
        if (app/'requirements.txt').read_bytes() != (source/'requirements.txt').read_bytes():
            raise SystemExit('Dependency changes require updating the isolated runtime before release.')
        subprocess.run([str(base/'venv/bin/python'),'-m','unittest','discover','tests'],cwd=source,check=True)
        (source/'DEPLOYED_COMMIT').write_text(sha+'\n')
        source.rename(release)
        release.chmod(0o755)
if not app.is_symlink():
    old=releases/('pre-github-'+time.strftime('%Y%m%d%H%M%S'))
    app.rename(old)
def point(path):
    link=base/'app.next'
    link.unlink(missing_ok=True)
    link.symlink_to(path)
    os.replace(link,app)
point(release)
try:
    subprocess.run(['systemctl','restart','marketing-workbench'],check=True)
    for attempt in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8876/api/overlays',timeout=3) as response:
                assert len(json.load(response)['components'])==9
            break
        except Exception:
            if attempt==29: raise
            time.sleep(.5)
except Exception:
    point(old)
    subprocess.run(['systemctl','restart','marketing-workbench'],check=True)
    raise
(base/'previous-release').write_text(str(old)+'\n')
print(json.dumps({'deployed_commit':sha,'app':str(app),'release':str(release),'previous_release':str(old),'health':'ok'}))
'''

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',required=True,help='Existing SSH config alias')
    args=parser.parse_args()
    if args.host.startswith('-'): parser.error('Invalid SSH host')
    if subprocess.check_output(['git','status','--porcelain'],text=True).strip():
        raise SystemExit('Commit all local changes before deploying.')
    sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}',sha): raise SystemExit('Invalid commit')
    checks=json.loads(subprocess.check_output(['gh','api',f'repos/{REPO}/commits/{sha}/check-runs'],text=True))['check_runs']
    verify=[item for item in checks if item['name']=='verify' and item['app']['slug']=='github-actions']
    if not verify or any(item['status']!='completed' or item['conclusion']!='success' for item in verify):
        raise SystemExit('Push this commit and wait for GitHub CI verify to pass.')
    command='sudo -n python3 -c '+shlex.quote(REMOTE)+' '+shlex.quote(sha)
    subprocess.run(['ssh','-o','BatchMode=yes',args.host,command],check=True)

if __name__=='__main__': main()
