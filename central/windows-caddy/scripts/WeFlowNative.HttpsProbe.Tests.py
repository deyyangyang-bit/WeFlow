# -*- coding: utf-8 -*-
"""WeFlowNative.HttpsProbe.py —— 真实后端的直接测试（只依赖标准库与 openssl 命令行）。

设计原则：
  - **直接调用被测实现**：所有解析用例都走 probe.request_once() 这条真实路径，
    由标准库 http.client 做分帧解码；不 mock「返回 JSON」来自证，也不复刻一份解析器。
  - 环形回环测试用真实 TLS 握手（openssl 生成一次性自签名证书），验证：
    连接固定到 bindIp、SNI 与 Host 用 hostname、CA 用显式 cafile、
    TLS 版本与密码套件在连接关闭前取得。
  - 只在 127.0.0.1 的临时端口上监听，不接触任何真实服务，不写系统配置。
  - openssl 不可用时，端到端用例记为 SKIP（不计入通过）。

用法：
  python3 WeFlowNative.HttpsProbe.Tests.py
退出码：0 = 无失败；1 = 存在失败；2 = 无法加载被测模块。
"""

import http.server
import io
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE_PATH = os.path.join(HERE, 'WeFlowNative.HttpsProbe.py')

sys.path.insert(0, HERE)
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location('weflow_https_probe', PROBE_PATH)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

PASSED = 0
FAILED = 0
SKIPPED = 0
FAILURES = []


def check(name, condition, detail=''):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print('  [PASS] {0}'.format(name))
    else:
        FAILED += 1
        FAILURES.append('{0} {1}'.format(name, detail))
        print('  [FAIL] {0} {1}'.format(name, detail))


def skip(name, reason):
    global SKIPPED
    SKIPPED += 1
    print('  [SKIP] {0}（{1}）'.format(name, reason))


class FakeSocket(object):
    """只提供 http.client 真正会用到的接口，喂入手工构造的响应字节流。"""

    def __init__(self, payload):
        self._file = io.BytesIO(payload)
        self.sent = b''

    def makefile(self, mode, *args, **kwargs):
        return self._file

    def sendall(self, data):
        self.sent += data

    def close(self):
        pass

    def settimeout(self, value):
        pass

    def gettimeout(self):
        return None


def make_canned_connection(payload, hostname='weflow-central.test', bind_ip='192.168.1.57', port=443):
    """真实连接对象 + 注入的字节流：request/getresponse/read 全部走真实实现。"""
    context = ssl.create_default_context()
    connection = probe.PinnedHTTPSConnection(hostname, port, bind_ip, context, 5.0)
    connection.sock = FakeSocket(payload)
    return connection


def expect_probe_error(connection, path, expected_category, max_bytes=None):
    try:
        if max_bytes is None:
            probe.request_once(connection, path)
        else:
            probe.request_once(connection, path, max_bytes=max_bytes)
    except probe.ProbeError as exc:
        return exc.category, str(exc)
    except Exception as exc:  # 非 ProbeError 说明分类逻辑漏了分支
        return 'unclassified:{0}'.format(type(exc).__name__), str(exc)
    return 'no-error', ''


def test_argument_validation():
    print('== 参数校验（不支持的输入必须明确拒绝） ==')
    for name, call in [
        ('非法 IPv4（三段）', lambda: probe.parse_ipv4('192.168.1')),
        ('非法 IPv4（越界段）', lambda: probe.parse_ipv4('192.168.1.256')),
        ('非法 IPv4（前导零）', lambda: probe.parse_ipv4('192.168.1.057')),
        ('非法 IPv4（主机名）', lambda: probe.parse_ipv4('desktop-cbg37qt')),
        ('路径含空格', lambda: probe.parse_path('/he alth')),
        ('路径非绝对', lambda: probe.parse_path('health')),
        ('超时为零', lambda: probe.parse_timeout('0')),
        ('超时为负', lambda: probe.parse_timeout('-1')),
        ('超时越界', lambda: probe.parse_timeout('9999')),
        ('超时非数字', lambda: probe.parse_timeout('soon')),
        ('端口为零', lambda: probe.parse_port('0')),
        ('端口越界', lambda: probe.parse_port('70000')),
        ('端口非数字', lambda: probe.parse_port('https')),
        ('主机名含空格', lambda: probe.parse_hostname('evil host')),
    ]:
        try:
            call()
            check(name, False, '（未被拒绝）')
        except probe.ProbeError as exc:
            check(name, exc.exit_code == 2, '（exit_code={0}）'.format(exc.exit_code))
    check('合法路径被接受', probe.parse_path('/health') == '/health')
    check('合法 IPv4 被接受', probe.parse_ipv4('192.168.1.57') == '192.168.1.57')
    check('缺省端口为 443', probe.DEFAULT_PORT == 443)


