#!/usr/bin/env python3
"""Log Relay PWA and RAG health every two minutes until stopped."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
ISSUES = ROOT / 'PWA_TEST_PROBLEMS.md'
RUNTIME = Path('/tmp') / f'relay-rag-monitor-{os.getuid()}'
LOG_DIR = Path.home() / '.relay-v0' / 'monitor'
INTERVAL_SECONDS = 120
REMOTE = r'''
import json, subprocess, urllib.request

def command(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=8)
        return result.returncode, result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, ''

def health(url):
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            return response.status
    except Exception:
        return None

_, pwa = command('systemctl', 'is-active', 'relay-pwa')
containers = {}
for name in ('rag-lab-app-1', 'rag-lab-qdrant-1'):
    code, result = command('docker', 'inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', name)
    containers[name] = result if code == 0 else 'not found'
print(json.dumps({'pwa': pwa, 'app': health('http://127.0.0.1:3000/health'), 'qdrant': health('http://127.0.0.1:6333/readyz'), 'containers': containers}))
'''


def check():
    try:
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'relay-do-v0', 'python3 -c ' + __import__('shlex').quote(REMOTE)], capture_output=True, text=True, timeout=35)
        if result.returncode:
            return {'connection': 'Cannot connect to the VM over SSH; application health could not be checked.'}
        data = json.loads(result.stdout)
        issues = {}
        if data.get('pwa') != 'active':
            issues['pwa'] = 'The relay-pwa service is not active.'
        app = data['containers']['rag-lab-app-1']
        qdrant = data['containers']['rag-lab-qdrant-1']
        if not app.startswith('running') or 'unhealthy' in app or data.get('app') != 200:
            issues['rag_app'] = 'The RAG application container or its local health endpoint is unavailable (it may have been stopped intentionally).'
        if not qdrant.startswith('running') or data.get('qdrant') != 200:
            issues['qdrant'] = 'The Qdrant container or its local readiness endpoint is unavailable (it may have been stopped intentionally).'
        return issues
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        return {'connection': 'The VM health check failed or timed out; application health could not be confirmed.'}


def record(issues, state):
    counters = state.setdefault('counters', {})
    active = state.setdefault('active', {})
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    for key in set(counters) | set(issues):
        counters[key] = counters.get(key, 0) + 1 if key in issues else 0
        if counters[key] >= 2 and key not in active:
            active[key] = issues[key]
            with ISSUES.open('a', encoding='utf-8') as f:
                f.write(f'\n## Monitor: {key} — {now}\n\n**Status:** Observed  \n**Area:** Automated two-minute health check\n\n{issues[key]} The check failed twice consecutively.\n')
        elif key in active and key not in issues and 'connection' not in issues:
            with ISSUES.open('a', encoding='utf-8') as f:
                f.write(f'\n**Monitor recovery — {key} ({now}):** This check is responding again.\n')
            del active[key]
    return state


def record_sample(log_path, timestamp, issues):
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as log:
        log.write(json.dumps({'time_utc': timestamp, 'issues': issues}, sort_keys=True) + '\n')


def main():
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    os.chmod(RUNTIME, 0o700)
    with (RUNTIME / 'lock').open('w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Monitor is already running.', file=sys.stderr)
            return 1
        (RUNTIME / 'pid').write_text(str(os.getpid()))
        LOG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(LOG_DIR, 0o700)
        log_path = LOG_DIR / 'rag-health.jsonl'
        state_file = RUNTIME / 'state.json'
        try: state = json.loads(state_file.read_text())
        except (OSError, ValueError): state = {}
        while True:
            started = time.monotonic()
            issues = check()
            record(issues, state)
            state.update({'last_check_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'current_issues': sorted(issues)})
            record_sample(log_path, state['last_check_utc'], issues)
            temp = state_file.with_suffix('.tmp')
            temp.write_text(json.dumps(state))
            os.replace(temp, state_file)
            time.sleep(max(0, INTERVAL_SECONDS - (time.monotonic() - started)))


if __name__ == '__main__': sys.exit(main())
