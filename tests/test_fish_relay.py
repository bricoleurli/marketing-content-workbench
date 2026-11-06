import concurrent.futures
import contextlib
import os
import socket
import threading
import time
import unittest

from deploy import fish_relay as relay


def read_exact(connection, length):
    data = bytearray()
    while len(data) < length:
        part = connection.recv(length - len(data))
        if not part:
            raise EOFError('Tunnel ended early')
        data.extend(part)
    return bytes(data)


def headers(connection):
    data = bytearray()
    while not data.endswith(b'\r\n\r\n'):
        data.extend(read_exact(connection, 1))
    return bytes(data)


class Harness:
    def __init__(self, connector=None):
        self.connections = 0
        self.a, self.b = socket.socketpair()
        self.bridge = relay.Bridge(relay.Frames(self.a.fileno(), self.a.fileno()))
        self.mac = relay.MacPeer(relay.Frames(self.b.fileno(), self.b.fileno()), connector or self.echo)
        self.http = relay.ThreadingHTTPServer(('127.0.0.1', 0), relay.relay_handler(self.bridge))
        self.http.daemon_threads = True
        self.threads = [threading.Thread(target=self.bridge.read_loop, daemon=True),
                        threading.Thread(target=self.mac.run, daemon=True),
                        threading.Thread(target=self.http.serve_forever, daemon=True)]

    def echo(self):
        self.connections += 1
        client, target = socket.socketpair()
        def run():
            with target:
                try:
                    while True:
                        data = target.recv(16384)
                        if not data:
                            break
                        target.sendall(data)
                except OSError:
                    pass
        threading.Thread(target=run, daemon=True).start()
        return client

    def __enter__(self):
        for thread in self.threads:
            thread.start()
        if not self.bridge.online.wait(2):
            raise RuntimeError('Relay did not connect')
        return self

    def request(self, method='CONNECT', target='api.fish.audio:443'):
        connection = socket.create_connection(self.http.server_address, timeout=3)
        connection.settimeout(4)
        connection.sendall(f'{method} {target} HTTP/1.1\r\nHost: {target}\r\n\r\n'.encode())
        return connection, headers(connection)

    def __exit__(self, *args):
        self.mac.stop()
        self.bridge.stop()
        relay.close_socket(self.a)
        relay.close_socket(self.b)
        self.http.shutdown()
        self.http.server_close()
        for thread in self.threads:
            thread.join(2)


