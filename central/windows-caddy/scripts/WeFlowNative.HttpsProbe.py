# -*- coding: utf-8 -*-
"""原生 Windows Caddy —— HTTPS 端点探测后端（Python 标准库，完整证书校验）。

用途：当 curl(schannel) 对内部 CA 无法判定吊销状态而不适用时，用本脚本作为等价后端。
本脚本只做「连接 + 完整链校验 + 主机名校验 + 一个 GET」，不做任何系统变更：
  - 不写文件、不改配置、不安装证书、不修改 DNS/hosts；
  - 信任锚只来自命令行给出的公开 root.crt（进程级，不落系统存储）；
  - ssl.create_default_context(cafile=...) + check_hostname=True + CERT_REQUIRED，
    即完整链 + 主机名校验，且没有跳过校验的开关。

**验证范围声明**：本后端验证的是「证书链能追到给定的 root.crt」与「主机名匹配」。
它**不主张**已完成吊销检查（OCSP/CRL）；也不代表 Windows Schannel 或 Electron 客户端
已经信任该证书——那两项必须另行验收。

HTTP 响应由标准库 http.client 解析：
  - 支持 Content-Length 与 chunked 传输编码（以及 Connection: close 的无长度响应）；
  - 响应体设大小上限（MAX_BODY_BYTES），超限即失败，不做无界读取；
  - TLS 版本与密码套件在连接关闭**之前**取得；
  - 手写分帧（旧版按 \\r\\n\\r\\n 切分）已删除：chunked 响应里的长度头会被当成响应体。

输出：单行 JSON，形如
  {"status": 200, "body": "...", "category": "transport-ok", "message": "HTTP 200",
   "tls_version": "TLSv1.3", "cipher": "TLS_AES_256_GCM_SHA384", "http_version": 11,
   "body_bytes": 61, "server_hostname": "weflow-central.test", "peer_ip": "192.168.1.57"}
category ∈ transport-ok / gate-403 / http-error / tls-failure / connection-failure / protocol-error
退出码：0 = 完成 HTTP 交互（含非 200）；2 = 参数错误；4 = TLS 校验失败；
        5 = 连接失败；6 = 响应协议错误（畸形 / 截断 / 超限）。

**机器输出编码契约**：本脚本的 stdout / stderr 一律为 **UTF-8**，由 configure_stdio()
显式设置，不依赖控制台代码页（Windows 控制台在中文环境下常为 CP936/GBK）。
调用方必须按 UTF-8 解码本脚本输出：PowerShell 侧通过
`Invoke-WeFlowExternalCommand -OutputEncoding <UTF-8>` 显式指定。两侧必须一致——
否则非 ASCII 内容会被解码破坏，实测中一个尾随的双字节序列会连同 JSON 字符串的
闭合引号一起被吞掉，导致 ConvertFrom-Json 失败。

用法：
  python WeFlowNative.HttpsProbe.py <bindIp> <hostname> <path> <cacert> [timeoutSec] [port]
"""

import hashlib
import http.client
import json
import re
import socket
import ssl
import sys

# 响应体大小上限：端点响应是固定契约的小 JSON，任何大响应都说明目标不对或链路异常。
MAX_BODY_BYTES = 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 15.0
MAX_TIMEOUT_SECONDS = 120.0
DEFAULT_PORT = 443

_IPV4_PATTERN = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')
_PATH_PATTERN = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$")


class ProbeError(Exception):
    """带分类的探测失败。category 与退出码的映射见模块文档。"""

    def __init__(self, category, message, exit_code):
        super().__init__(message)
        self.category = category
        self.exit_code = exit_code


