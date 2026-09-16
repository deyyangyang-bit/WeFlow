# Central 临时内网 TLS 层

本文件是 Windows 内网临时测试的最小操作说明。它只覆盖 Caddy 反向代理，不替换或重建现有
Central / PostgreSQL；现有 `central/.env`、数据库 secret、数据卷和业务数据继续由 Central
部署维护，不能复制给 Caddy。

## 交付内容

- `docker-compose.central.tls.yml`：在既有 `docker-compose.central.yml` 上增加 Caddy。
- `central/Caddyfile`：只监听 HTTPS 443，使用 Caddy 内部 CA，拒绝允许网段之外的直接 peer。
- `central/proxy.env.example`：当前临时测试值；实际文件名必须是 `central/proxy.env`，该文件不入 Git。
- `WeFlow-caddy-2.11.4-amd64.tar.gz`：Docker Hub 官方 `caddy:2.11.4-alpine` 的 linux/amd64 离线镜像。

## Windows 测试机操作

1. 先导入离线镜像：

   ```powershell
   docker load --input WeFlow-caddy-2.11.4-amd64.tar.gz
   ```

2. 在仓库根目录复制 `central/proxy.env.example` 为 `central/proxy.env`，仅填写本机内网 HTTPS
   绑定地址、测试域名和允许网段。当前测试值是 `192.168.1.57`、`weflow-central.test`、
   `192.168.1.0/24`；正式使用前必须改为 DHCP 保留地址、内部 DNS 名称和经过确认的办公网段。

3. 使用 `--env-file` 让 Compose 同时完成宿主端口插值和 Caddy 容器变量注入：

   ```powershell
   docker compose --env-file central/proxy.env -f docker-compose.central.yml -f docker-compose.central.tls.yml up --pull never -d
   docker compose --env-file central/proxy.env -f docker-compose.central.yml -f docker-compose.central.tls.yml ps
   ```

   预期只有宿主 `127.0.0.1:8787` 的 Central 诊断映射和 Caddy 的 HTTPS 443；不开放 HTTP 80、
   PostgreSQL 5432，也不把 8787 绑定到 LAN 地址。

4. Caddy 首次启动后只取出公开根证书 `/data/caddy/pki/authorities/local/root.crt`，安装到测试客户机的
   受信任根证书存储，并在客户机 hosts 中临时加入 `192.168.1.57 weflow-central.test`。根私钥留在
   Caddy 数据卷内，禁止导出、打包或交给客户端。客户端使用正常 TLS 校验，禁止 `--insecure`。

5. 用 `https://weflow-central.test/health` 与 `/ready` 验证，不以“容器启动”代替端点验证。Docker
   Desktop 若把 LAN peer NAT 成 Docker 网关，`remote_ip` 会安全地全部拒绝；不要未经确认就把
   `client_ip` 或任意 `X-Forwarded-For` 当作可信来源，应先完成 Windows 真机网络路径复验。

## 边界

本层仅用于当前临时内网测试。Windows 导入镜像、安装根证书、hosts、DHCP 保留、内部 DNS、时间同步、
Private 防火墙基线和 LAN 客户端真机复验均必须单独记录；未完成前不能称为正式上线。回退时只停止并移除
Caddy 服务及其临时代理配置，不删除现有 PostgreSQL 卷或 Central `.env` / secret。