class FishRelayTest(unittest.TestCase):
    def verify_isolated_write_failure(self, side):
        a, b = socket.socketpair()
        broken, abandoned = socket.socketpair()
        healthy, receiver = socket.socketpair()
        receiver.settimeout(2)
        abandoned.close()
        frames = relay.Frames(a.fileno(), a.fileno())
        if side == 'server':
            controller = relay.Bridge(frames)
            controller.online.set()
            for channel, connection in ((1, broken), (2, healthy)):
                item = relay.Channel(connection)
                item.accepted = True
                controller.channels[channel] = item
            target = controller.read_loop
        else:
            controller = relay.MacPeer(frames)
            controller.channels.update({1: broken, 2: healthy})
            target = controller.run
        worker = threading.Thread(target=target, daemon=True)
        worker.start()
        try:
            peer = relay.Frames(b.fileno(), b.fileno())
            peer.send(relay.DATA, 1, b'closed socket')
            peer.send(relay.DATA, 2, b'ok')
            self.assertEqual(read_exact(receiver, 2), b'ok')
            self.assertFalse(controller.closed.is_set())
            deadline = time.monotonic() + 2
            while 1 in controller.channels and time.monotonic() < deadline:
                time.sleep(.005)
            self.assertNotIn(1, controller.channels)
            self.assertIn(2, controller.channels)
        finally:
            controller.stop()
            for connection in (a, b, broken, healthy, receiver):
                relay.close_socket(connection)
            worker.join(2)

    def test_disconnected_client_does_not_close_other_channels(self):
        self.verify_isolated_write_failure('server')

    def test_disconnected_fish_socket_does_not_close_other_channels(self):
        self.verify_isolated_write_failure('mac')

    def verify_slow_channel_isolation(self, side):
        a, b = socket.socketpair()
        blocked, unread = socket.socketpair()
        healthy, receiver = socket.socketpair()
        blocked.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
        unread.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        receiver.settimeout(2)
        frames = relay.Frames(a.fileno(), a.fileno())
        if side == 'server':
            controller = relay.Bridge(frames)
            controller.online.set()
            for channel, connection in ((1, blocked), (2, healthy)):
                item = relay.Channel(connection)
                item.accepted = True
                controller.channels[channel] = item
            target = controller.read_loop
        else:
            controller = relay.MacPeer(frames)
            controller.channels.update({1: blocked, 2: healthy})
            target = controller.run
        worker = threading.Thread(target=target, daemon=True)
        worker.start()
        try:
            peer = relay.Frames(b.fileno(), b.fileno())
            peer.send(relay.DATA, 1, b'x' * relay.MAX_FRAME)
            peer.send(relay.DATA, 2, b'ok')
            self.assertEqual(read_exact(receiver, 2), b'ok')
            self.assertFalse(controller.closed.is_set())
        finally:
            controller.stop()
            for connection in (a, b, blocked, unread, healthy, receiver):
                relay.close_socket(connection)
            worker.join(2)

    def test_slow_client_does_not_block_other_channels(self):
        self.verify_slow_channel_isolation('server')

    def test_slow_fish_socket_does_not_block_other_channels(self):
        self.verify_slow_channel_isolation('mac')

    def test_final_bytes_are_drained_before_peer_close(self):
        for side in ('server', 'mac'):
            with self.subTest(side=side):
                a, b = socket.socketpair()
                target, receiver = socket.socketpair()
                receiver.settimeout(3)
                frames = relay.Frames(a.fileno(), a.fileno())
                if side == 'server':
                    controller = relay.Bridge(frames)
                    item = relay.Channel(target)
                    item.accepted = True
                    controller.channels[1] = item
                    run = controller.read_loop
                else:
                    controller = relay.MacPeer(frames)
                    controller.channels[1] = target
                    run = controller.run
                worker = threading.Thread(target=run, daemon=True)
                worker.start()
                try:
                    peer = relay.Frames(b.fileno(), b.fileno())
                    payload = os.urandom(180000)
                    for offset in range(0, len(payload), relay.MAX_FRAME):
                        peer.send(relay.DATA, 1, payload[offset:offset + relay.MAX_FRAME])
                    peer.send(relay.CLOSE, 1)
                    self.assertEqual(read_exact(receiver, len(payload)), payload)
                    self.assertEqual(receiver.recv(1), b'')
                finally:
                    controller.stop()
                    for connection in (a, b, target, receiver):
                        relay.close_socket(connection)
                    worker.join(2)

    def test_connect_carries_binary_payload_without_changing_it(self):
        with Harness() as harness:
            connection, response = harness.request()
            with connection:
                self.assertIn(b'200 Connection established', response)
                payload = os.urandom(150000) + b'\x00\r\nCONNECT other.example:443\r\n'
                connection.sendall(payload)
                self.assertEqual(read_exact(connection, len(payload)), payload)

    def test_simultaneous_connections_do_not_mix_audio_or_tls_bytes(self):
        with Harness() as harness:
            def request(index):
                connection, response = harness.request()
                with connection:
                    self.assertIn(b'200', response)
                    payload = bytes([index]) * (50000 + index)
                    connection.sendall(payload)
                    self.assertEqual(read_exact(connection, len(payload)), payload)
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                list(pool.map(request, range(6)))

    def test_arbitrary_destinations_are_rejected_without_connecting(self):
        with Harness() as harness:
            for destination in ('example.com:443', 'api.fish.audio:80',
                                'api.fish.audio.evil.example:443', '127.0.0.1:5432'):
                connection, response = harness.request(target=destination)
                connection.close()
                self.assertIn(b'403', response)
            self.assertEqual(harness.connections, 0)

    def test_mac_network_failure_returns_gateway_error(self):
        def failed():
            raise ConnectionRefusedError()
        with Harness(failed) as harness:
            connection, response = harness.request()
            connection.close()
            self.assertIn(b'502', response)

    def test_dropped_ssh_channel_marks_health_offline(self):
        with Harness() as harness:
            relay.close_socket(harness.b)
            self.assertTrue(harness.bridge.closed.wait(2))
            connection, response = harness.request(method='GET', target='/health')
            connection.close()
            self.assertIn(b'503', response)

    def test_oversized_or_unknown_frame_is_rejected(self):
        for kind, size in ((relay.DATA, relay.MAX_FRAME + 1), (255, 0)):
            a, b = socket.socketpair()
            with a, b:
                b.sendall(relay.HEADER.pack(kind, 1, size))
                with self.assertRaises(ValueError):
                    relay.Frames(a.fileno(), a.fileno()).receive()


if __name__ == '__main__':
    unittest.main()