class ResponseTooLarge(ProbeError):
    def __init__(self, limit):
        super().__init__(
            'protocol-error',
            '响应体超过大小上限 {0} 字节，拒绝继续读取'.format(limit),
            6,
        )


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """把连接固定到 bindIp，SNI 与 Host 头用 hostname，信任锚只用给定的 root.crt。

    连接地址、SNI 与 Host 三者分开设置是这里的全部意义：
    - 连接地址用 bindIp：验收的就是「本轮那台机器上的 443」；
    - SNI / Host 用 hostname：证书必须对该主机名有效，且 Caddy 按 Host 匹配站点；
    - 不写任何系统解析配置（不改 hosts/DNS/NRPT）。
    """

    def __init__(self, host, port, bind_ip, context, timeout):
        super().__init__(host, port, context=context, timeout=timeout)
        self._weflow_bind_ip = bind_ip
        self.weflow_tls_version = None
        self.weflow_cipher = None

    def connect(self):
        self.sock = socket.create_connection((self._weflow_bind_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)
        # TLS 信息必须在连接关闭之前取得：关闭后 SSLSocket.version() 返回 None。
        self.weflow_tls_version = self.sock.version()
        cipher = self.sock.cipher()
        self.weflow_cipher = cipher[0] if cipher else None


def parse_ipv4(text):
    """校验并返回点分十进制 IPv4 字面量；不是合法字面量则抛参数错误。"""
    if not _IPV4_PATTERN.match(text):
        raise ProbeError('connection-failure', '绑定地址不是点分十进制 IPv4：{0}'.format(text), 2)
    for octet in text.split('.'):
        if len(octet) > 1 and octet.startswith('0'):
            raise ProbeError('connection-failure', '绑定地址含前导零：{0}'.format(text), 2)
        if int(octet) > 255:
            raise ProbeError('connection-failure', '绑定地址段越界：{0}'.format(text), 2)
    return text


def parse_path(text):
    """校验请求目标：必须是绝对路径，且不含空白 / 控制字符。"""
    if not _PATH_PATTERN.match(text):
        raise ProbeError('connection-failure', '请求路径不合法（必须是绝对路径且不含空白或控制字符）：{0!r}'.format(text), 2)
    return text


def parse_timeout(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        raise ProbeError('connection-failure', '超时不是合法数字：{0!r}'.format(text), 2)
    if value <= 0 or value > MAX_TIMEOUT_SECONDS:
        raise ProbeError('connection-failure', '超时必须落在 (0, {0}] 秒内：{1}'.format(MAX_TIMEOUT_SECONDS, value), 2)
    return value


def parse_port(text):
    try:
        value = int(text)
    except (TypeError, ValueError):
        raise ProbeError('connection-failure', '端口不是合法整数：{0!r}'.format(text), 2)
    if value < 1 or value > 65535:
        raise ProbeError('connection-failure', '端口必须落在 1..65535：{0}'.format(value), 2)
    return value


def parse_hostname(text):
    if not text or len(text) > 253 or any(character.isspace() for character in text):
        raise ProbeError('connection-failure', '主机名不合法：{0!r}'.format(text), 2)
    return text


def build_context(ca_path):
    """构造只信任给定 root.crt 的 TLS 上下文（无跳过校验的开关）。"""
    try:
        context = ssl.create_default_context(cafile=ca_path)
    except Exception as exc:  # 证书文件不可用（缺失 / 非法 / 权限）
        raise ProbeError('tls-failure', '无法加载 CA 证书：{0}'.format(exc), 4)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def read_limited(response, max_bytes=MAX_BODY_BYTES):
    """按 http.client 的语义读取响应体，并强制大小上限与完整性。

    response.read(n) 由标准库负责 Content-Length / chunked 的分帧解码，
    这里补两件标准库**故意不做**的事：
      - 大小上限：多读一个字节来判断是否超限，避免无界读取；
      - 截断检测：http.client 在 Content-Length 未满足时只返回已读到的部分
        （保留兼容性，不抛异常），响应被截断必须当成失败，否则半个 JSON
        会流入契约判定。
    """
    try:
        body = response.read(max_bytes + 1)
    except http.client.IncompleteRead as exc:
        raise ProbeError('protocol-error', '响应被截断：声明长度与实际收到的不一致（{0}）'.format(exc), 6)
    if len(body) > max_bytes:
        raise ResponseTooLarge(max_bytes)
    remaining = getattr(response, 'length', None)
    if remaining:
        raise ProbeError(
            'protocol-error',
            '响应被截断：声明的 Content-Length 还有 {0} 字节没有收到'.format(remaining),
            6,
        )
    return body


def request_once(connection, path, max_bytes=MAX_BODY_BYTES):
    """在已建立的连接上发一次 GET 并解析响应（真实解析路径，测试直接调用本函数）。

    显式带 Connection: close：这样即使服务端既不给 Content-Length 也不给 chunked，
    响应也一定以 EOF 结束，不会把「读到连接超时」当成响应结束。
    """
    try:
        connection.request('GET', path, headers={'Connection': 'close'})
        response = connection.getresponse()
    except http.client.HTTPException as exc:
        raise ProbeError('protocol-error', 'HTTP 响应无法解析：{0}'.format(exc), 6)
    body = read_limited(response, max_bytes=max_bytes)
    http_version = response.version
    status = response.status
    response.close()
    return status, body, http_version


def classify(status, body_bytes, tls_version, cipher_name):
    """把一次成功的 HTTP 交互映射为分类与说明（不做契约判断，契约由 PowerShell 侧判定）。"""
    body_sha = hashlib.sha256(body_bytes).hexdigest()
    if status == 200:
        return 'transport-ok', 'HTTP 200（TLS {0}，{1}，body {2} 字节，sha256 {3}）'.format(
            tls_version or '未知', cipher_name or '未知', len(body_bytes), body_sha[:16]), 0
    if status == 403:
        return 'gate-403', 'HTTP 403 —— 来源门禁拒绝（证书链与主机名已通过，但端点未处理本次请求）', 0
    return 'http-error', 'HTTP {0}'.format(status), 0


def configure_stdio():
    """机器输出契约：stdout / stderr 一律 UTF-8，不依赖控制台代码页。

    调用方（PowerShell 包装层 Invoke-WeFlowExternalCommand）在调用本后端时显式按
    UTF-8 解码。两侧必须一致：Windows 控制台代码页在中文环境常为 CP936/GBK，
    若任一侧按代码页处理，含中文的 JSON 会被解码破坏——实测中一个尾随的双字节
    序列会连同字符串的闭合引号一起被吞掉，使 JSON 结构不合法、ConvertFrom-Json 失败。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', newline='\n')
        except Exception:
            pass


def emit(status, body, category, message, exit_code, extra=None):
    payload = {
        'status': status,
        'body': body if body is not None else '',
        'category': category,
        'message': message,
    }
    if extra:
        payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(exit_code)


def describe_error(exc):
    """把异常映射为 (category, exit_code)：TLS 校验失败与连接失败必须分开报告。"""
    if isinstance(exc, ProbeError):
        return exc.category, exc.exit_code, str(exc)
    if isinstance(exc, ssl.SSLCertVerificationError):
        return 'tls-failure', 4, '证书链或主机名校验失败：{0}'.format(exc)
    if isinstance(exc, ssl.SSLError):
        return 'tls-failure', 4, 'TLS 握手失败：{0}'.format(exc)
    if isinstance(exc, (http.client.HTTPException,)):
        return 'protocol-error', 6, 'HTTP 响应无法解析：{0}'.format(exc)
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return 'connection-failure', 5, '连接或读取超时：{0}'.format(exc)
    if isinstance(exc, OSError):
        return 'connection-failure', 5, '连接失败：{0}'.format(exc)
    return 'connection-failure', 5, '未预期的失败：{0}'.format(exc)


def run(argv):
    configure_stdio()
    if len(argv) < 5:
        emit(None, '', 'connection-failure',
             'usage: WeFlowNative.HttpsProbe.py <bindIp> <hostname> <path> <cacert> [timeoutSec] [port]', 2)

    bind_ip = parse_ipv4(argv[1])
    hostname = parse_hostname(argv[2])
    path = parse_path(argv[3])
    ca_path = argv[4]
    timeout = parse_timeout(argv[5]) if len(argv) > 5 else DEFAULT_TIMEOUT_SECONDS
    port = parse_port(argv[6]) if len(argv) > 6 else DEFAULT_PORT

    context = build_context(ca_path)
    connection = PinnedHTTPSConnection(hostname, port, bind_ip, context, timeout)
    try:
        status, body_bytes, http_version = request_once(connection, path)
    except BaseException as exc:  # noqa: BLE001 - 统一分类后再退出，绝不吞掉失败
        category, exit_code, message = describe_error(exc)
        emit(None, '', category, message, exit_code, {'peer_ip': bind_ip, 'server_hostname': hostname})
        return
    finally:
        try:
            connection.close()
        except Exception:
            pass

    body = body_bytes.decode('utf-8', 'replace')
    category, message, exit_code = classify(status, body_bytes, connection.weflow_tls_version, connection.weflow_cipher)
    emit(status, body, category, message, exit_code, {
        'tls_version': connection.weflow_tls_version,
        'cipher': connection.weflow_cipher,
        'http_version': http_version,
        'body_bytes': len(body_bytes),
        'server_hostname': hostname,
        'peer_ip': bind_ip,
    })


def main():
    run(sys.argv)


if __name__ == '__main__':
    main()
