#!/usr/bin/env python3
"""Fixed-destination Fish CONNECT relay over an existing SSH command channel.

The workbench owns TLS, credentials and HTTP. This relay handles ciphertext,
does not terminate TLS, and cannot connect to destinations other than Fish.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import itertools
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import queue
from pathlib import Path
import re
import shlex
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FISH_HOST = 'api.fish.audio'
PORT = 18877
MAX_FRAME = 65536
MAX_CHANNELS = 16
MAX_BUFFERED = 64 * 1024 * 1024  # per channel, bytes waiting for a slow socket
OPEN, READY, DATA, CLOSE, FAILED, HELLO = range(1, 7)
HEADER = struct.Struct('!BII')
REMOTE_SCRIPT = '/opt/marketing-workbench/app/deploy/fish_relay.py'


class Frames:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.lock = threading.Lock()

    def read_exact(self, length):
        result = bytearray()
        while len(result) < length:
            data = os.read(self.reader, length - len(result))
            if not data:
                raise EOFError('SSH channel closed')
            result.extend(data)
        return bytes(result)

    def receive(self):
        kind, channel, size = HEADER.unpack(self.read_exact(HEADER.size))
        if kind not in (OPEN, READY, DATA, CLOSE, FAILED, HELLO) or size > MAX_FRAME:
            raise ValueError('Invalid relay frame')
        return kind, channel, self.read_exact(size)

    def send(self, kind, channel, payload=b''):
        if len(payload) > MAX_FRAME:
            raise ValueError('Oversized relay frame')
        with self.lock:
            view = memoryview(HEADER.pack(kind, channel, len(payload)) + payload)
            while view:
                count = os.write(self.writer, view)
                if count <= 0:
                    raise BrokenPipeError('SSH channel closed')
                view = view[count:]


def close_socket(connection):
    with contextlib.suppress(OSError):
        connection.shutdown(socket.SHUT_RDWR)
    with contextlib.suppress(OSError):
        connection.close()


class Channel:
    def __init__(self, connection):
        self.connection = connection
        self.ready = threading.Event()
        self.accepted = False
        self.sink = None


class SocketSink:
    """A bounded writer so a slow socket cannot block shared control frames."""
    def __init__(self, connection, on_failure):
        self.connection = connection
        self.on_failure = on_failure
        # Bound by bytes, not frame count: a whole TTS response (several MB) arrives faster
        # than the workbench reads it. A 16-frame cap (~1 MB) cut audio mid-download.
        self.pending = queue.Queue()
        self.buffered = 0
        self.size_lock = threading.Lock()
        self.closed = threading.Event()
        self.finishing = threading.Event()
        self.start_lock = threading.Lock()
        self.started = False

    def start(self):
        with self.start_lock:
            if not self.started:
                self.started = True
                threading.Thread(target=self.run, daemon=True).start()

    def push(self, payload):
        if self.closed.is_set() or self.finishing.is_set():
            return
        with self.size_lock:
            if self.buffered + len(payload) > MAX_BUFFERED:
                overflow = True
            else:
                overflow = False
                self.buffered += len(payload)
        if overflow:
            self.stop()
            self.on_failure()
            return
        self.pending.put_nowait(payload)
        self.start()

    def finish(self):
        self.finishing.set()
        self.start()

    def stop(self):
        self.closed.set()
        close_socket(self.connection)

    def run(self):
        try:
            while not self.closed.is_set():
                try:
                    payload = self.pending.get(timeout=.25)
                except queue.Empty:
                    if self.finishing.is_set():
                        return
                    continue
                self.connection.sendall(payload)
                with self.size_lock:
                    self.buffered -= len(payload)
                if self.finishing.is_set() and self.pending.empty():
                    return
        except OSError:
            self.on_failure()
        finally:
            self.stop()


class Bridge:
    def __init__(self, frames):
        self.frames = frames
        self.channels = {}
        self.lock = threading.Lock()
        self.ids = itertools.count(1)
        self.online = threading.Event()
        self.closed = threading.Event()

    def open(self, connection):
        with self.lock:
            if self.closed.is_set() or not self.online.is_set():
                raise ConnectionError('Mac relay is offline')
            if len(self.channels) >= MAX_CHANNELS:
                raise ConnectionError('Relay concurrency limit reached')
            channel = next(self.ids)
            item = Channel(connection)
            self.channels[channel] = item
        try:
            self.frames.send(OPEN, channel)
            if not item.ready.wait(15) or not item.accepted:
                raise ConnectionError('Mac could not connect to Fish')
            return channel
        except BaseException:
            self.drop(channel, close=False)
            raise

    def drop(self, channel, notify=True, close=True, drain=False):
        with self.lock:
            item = self.channels.pop(channel, None)
        if item:
            item.ready.set()
            if close:
                if item.sink:
                    if drain:
                        item.sink.finish()
                    else:
                        item.sink.stop()
                else:
                    close_socket(item.connection)
            if notify:
                with contextlib.suppress(OSError):
                    self.frames.send(CLOSE, channel)

    def stop(self):
        self.closed.set()
        self.online.clear()
        with self.lock:
            channels = list(self.channels)
        for channel in channels:
            self.drop(channel, notify=False)

    def read_loop(self):
        try:
            while not self.closed.is_set():
                kind, channel, payload = self.frames.receive()
                if kind == HELLO and channel == 0 and payload == b'fish-relay-v1':
                    self.online.set()
                    continue
                with self.lock:
                    item = self.channels.get(channel)
                if not item:
                    continue
                if kind == READY:
                    item.accepted = True
                    item.ready.set()
                elif kind == FAILED:
                    item.ready.set()
                elif kind == DATA and item.accepted:
                    if item.sink is None:
                        item.sink = SocketSink(item.connection, lambda number=channel: self.drop(number))
                    item.sink.push(payload)
                elif kind == CLOSE:
                    self.drop(channel, notify=False, drain=True)
        except (OSError, EOFError, ValueError):
            pass
        finally:
            self.stop()


def relay_handler(bridge):
    class Handler(BaseHTTPRequestHandler):
        # Do not prefetch TLS bytes past the CONNECT request headers.
        rbufsize = 0
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(150)

        def do_GET(self):
            if self.path != '/health':
                self.send_error(404)
                return
            data = json.dumps({'online': bridge.online.is_set() and not bridge.closed.is_set(),
                               'destination': FISH_HOST, 'protocol': 1}).encode()
            self.send_response(200 if bridge.online.is_set() else 503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def do_CONNECT(self):
            self.close_connection = True
            if self.path.lower() != FISH_HOST + ':443':
                self.send_error(403, 'Only the Fish Audio API is allowed')
                return
            channel = None
            try:
                channel = bridge.open(self.connection)
            except (OSError, ConnectionError):
                # open() may have closed the connection on a failed attempt.
                with contextlib.suppress(OSError):
                    self.send_error(502, 'Mac relay cannot connect to Fish')
                return
            try:
                self.send_response(200, 'Connection established')
                self.end_headers()
                while not bridge.closed.is_set():
                    data = self.connection.recv(MAX_FRAME)
                    if not data:
                        break
                    bridge.frames.send(DATA, channel, data)
            except (OSError, ValueError):
                pass
            finally:
                bridge.drop(channel)

    return Handler


def connect_fish():
    connection = socket.create_connection((FISH_HOST, 443), timeout=10)
    connection.settimeout(150)
    return connection


class MacPeer:
    def __init__(self, frames, connector=connect_fish, on_ready=lambda: None):
        self.frames = frames
        self.connector = connector
        self.on_ready = on_ready
        self.channels = {}
        self.writers = {}
        self.pending = set()
        self.lock = threading.Lock()
        self.closed = threading.Event()

    def drop(self, channel, notify=True, drain=False):
        with self.lock:
            connection = self.channels.pop(channel, None)
            writer = self.writers.pop(channel, None)
            self.pending.discard(channel)
        if writer:
            if drain:
                writer.finish()
            else:
                writer.stop()
        elif connection:
            close_socket(connection)
        if notify:
            with contextlib.suppress(OSError):
                self.frames.send(CLOSE, channel)

    def pump(self, channel):
        connection = None
        accepted = False
        try:
            connection = self.connector()
            with self.lock:
                if channel not in self.pending or self.closed.is_set():
                    close_socket(connection)
                    return
                self.pending.remove(channel)
                self.channels[channel] = connection
            self.frames.send(READY, channel)
            accepted = True
            while not self.closed.is_set():
                data = connection.recv(MAX_FRAME)
                if not data:
                    break
                self.frames.send(DATA, channel, data)
        except OSError:
            if not accepted:
                with contextlib.suppress(OSError):
                    self.frames.send(FAILED, channel)
        finally:
            self.drop(channel, notify=accepted)

    def stop(self):
        self.closed.set()
        with self.lock:
            channels = list(self.channels)
            self.pending.clear()
        for channel in channels:
            self.drop(channel, notify=False)

    def run(self):
        try:
            self.frames.send(HELLO, 0, b'fish-relay-v1')
            while not self.closed.is_set():
                kind, channel, payload = self.frames.receive()
                if kind == HELLO and channel == 0 and payload == b'fish-relay-v1':
                    self.on_ready()
                elif kind == OPEN and channel:
                    with self.lock:
                        if channel in self.channels or channel in self.pending:
                            raise ValueError('Duplicate channel')
                        if len(self.channels) + len(self.pending) >= MAX_CHANNELS:
                            self.frames.send(FAILED, channel)
                            continue
                        self.pending.add(channel)
                    threading.Thread(target=self.pump, args=(channel,), daemon=True).start()
                elif kind == DATA:
                    with self.lock:
                        connection = self.channels.get(channel)
                        writer = self.writers.get(channel)
                        if connection and writer is None:
                            writer = SocketSink(connection, lambda number=channel: self.drop(number))
                            self.writers[channel] = writer
                    if connection:
                        writer.push(payload)
                elif kind == CLOSE:
                    self.drop(channel, notify=False, drain=True)
        except (OSError, EOFError, ValueError):
            pass
        finally:
            self.stop()


def bridge_main(port):
    frames = Frames(sys.stdin.fileno(), sys.stdout.fileno())
    bridge = Bridge(frames)
    server = ThreadingHTTPServer(('127.0.0.1', port), relay_handler(bridge))
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    frames.send(HELLO, 0, b'fish-relay-v1')
    try:
        bridge.read_loop()
    finally:
        server.shutdown()
        server.server_close()
    return 0


def write_state(directory, phase, **details):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    state = directory / 'state.json'
    temp = directory / 'state.tmp'
    temp.write_text(json.dumps({'phase': phase, 'updatedAt': time.time(),
                                'pid': os.getpid(), **details}))
    temp.chmod(0o600)
    temp.replace(state)


def agent_main(host, port, directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (directory / 'agent.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Fish relay is already running')
    stopped = threading.Event()
    active = {}

    def stop(*args):
        stopped.set()
        process = active.get('process')
        if process and process.poll() is None:
            process.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger = logging.getLogger('fish-relay')
    logger.setLevel(logging.INFO)
    log = RotatingFileHandler(directory / 'relay.log', maxBytes=1024 * 1024, backupCount=2)
    log.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(log)
    options = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
               '-o', 'ServerAliveCountMax=3', '-o', 'RequestTTY=no', '-o', 'LogLevel=ERROR']
    remote = shlex.join(['python3', REMOTE_SCRIPT, 'bridge', '--listen-port', str(port)])
    try:
        while not stopped.is_set():
            write_state(directory, 'connecting')
            try:
                process = subprocess.Popen(['/usr/bin/ssh', *options, host, remote],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE)
                active['process'] = process
                peer = MacPeer(Frames(process.stdout.fileno(), process.stdin.fileno()),
                               on_ready=lambda: write_state(directory, 'connected', sshPid=process.pid))
                peer.run()
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process.stdin.close()
                process.stdout.close()
                detail = process.stderr.read(2048).decode('utf-8', 'replace').strip()
                process.stderr.close()
                logger.info('SSH connection ended (%s): %s', process.returncode, detail)
            except OSError as error:
                # Do not log request bodies, headers, credentials or SSH config.
                logger.warning('Connection failed: %s', type(error).__name__)
            write_state(directory, 'reconnecting')
            stopped.wait(8)
    finally:
        write_state(directory, 'stopped')
        lock.close()
    return 0


def probe_main():
    """Run as the workbench user; report identity, never credentials or credit."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    def timed_out(*args):
        raise TimeoutError()
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(25)
    try:
        pid = subprocess.check_output(['systemctl', 'show', 'marketing-workbench.service',
                                       '--property=MainPID', '--value'], text=True).strip()
        names = {'WORKBENCH_DATA_DIR', 'WORKBENCH_CONFIG_DIR', 'FISH_API_KEY',
                 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'}
        environment = {}
        for item in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0'):
            name, separator, value = item.partition(b'=')
            if separator and name.decode() in names:
                environment[name.decode()] = value.decode()
        cwd = Path('/proc/' + pid + '/cwd').resolve()
        config = Path(environment.get('WORKBENCH_CONFIG_DIR',
                      str(Path(environment.get('WORKBENCH_DATA_DIR', str(cwd))) / 'config')))
        key = environment.get('FISH_API_KEY', '').strip()
        if not key:
            key = json.loads((config / 'settings.json').read_text()).get('api_key', '').strip()
        if not key:
            raise ValueError('No configured key')
        for name in names:
            if name.lower().endswith('_proxy'):
                os.environ.pop(name, None)
                if name in environment:
                    os.environ[name] = environment[name]
        opener = urllib.request.build_opener(NoRedirect)
        request = urllib.request.Request('https://' + FISH_HOST + '/wallet/self/api-credit',
                  headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'})
        with opener.open(request, timeout=15) as response:
            data = json.loads(response.read(1048576))
            user_id = data.get('user_id')
            if not isinstance(user_id, str) or not user_id:
                raise ValueError('Missing account ID')
            status = response.status
        # GET never starts synthesis; the real TTS endpoint should reject it.
        try:
            with opener.open('https://' + FISH_HOST + '/v1/tts', timeout=8) as response:
                tts_status = response.status
        except urllib.error.HTTPError as error:
            tts_status = error.code
            error.close()
        print(json.dumps({'ok': True, 'httpStatus': status, 'user_id': user_id,
                          'ttsEndpointGetStatus': tts_status,
                          'viaMacRelay': environment.get('HTTPS_PROXY') == 'http://127.0.0.1:18877',
                          'readOnly': True, 'tlsVerification': 'enabled'}))
        return 0
    except urllib.error.HTTPError as error:
        print(json.dumps({'ok': False, 'errorType': 'HTTPError', 'httpStatus': error.code}))
        return 2
    except urllib.error.URLError as error:
        print(json.dumps({'ok': False, 'errorType': 'URLError',
                          'reasonType': type(error.reason).__name__,
                          'errno': getattr(error.reason, 'errno', None)}))
        return 3
    except Exception as error:
        print(json.dumps({'ok': False, 'errorType': type(error).__name__}))
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    server = modes.add_parser('bridge')
    server.add_argument('--listen-port', type=int, default=PORT)
    agent = modes.add_parser('agent')
    agent.add_argument('--host', default='mainland-jump')
    agent.add_argument('--listen-port', type=int, default=PORT)
    agent.add_argument('--state-dir', type=Path, required=True)
    modes.add_parser('probe')
    args = parser.parse_args()
    if args.mode == 'probe':
        return probe_main()
    if not 1024 <= args.listen_port <= 65535:
        parser.error('Invalid loopback port')
    if args.mode == 'bridge':
        return bridge_main(args.listen_port)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.host):
        parser.error('Invalid SSH alias')
    return agent_main(args.host, args.listen_port, args.state_dir)


if __name__ == '__main__':
    raise SystemExit(main())