def test_ca_loading():
    print('== CA 加载（不允许绕过校验） ==')
    try:
        probe.build_context('/nonexistent/root.crt')
        check('不存在的 CA 文件被拒绝', False)
    except probe.ProbeError as exc:
        check('不存在的 CA 文件被拒绝', exc.category == 'tls-failure' and exc.exit_code == 4, str(exc))
    with tempfile.NamedTemporaryFile('w', suffix='.crt', delete=False) as handle:
        handle.write('not a certificate')
        bad_path = handle.name
    try:
        try:
            probe.build_context(bad_path)
            check('非法 CA 内容被拒绝', False)
        except probe.ProbeError as exc:
            check('非法 CA 内容被拒绝', exc.category == 'tls-failure', str(exc))
    finally:
        os.unlink(bad_path)


def test_parsing():
    print('== 响应解析（真实 http.client 路径） ==')
    body = b'{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'

    connection = make_canned_connection(
        b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() +
        b'\r\nContent-Type: application/json\r\n\r\n' + body)
    status, received, version = probe.request_once(connection, '/health')
    check('Content-Length 响应：状态码 200', status == 200, 'status={0}'.format(status))
    check('Content-Length 响应：响应体逐字节一致', received == body, repr(received[:60]))
    check('Content-Length 响应：HTTP 版本被记录', version in (10, 11), 'version={0}'.format(version))
    check('请求确实带上 Host 头', b'Host: weflow-central.test' in connection.sock.sent, repr(connection.sock.sent[:120]))
    check('请求显式带 Connection: close', b'Connection: close' in connection.sock.sent)

    chunked_body = b'{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
    chunked = b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
    for start in range(0, len(chunked_body), 11):
        piece = chunked_body[start:start + 11]
        chunked += '{0:x}\r\n'.format(len(piece)).encode() + piece + b'\r\n'
    chunked += b'0\r\n\r\n'
    connection = make_canned_connection(chunked)
    status, received, _ = probe.request_once(connection, '/health')
    check('chunked 响应：状态码 200', status == 200, 'status={0}'.format(status))
    check('chunked 响应：分块被正确还原（不含长度头）', received == chunked_body, repr(received))

    chunked_extension = (b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
                         b'5;ext=1\r\nhello\r\n0\r\n\r\n')
    connection = make_canned_connection(chunked_extension)
    status, received, _ = probe.request_once(connection, '/health')
    check('chunked 扩展参数被忽略且内容正确', status == 200 and received == b'hello', repr(received))

    eof_body = b'{"ok":true,"data":{"database":"ready"}}'
    connection = make_canned_connection(b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' + eof_body)
    status, received, _ = probe.request_once(connection, '/ready')
    check('无长度且以 EOF 结束的响应可读', status == 200 and received == eof_body, repr(received))

    truncated = b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{"ok":true}'
    connection = make_canned_connection(truncated)
    category, message = expect_probe_error(connection, '/health', 'protocol-error')
    check('截断响应（Content-Length 大于实际）稳定失败', category == 'protocol-error', '{0}: {1}'.format(category, message))

    connection = make_canned_connection(b'HTTP/1.1 ABC OK\r\n\r\n')
    category, message = expect_probe_error(connection, '/health', 'protocol-error')
    check('畸形状态行稳定失败', category == 'protocol-error', '{0}: {1}'.format(category, message))

    connection = make_canned_connection(b'GARBAGE\r\n\r\n')
    category, message = expect_probe_error(connection, '/health', 'protocol-error')
    check('非 HTTP 响应稳定失败', category == 'protocol-error', '{0}: {1}'.format(category, message))

    connection = make_canned_connection(b'')
    category, message = expect_probe_error(connection, '/health', 'protocol-error')
    check('空响应（连接立即关闭）稳定失败', category == 'protocol-error', '{0}: {1}'.format(category, message))

    big = b'HTTP/1.1 200 OK\r\nContent-Length: 2048\r\n\r\n' + (b'a' * 2048)
    connection = make_canned_connection(big)
    category, message = expect_probe_error(connection, '/health', 'protocol-error', max_bytes=1024)
    check('超过大小上限的响应被拒绝', category == 'protocol-error', '{0}: {1}'.format(category, message))

    boundary = b'HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n' + (b'a' * 1024)
    connection = make_canned_connection(boundary)
    status, received, _ = probe.request_once(connection, '/health', max_bytes=1024)
    check('正好等于上限的响应不被误判为超限', status == 200 and len(received) == 1024)

    connection = make_canned_connection(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nforbidden')
    status, received, _ = probe.request_once(connection, '/health')
    category, message, exit_code = probe.classify(status, received, 'TLSv1.3', 'TLS_AES_256_GCM_SHA384')
    check('403 被分类为来源门禁拒绝', category == 'gate-403', category)

    connection = make_canned_connection(b'HTTP/1.1 500 Server Error\r\nContent-Length: 4\r\n\r\nboom')
    status, received, _ = probe.request_once(connection, '/health')
    category, message, exit_code = probe.classify(status, received, 'TLSv1.3', 'TLS_AES_256_GCM_SHA384')
    check('500 被分类为 http-error', category == 'http-error', category)


def openssl_available():
    return shutil.which('openssl') is not None


def make_certificate(directory, name='localhost'):
    key_path = os.path.join(directory, '{0}.key'.format(name))
    cert_path = os.path.join(directory, '{0}.crt'.format(name))
    command = [
        shutil.which('openssl'), 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key_path, '-out', cert_path, '-days', '2',
        '-subj', '/CN={0}'.format(name),
        '-addext', 'subjectAltName=DNS:{0}'.format(name),
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        raise RuntimeError(result.stdout.decode('utf-8', 'replace'))
    return cert_path, key_path


class ChunkedHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args, **kwargs):
        pass

    def do_GET(self):
        payload = b'{"ok":true,"data":{"service":"weflow-central","protocolVersion":1}}'
        if self.path == '/chunked':
            self.send_response(200)
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            for start in range(0, len(payload), 16):
                piece = payload[start:start + 16]
                self.wfile.write('{0:x}\r\n'.format(len(piece)).encode() + piece + b'\r\n')
            self.wfile.write(b'0\r\n\r\n')
            return
        if self.path == '/forbidden':
            self.send_response(403)
            self.send_header('Content-Length', '9')
            self.end_headers()
            self.wfile.write(b'forbidden')
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class TlsServer(object):
    def __init__(self, cert_path, key_path):
        self.server = http.server.HTTPServer(('127.0.0.1', 0), ChunkedHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_path, key_path)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc_info):
        self.server.shutdown()
        self.server.server_close()


def test_end_to_end():
    print('== 真实 TLS 端到端（回环临时端口，一次性自签名证书） ==')
    if not openssl_available():
        skip('真实 TLS 端到端用例', '本机没有 openssl，无法生成一次性证书')
        return
    workdir = tempfile.mkdtemp(prefix='weflow-probe-tests-')
    try:
        cert_path, key_path = make_certificate(workdir, 'localhost')
        # 第二套自签名证书：用来证明「换一个 CA 就验不过」，即校验不是被跳过的。
        other_cert, _other_key = make_certificate(workdir, 'other.local')
        with TlsServer(cert_path, key_path) as server:
            context = probe.build_context(cert_path)
            connection = probe.PinnedHTTPSConnection('localhost', server.port, '127.0.0.1', context, 10.0)
            status, body, _ = probe.request_once(connection, '/health')
            tls_version = connection.weflow_tls_version
            cipher_name = connection.weflow_cipher
            check('真实 TLS：Content-Length 响应 200 且内容一致',
                  status == 200 and b'weflow-central' in body, 'status={0} body={1!r}'.format(status, body[:60]))
            check('TLS 信息在关闭连接前取得（版本非空）', bool(tls_version), 'tls_version={0!r}'.format(tls_version))
            check('TLS 信息在关闭连接前取得（密码套件非空）', bool(cipher_name), 'cipher={0!r}'.format(cipher_name))
            connection.close()
            connection = probe.PinnedHTTPSConnection('localhost', server.port, '127.0.0.1', context, 10.0)
            status, body, _ = probe.request_once(connection, '/chunked')
            check('真实 TLS：chunked 响应被正确还原',
                  status == 200 and body.endswith(b'}}') and b'\r\n' not in body, repr(body))
            connection.close()
            connection = probe.PinnedHTTPSConnection('localhost', server.port, '127.0.0.1', context, 10.0)
            status, body, _ = probe.request_once(connection, '/forbidden')
            category, _, exit_code = probe.classify(status, body, None, None)
            check('真实 TLS：403 分类为 gate-403', category == 'gate-403' and status == 403, category)
            connection.close()

            wrong_host = probe.PinnedHTTPSConnection('wrong.example', server.port, '127.0.0.1', context, 10.0)
            try:
                probe.request_once(wrong_host, '/health')
                check('主机名不匹配被拒绝', False, '（未失败）')
            except ssl.SSLCertVerificationError as exc:
                category, exit_code, message = probe.describe_error(exc)
                check('主机名不匹配被拒绝', category == 'tls-failure' and exit_code == 4, message)
            finally:
                wrong_host.close()

            wrong_ca = probe.build_context(other_cert)
            untrusted = probe.PinnedHTTPSConnection('localhost', server.port, '127.0.0.1', wrong_ca, 10.0)
            try:
                probe.request_once(untrusted, '/health')
                check('证书链不受信任被拒绝', False, '（未失败）')
            except ssl.SSLCertVerificationError as exc:
                category, exit_code, message = probe.describe_error(exc)
                check('证书链不受信任被拒绝', category == 'tls-failure' and exit_code == 4, message)
            finally:
                untrusted.close()

            unreachable = probe.PinnedHTTPSConnection('localhost', 1, '127.0.0.1', context, 2.0)
            try:
                probe.request_once(unreachable, '/health')
                check('连接失败被分类为 connection-failure', False, '（未失败）')
            except Exception as exc:
                category, exit_code, message = probe.describe_error(exc)
                check('连接失败被分类为 connection-failure', category == 'connection-failure' and exit_code == 5, message)
            finally:
                unreachable.close()

            test_cli(server, cert_path)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def test_cli(server, cert_path):
    print('== CLI 端到端（真实进程 + 真实 JSON 输出） ==')
    result = subprocess.run(
        [sys.executable, PROBE_PATH, '127.0.0.1', 'localhost', '/health', cert_path, '10', str(server.port)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    payload = None
    try:
        payload = json.loads(result.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
    except Exception:
        payload = None
    check('CLI 返回可解析的单行 JSON', payload is not None, result.stdout.decode('utf-8', 'replace')[:200])
    if payload is not None:
        check('CLI 分类为 transport-ok 且退出码 0',
              payload.get('category') == 'transport-ok' and result.returncode == 0,
              'category={0} exit={1}'.format(payload.get('category'), result.returncode))
        check('CLI 输出含 TLS 版本与 body 字节数',
              bool(payload.get('tls_version')) and payload.get('body_bytes', 0) > 0,
              json.dumps(payload, ensure_ascii=False)[:200])
        check('CLI 未把完整响应体之外的敏感信息写入 stderr', result.stderr == b'', result.stderr[:120])

    result = subprocess.run(
        [sys.executable, PROBE_PATH, '127.0.0.1', 'localhost', '/chunked', cert_path, '10', str(server.port)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    try:
        payload = json.loads(result.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
    except Exception:
        payload = None
    check('CLI 端到端 chunked 响应可用', payload is not None and payload.get('category') == 'transport-ok' and
          'weflow-central' in payload.get('body', ''), json.dumps(payload, ensure_ascii=False)[:200] if payload else 'no-json')

    result = subprocess.run(
        [sys.executable, PROBE_PATH, '127.0.0.1', 'localhost', '/forbidden', cert_path, '10', str(server.port)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    try:
        payload = json.loads(result.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
    except Exception:
        payload = None
    check('CLI 端到端 403 分类为 gate-403', payload is not None and payload.get('category') == 'gate-403',
          json.dumps(payload, ensure_ascii=False)[:200] if payload else 'no-json')

    result = subprocess.run(
        [sys.executable, PROBE_PATH, '127.0.0.1', 'wrong.example', '/health', cert_path, '10', str(server.port)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    try:
        payload = json.loads(result.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
    except Exception:
        payload = None
    check('CLI 端到端主机名不匹配 → tls-failure 且非零退出',
          payload is not None and payload.get('category') == 'tls-failure' and result.returncode == 4,
          'exit={0}'.format(result.returncode))


def main():
    print('WeFlowNative.HttpsProbe —— 真实后端测试')
    print('Python: {0}'.format(sys.version.split()[0]))
    test_argument_validation()
    test_ca_loading()
    test_parsing()
    test_end_to_end()
    print('')
    print('-' * 60)
    print('WeFlowNative.HttpsProbe.Tests: {0} passed, {1} failed, {2} skipped'.format(PASSED, FAILED, SKIPPED))
    if FAILURES:
        print('失败用例：')
        for item in FAILURES:
            print('  - {0}'.format(item))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
